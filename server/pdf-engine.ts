import { PDFiumLibrary, type PDFiumDocument } from "@hyzyla/pdfium/inline";
import { encode } from "jpeg-js";
import type { PageRun } from "../shared/contracts";
import { withWorkspaceFile } from "./workspace-file";

const maxPdfBytes = 128 * 1024 * 1024;
const maxJpegBytes = 750 * 1024;
let library: Promise<PDFiumLibrary> | undefined;
let opened: { key: string; document: PDFiumDocument; runs?: PageRun[] } | undefined;

function usePdfFile<Result>(root: string, path: string, consume: (key: string, bytes: () => Promise<Buffer>) => Promise<Result>) {
  return withWorkspaceFile(root, path, ["pdf"], async (file, size, revision) => {
    if (size > maxPdfBytes) throw new Error("PDF exceeds the 128 MiB reader limit.");
    return consume(JSON.stringify([root, path, revision]), () => file.readFile());
  });
}

export function rasterizePdf(root: string, path: string, pageNumber: number, pixels: number) {
  return usePdfFile(root, path, (key, bytes) => rasterizePdfPage(key, bytes, pageNumber, pixels));
}

export function inspectPdf(root: string, path: string) {
  return usePdfFile(root, path, inspectPdfPages);
}

async function openDocument(key: string, bytes: () => Promise<Uint8Array>) {
  if (opened?.key !== key) {
    opened?.document.destroy();
    opened = undefined;
    const engine = await (library ??= PDFiumLibrary.init({ disableBase64Warning: true }));
    const document = await engine.loadDocument(await bytes());
    opened = { key, document };
  }
  return opened;
}

function readSize(page: ReturnType<PDFiumDocument["getPage"]>) {
  const { originalWidth: width, originalHeight: height } = page.getOriginalSize();
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0) {
    throw new Error("PDF page has invalid dimensions.");
  }
  return { width, height };
}

export async function inspectPdfPages(key: string, bytes: () => Promise<Uint8Array>) {
  const opened = await openDocument(key, bytes);
  if (opened.runs) return opened.runs;
  const { document } = opened;
  const pages = document.getPageCount();
  if (pages < 1) throw new Error("PDF has no pages.");
  const runs: PageRun[] = [];
  for (let index = 0; index < pages; index++) {
    const page = document.getPage(index);
    try {
      const { width, height } = readSize(page);
      const previous = runs.at(-1);
      if (previous?.width === width && previous.height === height) previous.count++;
      else runs.push({ count: 1, width, height });
    } finally {
      page.close();
    }
  }
  opened.runs = runs;
  return runs;
}

export async function rasterizePdfPage(key: string, bytes: () => Promise<Uint8Array>, pageNumber: number, pixels: number) {
  const { document } = await openDocument(key, bytes);
  const pages = document.getPageCount();
  if (pages < 1) throw new Error("PDF has no pages.");
  const pageIndex = Math.min(pageNumber, pages);
  const page = document.getPage(pageIndex - 1);
  try {
    const { width, height } = readSize(page);
    const scale = Math.min(pixels / width, 3072 / height, Math.sqrt(5_000_000 / (width * height)));
    const raster = await page.render({ width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) });
    for (const quality of [88, 70, 49, 30, 15]) {
      const jpeg = encode(raster, quality).data;
      if (jpeg.byteLength <= maxJpegBytes) {
        return { page: pageIndex, pages, width, height, uri: `data:image/jpeg;base64,${jpeg.toString("base64")}` };
      }
    }
    throw new Error("PDF page is too detailed to preview.");
  } finally {
    page.close();
  }
}
