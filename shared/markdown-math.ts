import MarkdownIt from "markdown-it";
import { maxFormulaLength, type Formula, type FormulaImage } from "./contracts";

export const markdownParser = new MarkdownIt({ html: true });
export const possibleMath = /[$]|\\[([]|(?:`{3,}|~{3,})[ \t]*math\b/i;

export interface FormulaSpan extends Formula {
  start: number;
  end: number;
  block: boolean;
}

interface OpaqueBlock {
  start: number;
  end: number;
  formula?: FormulaSpan;
}

export function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (const newline of source.matchAll(/\r\n|\r|\n/g)) {
    offsets.push(newline.index + newline[0].length);
  }
  offsets.push(source.length);
  return offsets;
}

function opaqueBlocks(source: string): OpaqueBlock[] {
  const offsets = lineOffsets(source);
  return markdownParser.parse(source, {}).flatMap((token) => {
    if (!token.map || !["fence", "code_block", "html_block"].includes(token.type)) return [];
    const start = offsets[token.map[0]];
    const end = offsets[token.map[1]];
    const tex = token.content.trim();
    if (
      token.type === "fence" &&
      token.info.trim().toLowerCase() === "math" &&
      /^\s*(?:`{3,}|~{3,})\s*math\b/i.test(source.slice(start, end)) &&
      /(?:^|\n)[ \t]*(?:`{3,}|~{3,})[ \t]*(?:\r?\n)?$/.test(source.slice(start, end)) &&
      tex.length > 0 && tex.length <= maxFormulaLength
    ) {
      return [{ start, end, formula: { start, end, tex, display: true, block: true } }];
    }
    return [{ start, end }];
  });
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

function readFormula(source: string, start: number, limit: number): FormulaSpan | undefined {
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
      const block = display &&
        /^[ \t]*$/.test(source.slice(lineStart, start)) &&
        /^[ \t\r]*$/.test(source.slice(end, nextLine < 0 ? source.length : nextLine));
      return { start, end, tex, display, block };
    }
    if (source[index] === "\\") index++;
  }
}

export function findFormulas(source: string): FormulaSpan[] {
  if (!possibleMath.test(source)) return [];
  const blocks = opaqueBlocks(source);
  const formulas: FormulaSpan[] = [];
  let blockIndex = 0;
  for (let index = 0; index < source.length;) {
    const block = blocks[blockIndex];
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
      const formula = readFormula(source, index, limit);
      if (formula) {
        formulas.push(formula);
        index = formula.end;
        continue;
      }
      if (source.startsWith("$$", index)) { index += 2; continue; }
    }
    index += character === "\\" ? 2 : 1;
  }
  return formulas;
}

export function formulaKey({ tex, display }: Formula): string {
  return `${display ? "display" : "inline"}:${tex}`;
}

export function inlineFormula(span: FormulaSpan, image: FormulaImage): string {
  const alt = span.tex.replace(/[\r\n\t]+/g, " ")
    .replace(/[\\[\]`*_<>$]/g, "\\$&").replaceAll("|", "&#124;");
  return image.uris.map((uri, index) => `![${index ? "" : alt}](${uri})`).join("\u2060");
}
