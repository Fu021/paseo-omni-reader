import MarkdownIt from "markdown-it";
import type { Formula, FormulaImage } from "./contracts";
import { maxFormulaLength } from "./markdown-constants";

export const markdownParser = new MarkdownIt({ html: true });
export const possibleMath = /[$]|\\[([]|(?:`{3,}|~{3,})[ \t]*math\b/i;
export const formulaTitlePrefix = "omni-latex:";
export const formulaTitlePattern = /^omni-latex:(\d+):(\d+):(-?\d+):(.+)$/;

interface SourceRange {
  start: number;
  end: number;
}

export interface FormulaSpan extends Formula, SourceRange {
  block: boolean;
  softBreaks?: SourceRange[];
}

interface OpaqueBlock extends SourceRange {
  formula?: FormulaSpan;
}

interface MultilineParagraph {
  firstLine: number;
  endLine: number;
  lines: string[];
}

interface MarkdownStructure {
  offsets: number[];
  opaqueBlocks: OpaqueBlock[];
  standaloneParagraphs: Set<string>;
  multilineParagraphs: MultilineParagraph[];
}

function sourceRangeKey(start: number, end: number) {
  return `${start}:${end}`;
}

export function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (const newline of source.matchAll(/\r\n|\r|\n/g)) {
    offsets.push(newline.index + newline[0].length);
  }
  offsets.push(source.length);
  return offsets;
}

function markdownStructure(source: string): MarkdownStructure {
  const offsets = lineOffsets(source);
  const tokens = markdownParser.parse(source, {});
  const opaqueBlocks: OpaqueBlock[] = [];
  const standaloneParagraphs = new Set<string>();
  const multilineParagraphs: MultilineParagraph[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type === "inline" && token.map && tokens[index - 1]?.type === "paragraph_open") {
      const [firstLine, endLine] = token.map;
      if (endLine - firstLine > 1) {
        multilineParagraphs.push({ firstLine, endLine, lines: token.content.split("\n") });
      } else {
        let start = offsets[firstLine];
        let end = offsets[endLine];
        while (start < end && /\s/.test(source[start])) start++;
        while (end > start && /\s/.test(source[end - 1])) end--;
        if (start < end) standaloneParagraphs.add(sourceRangeKey(start, end));
      }
    }
    if (!token.map || !["fence", "code_block", "html_block"].includes(token.type)) continue;
    const start = offsets[token.map[0]];
    const end = offsets[token.map[1]];
    if (
      token.type === "fence" &&
      token.info.trim().toLowerCase() === "math" &&
      token.map[1] - token.map[0] >= 3 &&
      /^\s*(?:`{3,}|~{3,})\s*math\b/i.test(source.slice(start, offsets[token.map[0] + 1]))
    ) {
      const closingLine = source.slice(offsets[token.map[1] - 1], end).replace(/(?:\r\n|\r|\n)$/, "");
      const marker = /^ {0,3}(`+|~+)[ \t]*$/.exec(closingLine)?.[1];
      const tex = token.content.trim();
      if (marker?.startsWith(token.markup) && tex.length > 0 && tex.length <= maxFormulaLength) {
        opaqueBlocks.push({ start, end, formula: { start, end, tex, display: true, block: true } });
        continue;
      }
    }
    opaqueBlocks.push({ start, end });
  }
  return { offsets, opaqueBlocks, standaloneParagraphs, multilineParagraphs };
}

function softBreakAt(
  source: string, offsets: number[], paragraph: MultilineParagraph, nextLine: number,
): SourceRange | undefined {
  if (nextLine <= paragraph.firstLine || nextLine >= paragraph.endLine) return;
  const previousStart = offsets[nextLine - 1];
  const nextStart = offsets[nextLine];
  const previous = source.slice(previousStart, nextStart).replace(/(?:\r\n|\r|\n)$/, "");
  const trailingSlashes = /\\+$/.exec(previous)?.[0].length ?? 0;
  if (previous.endsWith("  ") || trailingSlashes % 2 === 1) return;

  const next = source.slice(nextStart, offsets[nextLine + 1]).trimEnd();
  const body = paragraph.lines[nextLine - paragraph.firstLine]?.trim();
  if (!body || !next.endsWith(body)) return;
  const prefix = next.slice(0, next.length - body.length);
  if (!/^[ \t]*(?:>[ \t]*)*$/.test(prefix)) return;
  return { start: previousStart + previous.trimEnd().length, end: nextStart + prefix.length };
}

function findFormulaSoftBreaks(source: string, formulas: FormulaSpan[], structure: MarkdownStructure) {
  const { offsets, multilineParagraphs } = structure;
  let paragraphIndex = 0;
  let line = 0;
  for (const formula of formulas) {
    if (formula.display) continue;
    while (offsets[line + 1] <= formula.start) line++;
    while (multilineParagraphs[paragraphIndex]?.endLine <= line) paragraphIndex++;
    const paragraph = multilineParagraphs[paragraphIndex];
    if (!paragraph || line < paragraph.firstLine) continue;
    const content = paragraph.lines[line - paragraph.firstLine]?.trim();
    const raw = source.slice(formula.start, formula.end);
    if (content !== raw && content !== `${raw}\\`) continue;
    const before = softBreakAt(source, offsets, paragraph, line);
    const after = softBreakAt(source, offsets, paragraph, line + 1);
    const breaks = [before, after].filter((range) => range !== undefined);
    if (breaks.length) formula.softBreaks = breaks;
  }
}

function skipCodeSpan(source: string, start: number, limit: number): number {
  let openEnd = start;
  while (source[openEnd] === "`") openEnd++;
  const runs = /`+/g;
  runs.lastIndex = openEnd;
  for (let match = runs.exec(source); match && match.index < limit; match = runs.exec(source)) {
    if (match[0].length === openEnd - start) return runs.lastIndex;
    if (runs.lastIndex - start > maxFormulaLength * 4) break;
  }
  return openEnd;
}

function skipLinkDestination(source: string, start: number, limit: number): number {
  const close = source[start] === "(" ? ")" : "]";
  let depth = 1;
  let angle = false;
  let title = "";
  for (let index = start + 1; index < Math.min(limit, start + 8192); index++) {
    const character = source[index];
    if (character === "\r" || character === "\n") break;
    if (character === "\\") { index++; continue; }
    if (close === ")") {
      if (title) {
        if (character === title) title = "";
        continue;
      }
      if (character === "<" && index === start + 1) angle = true;
      if (character === ">" && angle) { angle = false; continue; }
      if (angle) continue;
      if (depth === 1 && (character === '"' || character === "'") && /\s/.test(source[index - 1])) {
        title = character;
        continue;
      }
      if (character === "(") depth++;
    }
    if (character === close && --depth === 0) return index + 1;
  }
  return start;
}

function readFormula(
  source: string, start: number, limit: number, standaloneParagraphs: ReadonlySet<string>,
): FormulaSpan | undefined {
  const open = source.startsWith("$$", start) ? "$$" : source.slice(start, start + 2);
  const close = open === "\\(" ? "\\)" : open === "\\[" ? "\\]" : open === "$$" ? "$$" : "$";
  const display = close === "\\]" || close === "$$";
  const from = start + (close === "$" ? 1 : 2);
  if (close === "$" && (!source[from] || /\s/.test(source[from]))) return;
  const endLimit = Math.min(limit, from + maxFormulaLength + close.length);
  for (let index = from; index < endLimit; index++) {
    if (!display && (source[index] === "\n" || source[index] === "\r")) return;
    if (close === "$" && source[index] === "`") return;
    if (source.startsWith(close, index)) {
      if (close === "$" && (source[index + 1] === "$" || source[index - 1] === "$")) continue;
      if (close === "$" && (/\s/.test(source[index - 1]) || /[0-9]/.test(source[index + 1] ?? ""))) return;
      const tex = source.slice(from, index).trim();
      if (!tex) return;
      const end = index + close.length;
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const nextLine = source.indexOf("\n", end);
      const isolatedLine = /^[ \t]*$/.test(source.slice(lineStart, start)) &&
        /^[ \t\r]*$/.test(source.slice(end, nextLine < 0 ? source.length : nextLine));
      const block = display ? isolatedLine : standaloneParagraphs.has(sourceRangeKey(start, end));
      return { start, end, tex, display: display || block, block };
    }
    if (source[index] === "\\") index++;
  }
}

export function findFormulas(source: string): FormulaSpan[] {
  if (!possibleMath.test(source)) return [];
  const structure = markdownStructure(source);
  const { opaqueBlocks, standaloneParagraphs } = structure;
  const formulas: FormulaSpan[] = [];
  let blockIndex = 0;
  for (let index = 0; index < source.length;) {
    const block = opaqueBlocks[blockIndex];
    if (block && index >= block.start) {
      if (block.formula) formulas.push(block.formula);
      index = Math.max(index, block.end);
      blockIndex++;
      continue;
    }
    const limit = block?.start ?? source.length;
    const character = source[index];
    if (character === "`") {
      index = skipCodeSpan(source, index, limit);
      continue;
    }
    if (character === "]" && (source[index + 1] === "(" || source[index + 1] === "[")) {
      index = skipLinkDestination(source, index + 1, limit);
      continue;
    }
    if (character === "<") {
      const close = source.indexOf(">", index + 1);
      if (close >= 0 && close < limit && /^(?:\/?[a-z][\w-]*(?:\s|$)|[a-z][\w+.-]*:)/i.test(source.slice(index + 1, close))) {
        index = close + 1;
        continue;
      }
    }
    if (character === "[" && (index === 0 || source[index - 1] === "\n")) {
      const newline = source.indexOf("\n", index);
      const end = newline < 0 ? source.length : newline;
      if (/^\[[^\]]+\]:[ \t]+/.test(source.slice(index, end))) { index = end; continue; }
    }
    if (character === "$" || (character === "\\" && /[([]/.test(source[index + 1] ?? ""))) {
      const formula = readFormula(source, index, limit, standaloneParagraphs);
      if (formula) {
        formulas.push(formula);
        index = formula.end;
        continue;
      }
      if (source.startsWith("$$", index)) { index += 2; continue; }
    }
    index += character === "\\" ? 2 : 1;
  }
  findFormulaSoftBreaks(source, formulas, structure);
  return formulas;
}

export function formulaKey({ tex, display }: Formula): string {
  return `${display ? "display" : "inline"}:${tex}`;
}

export function inlineFormula(span: FormulaSpan, image: FormulaImage, includeSource: boolean): string {
  const tex = span.tex.replace(/[\r\n\t]+/g, " ");
  const alt = tex.replace(/[\\[\]`*_<>$]/g, "\\$&").replaceAll("|", "&#124;");
  const depth = Math.round(image.height - (image.baseline ?? image.height * 0.8));
  const title = includeSource
    ? ` "${formulaTitlePrefix}${image.width}:${image.height}:${depth}:${encodeURIComponent(span.tex)}"` : "";
  return image.uris.map((uri, index) => `![${index ? "" : alt}](${uri}${title})`).join("\u2060");
}
