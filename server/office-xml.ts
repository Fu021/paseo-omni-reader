import { posix } from "node:path";
import { DOMParser, onErrorStopParsing, type Document, type Element } from "@xmldom/xmldom";
import { fromBufferPromise } from "yauzl";

export const officeFileLimit = 24 * 1024 * 1024;
const xmlLimit = 4 * 1024 * 1024;
const totalXmlLimit = 12 * 1024 * 1024;
const parser = new DOMParser({ onError: onErrorStopParsing });
type XmlParts = Map<string, Document>;

export function descendants(node: Document | Element, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS("*", name));
}

export function children(node: Element, names: string[]): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element =>
    child.nodeType === 1 && names.includes((child as Element).localName ?? ""),
  );
}

export function plainText(node: Element): string {
  return descendants(node, "t").map(({ textContent }) => textContent ?? "").join("");
}

export async function loadOffice(bytes: Buffer, selectedParts: RegExp): Promise<XmlParts> {
  const archive = await fromBufferPromise(bytes, { lazyEntries: true, validateEntrySizes: true });
  const documents: XmlParts = new Map();
  let total = 0;
  try {
    if (archive.entryCount > 8_000) throw new Error("Document exceeds the preview limit.");
    for await (const entry of archive.eachEntry()) {
      if (!selectedParts.test(entry.fileName)) continue;
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

export function relatedParts(documents: XmlParts, main: string, tag: string) {
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
  return descendants(part, tag).map((entry) => {
    const relationship = entry.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id")
      ?? entry.getAttributeNS("http://purl.oclc.org/ooxml/officeDocument/relationships", "id");
    return {
      name: entry.getAttribute("name") ?? undefined,
      hidden: ["hidden", "veryHidden"].includes(entry.getAttribute("state") ?? ""),
      content: documents.get(targets.get(relationship ?? "") ?? ""),
    };
  });
}
