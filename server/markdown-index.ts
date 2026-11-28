import type { FileHandle } from "node:fs/promises";
import type { RpcOutput } from "@getpaseo/plugin";
import { parseDocument, stringify } from "yaml";
import { markdownExtensions, markdownSearchPageSize, maxMarkdownTableLine, type Fence, type MarkdownSearchOptions,
  type TableContinuation, type readMarkdownInfo, type readMarkdownSource, type searchMarkdownFile } from "../shared/contracts";
import { markdownParser } from "../shared/markdown-math";
import { markdownReferences } from "../shared/markdown-references";
import { withWorkspaceFile } from "./workspace-file";
import { rebaseMarkdownDestination } from "./markdown-links";
import { searchExpression } from "./text-search";

const readBytes = 64 * 1024;
const checkpointLines = 128;
const maxSourceBytes = 96 * 1024;
const maxMetadataBytes = 32 * 1024;
type Info = RpcOutput<typeof readMarkdownInfo>;
type Source = RpcOutput<typeof readMarkdownSource>;
type Search = RpcOutput<typeof searchMarkdownFile>;
type Ending = Source["lines"][number]["ending"];
type BlockContext = { fence?: Fence; table?: TableContinuation };
type PreviewPosition = { offset: number; line: number } & BlockContext;
type MarkdownIndex = { info: Info; offsets: number[]; contexts: BlockContext[]; previewStart: PreviewPosition };
const indexes = new Map<string, Promise<MarkdownIndex>>();

async function* lines(file: FileHandle, size: number, start: number) {
  let parts: Buffer[] = [];
  let offset = start;
  let waitingForLineFeed = false;
  const finish = (nextOffset: number, ending: Ending) => {
    const decoded = Buffer.concat(parts).toString("utf8");
    const value = { offset, text: offset === 0 ? decoded.replace(/^\uFEFF/, "") : decoded, ending };
    parts = [];
    offset = nextOffset;
    return value;
  };
  for (let position = start; position < size;) {
    const buffer = Buffer.allocUnsafe(Math.min(readBytes, size - position));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) throw new Error("File ended while reading.");
    let fragmentStart = 0;
    if (waitingForLineFeed) {
      fragmentStart = Number(buffer[0] === 10);
      yield finish(position + fragmentStart, fragmentStart ? "\r\n" : "\r");
      waitingForLineFeed = false;
    }
    for (let cursor = fragmentStart; cursor < bytesRead; cursor++) {
      const byte = buffer[cursor];
      if (byte !== 10 && byte !== 13) continue;
      if (cursor > fragmentStart) parts.push(buffer.subarray(fragmentStart, cursor));
      if (byte === 13 && cursor + 1 === bytesRead) {
        waitingForLineFeed = true;
        fragmentStart = bytesRead;
        break;
      }
      const ending = byte === 10 ? "\n" : buffer[cursor + 1] === 10 ? "\r\n" : "\r";
      cursor += ending.length - 1;
      fragmentStart = cursor + 1;
      yield finish(position + fragmentStart, ending);
    }
    if (fragmentStart < bytesRead) parts.push(buffer.subarray(fragmentStart, bytesRead));
    position += bytesRead;
  }
  if (waitingForLineFeed) yield finish(size, "\r");
  yield finish(size, "");
}

function yamlRows(source: string): Info["frontMatter"] {
  try {
    const document = parseDocument(source, { schema: "core" });
    if (document.errors.length) return [];
    const data: unknown = document.toJS({ maxAliasCount: 100 });
    if (!data || typeof data !== "object" || Array.isArray(data)) return [];
    const scalar = (value: unknown) => value === null || ["string", "boolean", "number"].includes(typeof value);
    return Object.entries(data).slice(0, 200).map(([key, value]) => ({
      key,
      value: (scalar(value) ? String(value)
        : Array.isArray(value) && value.every(scalar) ? value.map(String).join(", ")
          : stringify(value).trim()).slice(0, 8192),
    }));
  } catch {
    return [];
  }
}

function headingTitle(source: string) {
  return (markdownParser.parseInline(source, {})[0]?.children ?? [])
    .map((token) => token.nesting === 0 ? token.content : "").join("").trim();
}

function blockContext(text: string, previous: string, { fence, table }: BlockContext): BlockContext {
  const marker = /^ {0,3}(`{3,256}|~{3,256})(.*)$/.exec(text);
  if (fence) {
    return marker && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()
      ? {} : { fence };
  }
  if (marker && (marker[1][0] === "~" || !marker[2].includes("`")) && marker[2].length <= 750) {
    return { fence: { marker: marker[1], opening: marker[1] + marker[2] } };
  }
  if (table && text.includes("|") && !/^ {0,3}(?:#{1,6} |>|[-*+] )/.test(text)) return { table };
  if (!previous || !text.includes("|") || !/^ {0,3}[|: -]+\|[|: -]*$/.test(text) ||
    text.length > maxMarkdownTableLine || previous.length > maxMarkdownTableLine) return {};
  return markdownParser.parse(`${previous}\n${text}`, {})[0]?.type === "table_open"
    ? { table: { header: previous, separator: text } } : {};
}

async function scanIndex(file: FileHandle, size: number, revision: string): Promise<MarkdownIndex> {
  const info: Info = { revision, lineCount: 0, headings: [], frontMatter: [], frontMatterEnd: 0, references: [] };
  const offsets: number[] = [];
  const usedAnchors = new Set<string>();
  const suffixes = new Map<string, number>();
  let frontMatter: { text: string[]; length: number } | undefined;
  let previous = "";
  let referenceBlock = "";
  let referenceBytes = 0;
  const contexts: BlockContext[] = [];
  let currentBlock: BlockContext = {};
  let previousLine = "";
  let previewStart = { offset: 0, line: 1 };
  let afterFrontMatter = false;
  const references = new Set<string>();
  const addReferences = () => {
    for (const entry of markdownReferences(referenceBlock)) {
      const identifier = entry.label.replace(/[\t\n\r ]+/g, " ").trim().toLowerCase().toUpperCase();
      const bytes = Buffer.byteLength(entry.label + entry.destination + (entry.title ?? ""));
      if (references.has(identifier) || referenceBytes + bytes > 256 * 1024) continue;
      references.add(identifier);
      referenceBytes += bytes;
      info.references.push(entry);
    }
    referenceBlock = "";
  };
  const addHeading = (label: string, level: number, line: number) => {
    if (info.headings.length >= 6000) return;
    const title = headingTitle(label.slice(0, 1024));
    if (!title) return;
    const base = title.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "").replaceAll(" ", "-");
    let suffix = suffixes.get(base) ?? 0;
    let anchor = suffix ? `${base}-${suffix}` : base;
    while (usedAnchors.has(anchor)) anchor = `${base}-${++suffix}`;
    suffixes.set(base, suffix + 1);
    usedAnchors.add(anchor);
    info.headings.push({ title, level, line, anchor });
  };
  const inspectLine = (text: string, line: number) => {
    const wasFenced = !!currentBlock.fence;
    currentBlock = blockContext(text, previousLine, currentBlock);
    previousLine = text;
    if (wasFenced || currentBlock.fence) {
      previous = "";
      if (referenceBlock) addReferences();
      return;
    }
    const heading = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/.exec(text);
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(text);
    const reference = /^ {0,3}(?:> ?)*\[[^\r\n]+?\]:/.test(text);
    if (reference || (referenceBlock && text.trim() && referenceBlock.length + text.length < maxMetadataBytes)) {
      if (referenceBlock.length + text.length >= maxMetadataBytes) addReferences();
      if (text.length < maxMetadataBytes) referenceBlock += text + "\n";
    } else if (referenceBlock) addReferences();
    if (heading) addHeading(heading[2].replace(/[ \t]+#+[ \t]*$/, ""), heading[1].length, line);
    else if (underline && previous) addHeading(previous, underline[1][0] === "=" ? 1 : 2, line - 1);
    previous = !heading && !underline && !reference && text.trim() && !/^ {4}|\t|[>#]|[-*+] |\d+[.)] /.test(text)
      ? text : "";
  };
  for await (const { offset, text } of lines(file, size, 0)) {
    const line = ++info.lineCount;
    if (afterFrontMatter) {
      previewStart = { offset, line };
      afterFrontMatter = false;
    }
    if ((line - 1) % checkpointLines === 0) {
      offsets.push(offset);
      contexts.push(currentBlock);
    }
    if (line === 1 && /^---[ \t]*$/.test(text)) {
      frontMatter = { text: [text], length: text.length };
      continue;
    }
    if (frontMatter) {
      const closing = /^(?:---|\.\.\.)[ \t]*$/.test(text);
      if (closing) {
        info.frontMatter = yamlRows(frontMatter.text.slice(1).join("\n"));
        if (info.frontMatter.length) {
          info.frontMatterEnd = line;
          frontMatter = undefined;
          previewStart = { offset: size, line: line + 1 };
          afterFrontMatter = true;
          continue;
        }
      } else if (frontMatter.length + text.length + 1 <= maxMetadataBytes) {
        frontMatter.length += text.length + 1;
        frontMatter.text.push(text);
        continue;
      }
      frontMatter.text.forEach((value, index) => inspectLine(value, index + 1));
      frontMatter = undefined;
    }
    inspectLine(text, line);
  }
  frontMatter?.text.forEach((value, index) => inspectLine(value, index + 1));
  if (referenceBlock) addReferences();
  return { info, offsets, contexts, previewStart };
}

function getIndex(path: string, file: FileHandle, size: number, revision: string) {
  const key = JSON.stringify([path, revision]);
  const cached = indexes.get(key);
  if (cached) return cached;
  const index = scanIndex(file, size, revision);
  indexes.set(key, index);
  void index.catch(() => { indexes.delete(key); });
  if (indexes.size > 8) {
    const oldest = indexes.keys().next().value;
    if (oldest) indexes.delete(oldest);
  }
  return index;
}

function checkpoint(index: MarkdownIndex, requested: number) {
  const line = Math.min(requested, index.info.lineCount);
  const bucket = Math.floor((line - 1) / checkpointLines);
  return { offset: index.offsets[bucket], first: bucket * checkpointLines + 1, line };
}

export function loadMarkdownInfo(root: string, path: string) {
  return withWorkspaceFile(root, path, markdownExtensions, async (file, size, revision, actual) => {
    const { info } = await getIndex(actual, file, size, revision);
    return { ...info, references: info.references.map((entry) => ({
      ...entry, destination: rebaseMarkdownDestination(entry.destination, root, path),
    })) };
  });
}

export async function markdownPreviewPosition(file: FileHandle, size: number, revision: string, actual: string, requested: number): Promise<PreviewPosition> {
  const index = await getIndex(actual, file, size, revision);
  if (requested <= index.previewStart.line) return index.previewStart;
  const { offset, first } = checkpoint(index, Math.max(index.previewStart.line, requested - 24));
  const target = Math.min(requested, index.info.lineCount);
  let block = index.contexts[Math.floor((first - 1) / checkpointLines)];
  let position: PreviewPosition = first < index.previewStart.line ? index.previewStart : { offset, line: first, ...block };
  let number = first - 1;
  let previous = "";
  for await (const entry of lines(file, size, offset)) {
    if (++number < index.previewStart.line) continue;
    if (!previous.trim() && !block.fence && !block.table && number > position.line) position = { offset: entry.offset, line: number };
    if (number >= target - 12 && number > position.line + 32 && (block.fence || (block.table && entry.text.includes("|")))) {
      position = { offset: entry.offset, line: number, ...block };
    }
    if (number >= target) break;
    block = blockContext(entry.text, previous, block);
    previous = entry.text;
  }
  return position;
}

export function loadMarkdownSource(root: string, path: string, requested: number, through?: number) {
  return withWorkspaceFile(root, path, markdownExtensions, async (file, size, revision, actual): Promise<Source> => {
    const index = await getIndex(actual, file, size, revision);
    const { offset, first, line } = checkpoint(index, requested);
    const limit = Math.min(index.info.lineCount, through ?? line + checkpointLines - 1, line + 255);
    const result: Source = { revision, firstLine: line, lines: [], nextLine: null };
    let bytes = 0;
    let lineNumber = first - 1;
    for await (const value of lines(file, size, offset)) {
      if (++lineNumber < line) continue;
      const remaining = maxSourceBytes - bytes;
      if (lineNumber > limit || (result.lines.length && Buffer.byteLength(value.text) > remaining)) break;
      const text = value.text.length <= remaining / 4 || Buffer.byteLength(value.text) <= remaining
        ? value.text : value.text.slice(0, Math.floor(remaining / 4));
      bytes += Buffer.byteLength(text) + value.ending.length;
      result.lines.push({ text, ending: value.ending, truncated: text.length < value.text.length });
    }
    const next = result.firstLine + result.lines.length;
    result.nextLine = next <= index.info.lineCount ? next : null;
    return result;
  });
}

export function findMarkdownLines(root: string, path: string, query: string, options: MarkdownSearchOptions, offset: number) {
  return withWorkspaceFile(root, path, markdownExtensions, async (file, size, revision): Promise<Search> => {
    const result: Search = { revision, hits: [], total: 0, invalidPattern: false };
    const expression = searchExpression(query, options);
    if (!expression) return { ...result, invalidPattern: true };
    let line = 0;
    for await (const { text } of lines(file, size, 0)) {
      line++;
      for (const match of text.matchAll(expression)) {
        if (result.total++ < offset || result.hits.length >= markdownSearchPageSize) continue;
        result.hits.push({ line, column: match.index, length: match[0].length });
      }
    }
    return result;
  });
}
