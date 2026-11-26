import { posix, extname } from "node:path";
import { DOMParser, onErrorStopParsing, type Document, type Element } from "@xmldom/xmldom";
import { parse } from "csv-parse/sync";
import { fromBufferPromise } from "yauzl";
import { dataExtensions, officeExtensions, type DocumentBlock, type DocumentSection } from "../shared/contracts";
import { withWorkspaceFile } from "./workspace-file";

const fileLimit = 24 * 1024 * 1024;
const xmlLimit = 4 * 1024 * 1024;
const totalXmlLimit = 12 * 1024 * 1024;
const maxSections = 32;
const maxBlocks = 180;
const maxRows = 120;
const maxColumns = 20;
const importantPart = /^(?:word\/document\.xml|xl\/(?:workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)|ppt\/(?:presentation\.xml|slides\/[^/]+\.xml|_rels\/presentation\.xml\.rels))$/;
const parser = new DOMParser({ onError: onErrorStopParsing });
type XmlParts = Map<string, Document>;

function descendants(node: Document | Element, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS("*", name));
}

function children(node: Element, names: string[]): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element =>
    child.nodeType === 1 && names.includes((child as Element).localName ?? ""),
  );
}

function plainText(node: Element): string {
  return descendants(node, "t").map(({ textContent }) => textContent ?? "").join("");
}

async function loadOffice(bytes: Buffer): Promise<XmlParts> {
  const archive = await fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true });
  const documents: XmlParts = new Map();
  let total = 0;
  try {
    if (archive.entryCount > 8_000) throw new Error("Document exceeds the preview limit.");
    for await (const entry of archive.eachEntry()) {
      if (!importantPart.test(entry.fileName)) continue;
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > xmlLimit || total > totalXmlLimit) throw new Error("Document exceeds the preview limit.");
      const stream = await archive.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      const source = Buffer.concat(chunks).toString("utf8");
      if (/<!DOCTYPE/i.test(source)) throw new Error("Unsupported document XML.");
      documents.set(entry.fileName, parser.parseFromString(source, "application/xml"));
    }
    return documents;
  } finally {
    archive.close();
  }
}

function relatedParts(documents: XmlParts, main: string, tag: string) {
  const part = documents.get(main);
  const directory = posix.dirname(main);
  const relationships = documents.get(`${directory}/_rels/${posix.basename(main)}.rels`);
  if (!part || !relationships) throw new Error("Missing document parts.");
  const targets = new Map(descendants(relationships, "Relationship").flatMap((relation) => {
    const target = relation.getAttribute("Target");
    const id = relation.getAttribute("Id");
    if (!id || !target || relation.getAttribute("TargetMode") === "External") return [];
    const path = target.startsWith("/") ? target.slice(1) : posix.normalize(`${directory}/${target}`);
    return [[id, path] as const];
  }));
  return descendants(part, tag).map((entry) => ({
    name: entry.getAttribute("name") ?? undefined,
    content: documents.get(targets.get(entry.getAttribute("r:id") ?? "") ?? ""),
  }));
}

function wordSections(documents: XmlParts): DocumentSection[] {
  const doc = documents.get("word/document.xml");
  const body = doc && descendants(doc, "body")[0];
  if (!body) throw new Error("Missing document body.");
  const blocks = children(body, ["p", "tbl"]).slice(0, maxBlocks + 1).flatMap((node): DocumentBlock[] => {
    if (node.localName === "tbl") {
      const rows = children(node, ["tr"]).slice(0, maxRows + 1).map((row) =>
        children(row, ["tc"]).slice(0, maxColumns + 1).map((cell) => children(cell, ["p"]).map(plainText).join("\n")),
      );
      return [{ kind: "table", rows }];
    }
    const text = plainText(node);
    const style = descendants(node, "pStyle")[0]?.getAttribute("w:val") ?? "";
    return text ? [{ kind: "paragraph", text, heading: /^(title|heading)/i.test(style) }] : [];
  });
  return [{ blocks }];
}

function columnNumber(cell: Element, fallback: number): number {
  const code = /^[A-Z]{1,3}/.exec(cell.getAttribute("r") ?? "")?.[0];
  return code ? Array.from(code).reduce((column, character) => column * 26 + character.charCodeAt(0) - 64, 0) - 1 : fallback;
}

function sheetSections(documents: XmlParts): DocumentSection[] {
  const strings = documents.get("xl/sharedStrings.xml");
  const shared = strings ? descendants(strings, "si").map(plainText) : [];
  return relatedParts(documents, "xl/workbook.xml", "sheet").slice(0, maxSections + 1).map(({ name, content }) => {
    const data = content && descendants(content, "sheetData")[0];
    const rows = data ? children(data, ["row"]).slice(0, maxRows + 1).map((row) => {
      const values: string[] = [];
      for (const [index, cell] of children(row, ["c"]).entries()) {
        const column = columnNumber(cell, index);
        if (column >= maxColumns) {
          values[maxColumns] = "";
          continue;
        }
        const value = descendants(cell, "v")[0]?.textContent ?? "";
        const type = cell.getAttribute("t");
        const cached = type === "s" ? shared[Number(value)] ?? "" : value;
        const formula = descendants(cell, "f")[0]?.textContent;
        values[column] = type === "inlineStr" ? plainText(cell) : cached || (formula ? `=${formula}` : "");
      }
      return Array.from(values, (value) => value ?? "");
    }) : [];
    return { title: name, blocks: [{ kind: "table", rows }] };
  });
}

function slideSections(documents: XmlParts): DocumentSection[] {
  return relatedParts(documents, "ppt/presentation.xml", "sldId").slice(0, maxSections + 1).map(({ content }) => {
    const texts = content ? descendants(content, "p").slice(0, maxBlocks + 1).map(plainText).filter(Boolean) : [];
    const [title, ...paragraphs] = texts;
    return { title, blocks: paragraphs.map((text) => ({ kind: "paragraph", text })) };
  });
}

function limitPreview(sections: DocumentSection[]) {
  let remaining = 90_000;
  let truncated = sections.length > maxSections;
  const text = (value: string, maxLength: number) => {
    const amount = Math.min(maxLength, remaining, value.length);
    remaining -= amount;
    truncated ||= amount < value.length;
    return value.slice(0, amount);
  };
  const take = <Value>(values: Value[], count: number) => {
    if (values.length > count) truncated = true;
    return values.slice(0, count);
  };
  return {
    sections: take(sections, maxSections).map(({ title, blocks }) => ({
      title: title ? text(title, 250) : undefined,
      blocks: take(blocks, maxBlocks).map((block): DocumentBlock => block.kind === "paragraph"
        ? { ...block, text: text(block.text, 8_000) }
        : { ...block, rows: take(block.rows, maxRows).map((row) => take(row, maxColumns).map((value) => text(value, 500))) }),
    })),
    get truncated() { return truncated; },
  };
}

export function loadStructuredDocument(root: string, path: string) {
  const extension = extname(path).slice(1).toLowerCase();
  return withWorkspaceFile(root, path, [...officeExtensions, ...dataExtensions], async (file, size) => {
    if (size > fileLimit) throw new Error("Document exceeds the preview limit.");
    const bytes = await file.readFile();
    if (dataExtensions.includes(extension)) {
      const rows: string[][] = parse(bytes, {
        bom: true, delimiter: extension === "tsv" ? "\t" : ",", relax_column_count: true,
        skip_empty_lines: true, to: maxRows + 1, max_record_size: 256 * 1024,
      });
      return limitPreview([{ blocks: [{ kind: "table", rows, header: true }] }]);
    }
    const documents = await loadOffice(bytes);
    return limitPreview(extension === "docx" ? wordSections(documents)
      : extension === "xlsx" ? sheetSections(documents)
      : slideSections(documents));
  });
}
