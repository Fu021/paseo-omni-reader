import { posix } from "node:path";
import type { MarkdownSearchOptions, Worksheet, WorksheetMatch } from "../shared/contracts";
import { loadOfficeSources, officeFileLimit } from "./office-xml";
import { rustReader } from "./rust-reader";
import { searchExpression } from "./text-search";
import { withWorkspaceFile } from "./workspace-file";

const workbookParts = /^xl\/(?:workbook\.xml|styles\.xml|sharedStrings\.xml|_rels\/workbook\.xml\.rels)$/;
const worksheetPart = /^xl\/worksheets\/[^/]+\.xml$/;
let cached: {
  key: string;
  workbook: Awaited<ReturnType<typeof loadWorkbook>>;
  sheet?: { index: number; data: Worksheet };
} | undefined;

async function loadWorkbook(bytes: Buffer) {
  const [reader, sources] = await Promise.all([rustReader(), loadOfficeSources(bytes, (path) => workbookParts.test(path))]);
  const workbook = sources.get("xl/workbook.xml");
  const relationships = sources.get("xl/_rels/workbook.xml.rels");
  if (!workbook || !relationships) throw new Error("Missing document parts.");
  const parsed = new reader.Workbook(workbook, relationships,
    sources.get("xl/styles.xml") ?? "", sources.get("xl/sharedStrings.xml") ?? "");
  const sheets: [name: string, target: string | null][] = JSON.parse(parsed.sheetFiles());
  return { bytes, parsed, sheets };
}

export function loadWorksheet(root: string, path: string, selected: number) {
  return withWorkspaceFile(root, path, ["xlsx"], async (file, size, revision) => {
    if (size > officeFileLimit) throw new Error("Document exceeds the preview limit.");
    const key = JSON.stringify([root, path, revision]);
    if (cached?.key !== key) cached = { key, workbook: await loadWorkbook(await file.readFile()) };
    const current = cached;
    const { sheets, bytes, parsed } = current.workbook;
    const index = Math.min(selected, sheets.length - 1);
    if (current.sheet?.index !== index) {
      const selectedSheet = sheets[index];
      let source = "";
      if (selectedSheet) {
        const [, target] = selectedSheet;
        if (!target) throw new Error("Unsupported worksheet part.");
        const path = target.startsWith("/") ? target.slice(1) : posix.normalize(`xl/${target}`);
        if (!worksheetPart.test(path)) throw new Error("Unsupported worksheet part.");
        source = (await loadOfficeSources(bytes, (name) => name === path)).get(path) ?? "";
        if (!source) throw new Error("Missing worksheet part.");
      }
      current.sheet = { index, data: JSON.parse(parsed.previewSheet(source)) as Worksheet };
    }
    return { names: sheets.map(([name]) => name), sheet: current.sheet.data };
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
