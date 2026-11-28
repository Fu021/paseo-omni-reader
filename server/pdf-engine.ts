import { PDFiumLibrary, type PDFiumDocument } from "@hyzyla/pdfium/inline";
import { encode } from "jpeg-js";
import type { MarkdownSearchOptions, PageRun, PageTextMatch } from "../shared/contracts";
import { readPageText } from "./pdf-text-geometry";
import { searchExpression } from "./text-search";
import { withWorkspaceFile } from "./workspace-file";

const maxPdfBytes = 128 * 1024 * 1024;
const maxJpegBytes = 750 * 1024;
const maxCachedLayouts = 8;
const maxCachedLayoutRuns = 4096;
const maxCachedPages = 16;
const maxCachedCharacters = 8 * 1024 * 1024;
let library: Promise<PDFiumLibrary> | undefined;
let opened: { key: string; document: PDFiumDocument; runs?: PageRun[] } | undefined;
const cachedLayouts = new Map<string, PageRun[]>();
const renderedPages = new Map<string, Awaited<ReturnType<typeof renderPage>>>();
let cachedCharacters = 0;

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

export function pdfText(root: string, path: string, page: number) {
  return usePdfFile(root, path, (key, bytes) => readPdfText(key, bytes, page));
}

export function searchPdf(root: string, path: string, query: string, options: MarkdownSearchOptions) {
  return usePdfFile(root, path, (key, bytes) => findPageTextMatches(key, bytes, query, options));
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

export async function readPdfText(key: string, bytes: () => Promise<Uint8Array>, number: number) {
  const { document } = await openDocument(key, bytes);
  if (number > document.getPageCount()) return { text: "", truncated: false, glyphs: [] };
  const page = document.getPage(number - 1);
  try {
    return readPageText(page, true);
  } finally {
    page.close();
  }
}

export async function findPageTextMatches(key: string, bytes: () => Promise<Uint8Array>, query: string, options: MarkdownSearchOptions) {
  const expression = searchExpression(query, options, true);
  const matches: PageTextMatch[] = [];
  if (!expression) return { matches, limited: false, invalidPattern: true };
  const { document } = await openDocument(key, bytes);
  const count = document.getPageCount();
  const limit = 10_000;
  let limited = false;
  for (let number = 1; number <= count; number++) {
    const page = document.getPage(number - 1);
    try {
      const { text, truncated } = readPageText(page, false);
      limited ||= truncated;
      for (const match of text.matchAll(expression)) {
        if (!match[0].length) continue;
        if (matches.length >= limit) return { matches, limited: true, invalidPattern: false };
        matches.push([number, match.index, match.index + match[0].length]);
      }
    } finally {
      page.close();
    }
  }
  return { matches, limited, invalidPattern: false };
}

function readSize(page: ReturnType<PDFiumDocument["getPage"]>) {
  const { originalWidth: width, originalHeight: height } = page.getOriginalSize();
  if (!Number.isFinite(width + height) || width <= 0 || height <= 0) {
    throw new Error("PDF page has invalid dimensions.");
  }
  return { width, height };
}

export async function inspectPdfPages(key: string, bytes: () => Promise<Uint8Array>) {
  const cached = cachedLayouts.get(key);
  if (cached) {
    cachedLayouts.delete(key);
    cachedLayouts.set(key, cached);
    return cached;
  }
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
  if (runs.length <= maxCachedLayoutRuns) {
    cachedLayouts.set(key, runs);
    if (cachedLayouts.size > maxCachedLayouts) {
      const oldest = cachedLayouts.keys().next().value;
      if (oldest !== undefined) cachedLayouts.delete(oldest);
    }
  }
  return runs;
}

export async function rasterizePdfPage(key: string, bytes: () => Promise<Uint8Array>, pageNumber: number, pixels: number) {
  const cacheKey = JSON.stringify([key, pageNumber, pixels]);
  const cached = renderedPages.get(cacheKey);
  if (cached) {
    renderedPages.delete(cacheKey);
    renderedPages.set(cacheKey, cached);
    return cached;
  }
  const image = await renderPage(key, bytes, pageNumber, pixels);
  cachedCharacters -= renderedPages.get(cacheKey)?.uri.length ?? 0;
  renderedPages.set(cacheKey, image);
  cachedCharacters += image.uri.length;
  for (const [oldestKey, oldest] of renderedPages) {
    if (renderedPages.size <= maxCachedPages && cachedCharacters <= maxCachedCharacters) break;
    renderedPages.delete(oldestKey);
    cachedCharacters -= oldest.uri.length;
  }
  return image;
}

async function renderPage(key: string, bytes: () => Promise<Uint8Array>, pageNumber: number, pixels: number) {
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
