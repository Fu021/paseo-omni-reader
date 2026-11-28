import { StringDecoder } from "node:string_decoder";
import type { Fence, TableContinuation } from "../shared/contracts";
import { markdownExtensions, maxFormulaLength, maxMarkdownTableLine } from "../shared/markdown-constants";
import { findFormulas, lineOffsets, markdownParser, possibleMath } from "../shared/markdown-math";
import { rebaseMarkdownLinks } from "./markdown-links";
import { markdownPreviewPosition } from "./markdown-index";
import { withWorkspaceFile } from "./workspace-file";

export const markdownPageBytes = 24 * 1024;
const mathLookaheadBytes = (maxFormulaLength + 16) * 4;

function afterLine(line: string, fence: Fence | undefined): Fence | undefined {
  const match = /^ {0,3}(`{3,256}|~{3,256})(.*)$/.exec(line);
  if (!match) return fence;
  const [, marker, tail] = match;
  if (fence) {
    return marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !tail.trim()
      ? undefined
      : fence;
  }
  if (tail.length > 750 || (marker[0] === "`" && tail.includes("`"))) return;
  return { marker, opening: marker + tail };
}

interface Boundary {
  end: number;
  fence?: Fence;
  table?: TableContinuation;
}

function chooseBoundary(text: string, initialFence: Fence | undefined): Boundary {
  let fence = initialFence;
  let lastLine = { end: 0, fence };
  let paragraph = lastLine;
  let display: string | undefined;
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r(?!$)|\n)/g)) {
    const line = match[0].replace(/[\r\n]+$/, "");
    const end = match.index + match[0].length;
    if (!display) fence = afterLine(line, fence);
    if (!fence) {
      const delimiter = line.trim();
      if (delimiter === "$$") display = display === "$$" ? undefined : display ?? "$$";
      if (delimiter === "\\[" && !display) display = "\\]";
      if (delimiter === "\\]" && display === "\\]") display = undefined;
    }
    lastLine = { end, fence };
    if (!fence && !display && !line.trim()) paragraph = lastLine;
  }
  if (paragraph.end >= text.length / 2) return paragraph;
  if (lastLine.end >= text.length / 2) return lastLine;
  return { end: text.length, fence };
}

function keepFormulasTogether(text: string, prefix: string, boundary: Boundary): Boundary {
  const source = prefix + text;
  if (!possibleMath.test(source)) return boundary;
  const end = prefix.length + boundary.end;
  const crossing = findFormulas(source).find((span) => span.start < end && end < span.end);
  if (!crossing) return boundary;
  const before = text.slice(0, Math.max(0, crossing.start - prefix.length));
  const lineStart = Math.max(before.lastIndexOf("\n"), before.lastIndexOf("\r")) + 1;
  if (lineStart >= boundary.end / 2) return { end: lineStart, fence: undefined };
  const formulaEnd = crossing.end - prefix.length;
  if (crossing.block) return { end: formulaEnd, fence: undefined };
  const restOfLine = /^[^\r\n]*(?:\r\n|\r|\n)/.exec(text.slice(formulaEnd));
  return { end: restOfLine ? formulaEnd + restOfLine[0].length : text.length, fence: undefined };
}

function continueTable(text: string, prefix: string, boundary: Boundary): Boundary {
  const source = prefix + text;
  if (boundary.fence || !/^[ \t]*\|?[ \t]*:?-+:?[ \t]*\|/m.test(source)) return boundary;
  const offsets = lineOffsets(source);
  const end = prefix.length + boundary.end;
  const table = markdownParser.parse(source, {}).find((token) =>
    token.type === "table_open" && token.level === 0 && token.map &&
    offsets[token.map[0]] < end && end < offsets[token.map[1]]);
  if (!table?.map) return boundary;
  const [first, last] = table.map;
  const headEnd = offsets[first + 2];
  const header = source.slice(offsets[first], offsets[first + 1]).trimEnd();
  const separator = source.slice(offsets[first + 1], headEnd).trimEnd();
  if (header.length > maxMarkdownTableLine || separator.length > maxMarkdownTableLine) return boundary;

  let next = last;
  while (next > first + 2 && offsets[next] > end) next--;
  const split = Math.max(headEnd, offsets[next]);
  if (split <= prefix.length) return boundary;
  return { end: split - prefix.length, table: { header, separator } };
}

export async function loadMarkdownPage(
  root: string, path: string, offset: number, revision?: string, fence?: Fence, table?: TableContinuation,
  firstLine = 1, atLine?: number,
) {
  return withWorkspaceFile(root, path, markdownExtensions, async (file, size, stamp, actual) => {
    if ((revision && stamp !== revision) || offset > size) throw new Error("File changed. Reload to read the new version.");
    if (atLine !== undefined) {
      const position = await markdownPreviewPosition(file, size, stamp, actual, atLine);
      offset = position.offset;
      firstLine = position.line;
      fence = position.fence;
      table = position.table;
    }
    const pageBytes = Math.min(markdownPageBytes, size - offset);
    const bytes = Buffer.alloc(Math.min(pageBytes + mathLookaheadBytes, size - offset));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, offset + length);
      if (!bytesRead) throw new Error("File ended while reading.");
      length += bytesRead;
    }
    const eof = offset + pageBytes === size;
    const prefix = fence ? `${fence.opening}\n` : table ? `${table.header}\n${table.separator}\n` : "";
    const decoder = new StringDecoder("utf8");
    const text = offset + length === size ? decoder.end(bytes) : decoder.write(bytes);
    const current = eof ? text : new StringDecoder("utf8").write(bytes.subarray(0, pageBytes));
    const boundary = eof ? { end: text.length }
      : continueTable(text, prefix, keepFormulasTogether(text, prefix, chooseBoundary(current, fence)));
    const kept = text.slice(0, boundary.end);
    const encoded = Buffer.from(kept);
    if (!bytes.subarray(0, encoded.length).equals(encoded)) throw new Error("Reader supports UTF-8 text files.");
    const source = offset === 0 ? kept.replace(/^\uFEFF/, "") : kept;
    const suffix = boundary.fence ? `\n${boundary.fence.marker}\n` : "";
    const nextOffset = offset + encoded.length < size ? offset + encoded.length : null;
    return {
      source, markdown: rebaseMarkdownLinks(prefix + source + suffix, root, path),
      nextOffset, offset, revision: stamp, fence: boundary.fence, table: boundary.table,
      firstLine, nextLine: firstLine + (source.match(/\r\n|\r|\n/g)?.length ?? 0),
      prefixLines: fence ? 1 : table ? 2 : 0,
    };
  });
}
