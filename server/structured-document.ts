import { extname } from "node:path";
import type { DocumentBlock, DocumentSection } from "../shared/contracts";
import { children, descendants, loadOffice, officeFileLimit, plainText, relatedParts } from "./office-xml";
import { withWorkspaceFile } from "./workspace-file";

const maxSections = 32;
const maxBlocks = 180;
const maxRows = 120;
const maxColumns = 20;
const importantPart = /^(?:word\/document\.xml|ppt\/(?:presentation\.xml|slides\/[^/]+\.xml|_rels\/presentation\.xml\.rels))$/;
type XmlParts = Awaited<ReturnType<typeof loadOffice>>;

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
  return withWorkspaceFile(root, path, ["docx", "pptx"], async (file, size) => {
    if (size > officeFileLimit) throw new Error("Document exceeds the preview limit.");
    const documents = await loadOffice(await file.readFile(), importantPart);
    return limitPreview(extension === "docx" ? wordSections(documents) : slideSections(documents));
  });
}
