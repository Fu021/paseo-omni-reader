import type { Element } from "@xmldom/xmldom";
import type { MarkdownSearchOptions, Worksheet, WorksheetMatch } from "../shared/contracts";
import { children, descendants, loadOffice, officeFileLimit, plainText, relatedParts } from "./office-xml";
import { searchExpression } from "./text-search";
import { withWorkspaceFile } from "./workspace-file";

const workbookParts = /^xl\/(?:workbook\.xml|styles\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels)$/;
const worksheetPart = /^xl\/worksheets\/[^/]+\.xml$/;
const maxRows = 8_192;
const maxColumns = 256;
const maxCells = 80_000;
const maxText = 400_000;
const maxMerges = 4_096;
const maxAutoWidth = 420;
type CellStyle = Worksheet["styles"][number] & { format?: number };

function position(reference: string) {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(reference);
  if (!match) return undefined;
  const column = [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0);
  return [Number(match[2]) - 1, column - 1] as const;
}

function color(node: Element | undefined) {
  const rgb = node?.getAttribute("rgb");
  return rgb && /^(?:[0-9a-f]{2})?[0-9a-f]{6}$/i.test(rgb) ? `#${rgb.slice(-6)}` : undefined;
}

function styles(part: Element | null | undefined): CellStyle[] {
  const group = (name: string, child: string) => {
    const list = part && children(part, [name])[0];
    return list ? children(list, [child]) : [];
  };
  const fonts = group("fonts", "font");
  const fills = group("fills", "fill");
  return group("cellXfs", "xf").slice(0, 4_096).map((style) => {
    const font = fonts[Number(style.getAttribute("fontId"))];
    const fill = fills[Number(style.getAttribute("fillId"))];
    const alignment = children(style, ["alignment"])[0];
    const horizontal = alignment?.getAttribute("horizontal");
    const fontSize = font && Number(children(font, ["sz"])[0]?.getAttribute("val"));
    const hasFontFlag = (name: string) => {
      const flag = font && children(font, [name])[0];
      return flag !== undefined && !["0", "false"].includes(flag.getAttribute("val") ?? "");
    };
    const pattern = fill && children(fill, ["patternFill"])[0];
    return {
      bold: hasFontFlag("b"), italic: hasFontFlag("i"),
      color: color(font && children(font, ["color"])[0]),
      fill: color(pattern?.getAttribute("patternType") === "solid" ? children(pattern, ["fgColor"])[0] : undefined),
      fontSize: fontSize > 0 && fontSize <= 72 ? fontSize * 4 / 3 : undefined,
      align: horizontal === "left" || horizontal === "center" || horizontal === "right" ? horizontal : undefined,
      wrap: alignment?.getAttribute("wrapText") === "1",
      format: Number(style.getAttribute("numFmtId")),
    };
  });
}

function formattedNumber(value: string, format?: number) {
  const number = Number(value);
  if (!value || !Number.isFinite(number)) return value;
  switch (format) {
    case 1: return number.toFixed(0);
    case 2: return number.toFixed(2);
    case 3: case 4: {
      const digits = format === 3 ? 0 : 2;
      return number.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }
    case 9: case 10: return `${(100 * number).toFixed(format === 9 ? 0 : 2)}%`;
    case 11: return number.toExponential(2);
    default: return value;
  }
}

function textWidth(text: string, fontSize: number) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (character === "\t") width += 1.5;
    else if (character === " " || "ilI.,:;!|'`".includes(character)) width += 0.34;
    else if (code >= 0x2e80) width += code >= 0x1f000 ? 1.25 : 1;
    else if ("WMwm@%&".includes(character)) width += 0.9;
    else width += 0.65;
  }
  return width * fontSize;
}

function lineCount(text: string, fontSize: number, width: number) {
  let lines = 0;
  for (const paragraph of text.split("\n")) {
    let available = width;
    lines++;
    for (const token of paragraph.match(/[^\S\n]+|[\u2e80-\uffff]|[^\s\u2e80-\uffff]+/gu) ?? []) {
      const size = textWidth(token, fontSize);
      if (size > available) {
        if (available < width) lines++;
        available = width;
        if (!token.trim()) continue;
        const extra = Math.max(0, Math.ceil(size / width) - 1);
        lines += extra;
        available -= size - extra * width;
      } else {
        available -= size;
      }
    }
  }
  return lines;
}

function fitCellContents({ cells, styles, merges, columns, rows }: Worksheet) {
  const columnCount = columns.length;
  const merged = new Map(merges.map((merge) => [merge[0] * columnCount + merge[1], merge]));
  for (const [row, column, value, styleId] of cells) {
    const style = styles[styleId];
    if (!value || !rows[row] || !columns[column] || style?.wrap || merged.has(row * columnCount + column)) continue;
    const fontSize = (style?.fontSize ?? 14) * (style?.bold ? 1.08 : 1);
    const measured = value.split("\n").reduce((widest, line) => Math.max(widest, textWidth(line, fontSize)), 0);
    columns[column] = Math.max(columns[column], Math.min(maxAutoWidth, Math.ceil(measured + 16)));
  }
  for (const [row, column, value, styleId] of cells) {
    if (!value || !rows[row] || !columns[column]) continue;
    const merge = merged.get(row * columnCount + column);
    const lastRow = merge?.[2] ?? row;
    const lastColumn = merge?.[3] ?? column;
    const width = merge ? columns.slice(column, lastColumn + 1).reduce((total, value) => total + value, 0) : columns[column];
    const height = merge ? rows.slice(row, lastRow + 1).reduce((total, value) => total + value, 0) : rows[row];
    const style = styles[styleId];
    const fontSize = style?.fontSize ?? 14;
    const lines = lineCount(value, fontSize * (style?.bold ? 1.08 : 1), Math.max(1, width - 12));
    const needed = Math.ceil(lines * fontSize * 1.25 + (lines > 1 ? 3 : 1));
    rows[row] += Math.max(0, needed - height);
  }
}

function parseSheet(content: DocumentPart, shared: string[], cellStyles: CellStyle[]): Worksheet {
  const cells: Worksheet["cells"] = [];
  const merges: Worksheet["merges"] = [];
  let truncated = false;
  let textLength = 0;
  let rowCount = 0;
  let columnCount = 0;
  const rows: number[] = [];
  const columns: number[] = [];
  const format = content && descendants(content, "sheetFormatPr")[0];
  const rowHeight = Math.max(12, Math.min(512, Number(format?.getAttribute("defaultRowHeight")) * 4 / 3 || 20));
  const data = content && descendants(content, "sheetData")[0];
  function include(row: number, column: number) {
    if (row >= maxRows || column >= maxColumns) {
      truncated = true;
      return false;
    }
    rowCount = Math.max(rowCount, row + 1);
    columnCount = Math.max(columnCount, column + 1);
    return true;
  }
  for (const [index, row] of (data ? children(data, ["row"]) : []).entries()) {
    const number = Number(row.getAttribute("r")) - 1;
    const rowIndex = number >= 0 ? number : index;
    if (rowIndex >= maxRows || cells.length >= maxCells || textLength >= maxText) {
      truncated = true;
      break;
    }
    const height = Number(row.getAttribute("ht"));
    rows[rowIndex] = row.getAttribute("hidden") === "1" ? 0 : height > 0 ? Math.min(height * 4 / 3, 512) : rowHeight;
    for (const [column, cell] of children(row, ["c"]).entries()) {
      if (cells.length >= maxCells || textLength >= maxText) {
        truncated = true;
        break;
      }
      const [cellRow, cellColumn] = position(cell.getAttribute("r") ?? "") ?? [rowIndex, column];
      if (!include(cellRow, cellColumn)) continue;
      const style = Number(cell.getAttribute("s") ?? row.getAttribute("s")) || 0;
      const raw = children(cell, ["v"])[0]?.textContent ?? "";
      const formula = children(cell, ["f"])[0]?.textContent;
      const type = cell.getAttribute("t");
      const numeric = (!type || type === "n") && raw !== "";
      const value = type === "s" ? shared[Number(raw)] ?? "" : type === "inlineStr" ? plainText(cell)
        : type === "b" ? raw === "1" ? "TRUE" : "FALSE"
        : numeric ? formattedNumber(raw, cellStyles[style]?.format) : raw || (formula ? `=${formula}` : "");
      if (!value && !style) continue;
      if (textLength + value.length > maxText) {
        textLength = maxText;
        truncated = true;
        break;
      }
      textLength += value.length;
      cells.push([cellRow, cellColumn, value, style, numeric]);
    }
  }
  const mergeNodes = content ? descendants(content, "mergeCell") : [];
  truncated ||= mergeNodes.length > maxMerges;
  for (const merge of mergeNodes.slice(0, maxMerges)) {
    const [start, end] = (merge.getAttribute("ref") ?? "").split(":").map(position);
    if (start && end && end[0] >= start[0] && end[1] >= start[1] && include(...start) && include(...end)) {
      merges.push([...start, ...end]);
    }
  }
  const defaultWidth = Math.max(12, Math.min(768, Number(format?.getAttribute("defaultColWidth")) * 7 || 64));
  for (const col of content ? descendants(content, "col") : []) {
    const min = Math.max(1, Number(col.getAttribute("min")));
    const max = Math.min(columnCount, Number(col.getAttribute("max")));
    const width = Math.max(12, Math.min(768, Number(col.getAttribute("width")) * 7 || defaultWidth));
    for (let index = min; index <= max; index++) {
      columns[index - 1] = col.getAttribute("hidden") === "1" ? 0 : width;
    }
  }
  const sheet = {
    columns: Array.from({ length: columnCount }, (_, index) => columns[index] ?? defaultWidth),
    rows: Array.from({ length: rowCount }, (_, index) => rows[index] ?? rowHeight),
    styles: cellStyles.map(({ format: _format, ...style }) => style),
    cells, merges, truncated,
  };
  fitCellContents(sheet);
  return sheet;
}

type DocumentPart = ReturnType<typeof relatedParts>[number]["content"];
let cached: {
  key: string;
  workbook: Awaited<ReturnType<typeof loadWorkbook>>;
  sheet?: { index: number; data: Worksheet };
} | undefined;

async function loadWorkbook(bytes: Buffer) {
  const documents = await loadOffice(bytes, (path) => workbookParts.test(path));
  const shared = documents.get("xl/sharedStrings.xml");
  return {
    bytes,
    sheets: relatedParts(documents, "xl/workbook.xml", "sheet").filter(({ hidden }) => !hidden)
      .slice(0, 256).map(({ name, path }) => ({ name: name ?? "", path })),
    shared: shared ? descendants(shared, "si").map(plainText) : [],
    styles: styles(documents.get("xl/styles.xml")?.documentElement),
  };
}

export function loadWorksheet(root: string, path: string, selected: number) {
  return withWorkspaceFile(root, path, ["xlsx"], async (file, size, revision) => {
    if (size > officeFileLimit) throw new Error("Document exceeds the preview limit.");
    const key = JSON.stringify([root, path, revision]);
    if (cached?.key !== key) cached = { key, workbook: await loadWorkbook(await file.readFile()) };
    const current = cached;
    const { sheets, bytes, shared, styles } = current.workbook;
    const index = Math.min(selected, sheets.length - 1);
    if (current.sheet?.index !== index) {
      const selectedSheet = sheets[index];
      let content: DocumentPart;
      if (selectedSheet) {
        if (!selectedSheet.path || !worksheetPart.test(selectedSheet.path)) throw new Error("Unsupported worksheet part.");
        const parts = await loadOffice(bytes, (name) => name === selectedSheet.path);
        content = parts.get(selectedSheet.path);
        if (!content) throw new Error("Missing worksheet part.");
      }
      current.sheet = { index, data: parseSheet(content, shared, styles) };
    }
    return {
      names: sheets.map(({ name }) => name),
      sheet: current.sheet.data,
    };
  });
}

export async function searchWorksheet(root: string, path: string, index: number, query: string, options: MarkdownSearchOptions) {
  const expression = searchExpression(query, options);
  const matches: WorksheetMatch[] = [];
  if (!expression) return { matches, limited: false, invalidPattern: true };
  const { sheet } = await loadWorksheet(root, path, index);
  for (const [row, column, text] of sheet.cells) {
    if (!sheet.rows[row] || !sheet.columns[column]) continue;
    for (const match of text.matchAll(expression)) {
      if (!match[0].length) continue;
      if (matches.length >= 10_000) return { matches, limited: true, invalidPattern: false };
      matches.push([row, column, match.index, match.index + match[0].length]);
    }
  }
  return { matches, limited: sheet.truncated, invalidPattern: false };
}
