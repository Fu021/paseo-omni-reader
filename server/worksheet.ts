import type { Element } from "@xmldom/xmldom";
import type { Worksheet } from "../shared/contracts";
import { children, descendants, loadOffice, officeFileLimit, plainText, relatedParts } from "./office-xml";
import { withWorkspaceFile } from "./workspace-file";

const workbookParts = /^xl\/(?:workbook\.xml|styles\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)$/;
const maxRows = 8_192;
const maxColumns = 256;
const maxCells = 80_000;
const maxText = 400_000;
const maxMerges = 4_096;
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
      const preview = value.slice(0, Math.min(1_024, maxText - textLength));
      truncated ||= preview.length < value.length;
      textLength += preview.length;
      cells.push([cellRow, cellColumn, preview, style, numeric]);
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
  return {
    columns: Array.from({ length: columnCount }, (_, index) => columns[index] ?? defaultWidth),
    rows: Array.from({ length: rowCount }, (_, index) => rows[index] ?? rowHeight),
    styles: cellStyles.map(({ format: _format, ...style }) => style),
    cells, merges, truncated,
  };
}

type DocumentPart = ReturnType<typeof relatedParts>[number]["content"];
let cached: { key: string; workbook: Awaited<ReturnType<typeof loadWorkbook>> } | undefined;

async function loadWorkbook(bytes: Buffer) {
  const documents = await loadOffice(bytes, workbookParts);
  const shared = documents.get("xl/sharedStrings.xml");
  return {
    sheets: relatedParts(documents, "xl/workbook.xml", "sheet").filter(({ hidden }) => !hidden).slice(0, 256),
    shared: shared ? descendants(shared, "si").map(plainText) : [],
    styles: styles(documents.get("xl/styles.xml")?.documentElement),
  };
}

export function loadWorksheet(root: string, path: string, selected: number) {
  return withWorkspaceFile(root, path, ["xlsx"], async (file, size, revision) => {
    if (size > officeFileLimit) throw new Error("Document exceeds the preview limit.");
    const key = JSON.stringify([root, path, revision]);
    if (cached?.key !== key) cached = { key, workbook: await loadWorkbook(await file.readFile()) };
    const { sheets, shared, styles } = cached.workbook;
    return {
      names: sheets.map(({ name }) => name ?? ""),
      sheet: parseSheet(sheets[Math.min(selected, sheets.length - 1)]?.content, shared, styles),
    };
  });
}
