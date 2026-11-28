import { formulaImageUri, type FormulaImage } from "./contracts";
import { formulaKey, inlineFormula, lineOffsets, markdownParser, type FormulaSpan } from "./markdown-math";

export type ReadingBlock =
  | { kind: "markdown"; text: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "table"; rows: string[][]; alignment: (ColumnAlignment | undefined)[] }
  | { kind: "formula"; image?: FormulaImage; tex: string; source: string };

export type ColumnAlignment = "left" | "center" | "right";
export const inlineMathMarker = /\uE000omni(\d+)\uE001/g;
export const inlineMathReferenceFontSize = 16;
export interface InlineMath { image: FormulaImage; tex: string }

function appendText(blocks: ReadingBlock[], text: string) {
  if (text.trim()) blocks.push({ kind: "markdown", text });
}

function layoutBlocks(text: string, blocks: ReadingBlock[]) {
  if (!/(?:^|\n) {0,3}(?:`{3,}|~{3,})|\|/.test(text)) {
    appendText(blocks, text);
    return;
  }
  const offsets = lineOffsets(text);
  const tokens = markdownParser.parse(text, {});
  let cursor = 0;
  for (const [index, token] of tokens.entries()) {
    if (!token.map || token.level !== 0) continue;
    const start = offsets[token.map[0]];
    const end = offsets[token.map[1]];
    if (token.type === "table_open") {
      const rows: string[][] = [];
      const alignment: (ColumnAlignment | undefined)[] = [];
      for (const child of tokens.slice(index + 1)) {
        if (child.type === "table_close") break;
        if (child.type === "tr_open") rows.push([]);
        if (child.type === "th_open") {
          const style = child.attrGet("style");
          const position = typeof style === "string" ? style.slice("text-align:".length) : undefined;
          alignment.push(position === "left" || position === "center" || position === "right" ? position : undefined);
        }
        if (child.type === "inline") rows.at(-1)?.push(child.content);
      }
      appendText(blocks, text.slice(cursor, start));
      blocks.push({ kind: "table", rows, alignment });
      cursor = end;
    }
    if (token.type === "fence") {
      const language = token.info.trim().split(/\s+/, 1)[0];
      if (/^(?:math|mermaid|ui|app)$/i.test(language)) continue;
      appendText(blocks, text.slice(cursor, start));
      blocks.push({ kind: "code", language, text: token.content.replace(/\n$/, "") });
      cursor = end;
    }
  }
  appendText(blocks, text.slice(cursor));
}

export function readingBlocks(
  source: string, spans: FormulaSpan[], images: ReadonlyMap<string, FormulaImage | null>, includeSource = false,
  nativeMath?: InlineMath[], inlineScale = 1,
): ReadingBlock[] {
  const result: ReadingBlock[] = [];
  const softBreaks = spans.flatMap((span) => span.softBreaks ?? []);
  let breakIndex = 0;
  let cursor = 0;
  let parts: string[] = [];
  const appendSource = (end: number) => {
    let offset = cursor;
    while (breakIndex < softBreaks.length && softBreaks[breakIndex].end <= end) {
      const softBreak = softBreaks[breakIndex++];
      if (softBreak.start < offset) continue;
      parts.push(source.slice(offset, softBreak.start), " ");
      offset = softBreak.end;
    }
    parts.push(source.slice(offset, end));
    return offset === end && offset !== cursor;
  };
  for (const span of spans) {
    const candidate = images.get(formulaKey(span));
    const image = candidate?.uris.every((uri) => formulaImageUri.test(uri)) ? candidate : undefined;
    const joinedToPreviousLine = appendSource(span.start);
    const raw = source.slice(span.start, span.end);
    if (span.block) {
      layoutBlocks(parts.join(""), result);
      result.push({ kind: "formula", image, tex: span.tex, source: raw.trim() });
      parts = [];
    } else if (image) {
      const inlineImage = inlineScale === 1 ? image : {
        ...image,
        width: Math.max(1, Math.round(image.width * inlineScale)),
        height: Math.max(1, Math.round(image.height * inlineScale)),
        baseline: image.baseline === undefined ? undefined : image.baseline * inlineScale,
      };
      if (nativeMath) {
        const index = nativeMath.push({ image: inlineImage, tex: span.tex }) - 1;
        parts.push(`\uE000omni${index}\uE001`);
      } else {
        const lineStart = source.lastIndexOf("\n", span.start - 1) + 1;
        if (!joinedToPreviousLine && /^[ \t]*$/.test(source.slice(lineStart, span.start))) parts.push("\u2060");
        parts.push(inlineFormula(span, inlineImage, includeSource));
      }
    } else {
      parts.push(raw.replace(/[\\`*_~[\]<>|&]/g, "\\$&"));
    }
    cursor = span.end;
  }
  appendSource(source.length);
  layoutBlocks(parts.join(""), result);
  return result;
}
