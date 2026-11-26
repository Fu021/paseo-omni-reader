import type { FormulaImage } from "./contracts";
import { formulaKey, inlineFormula, lineOffsets, markdownParser, type FormulaSpan } from "./markdown-math";

export type ReadingBlock =
  | { kind: "markdown"; text: string }
  | { kind: "code"; text: string; language: string }
  | { kind: "table"; rows: string[][] }
  | { kind: "formula"; image: FormulaImage; tex: string };

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
      for (const child of tokens.slice(index + 1)) {
        if (child.type === "table_close") break;
        if (child.type === "tr_open") rows.push([]);
        if (child.type === "inline") rows.at(-1)?.push(child.content);
      }
      appendText(blocks, text.slice(cursor, start));
      blocks.push({ kind: "table", rows });
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
  source: string, spans: FormulaSpan[], images: ReadonlyMap<string, FormulaImage | null>,
): ReadingBlock[] {
  const result: ReadingBlock[] = [];
  let cursor = 0;
  let parts: string[] = [];
  for (const span of spans) {
    const image = images.get(formulaKey(span));
    if (!image?.uris.every((uri) => uri.startsWith("data:image/png;base64,"))) continue;
    parts.push(source.slice(cursor, span.start));
    if (span.block) {
      layoutBlocks(parts.join(""), result);
      result.push({ kind: "formula", image, tex: span.tex });
      parts = [];
    } else {
      const lineStart = source.lastIndexOf("\n", span.start - 1) + 1;
      if (/^[ \t]*$/.test(source.slice(lineStart, span.start))) parts.push("\u2060");
      parts.push(inlineFormula(span, image));
    }
    cursor = span.end;
  }
  parts.push(source.slice(cursor));
  layoutBlocks(parts.join(""), result);
  return result;
}
