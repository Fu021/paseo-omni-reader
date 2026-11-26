import { PDFiumLibrary, type PDFiumDocument } from "@hyzyla/pdfium/inline";
import { encode } from "jpeg-js";
import { withWorkspaceFile } from "./workspace-file";

const maxPdfBytes = 128 * 1024 * 1024;
const maxJpegBytes = 750 * 1024;
let library: Promise<PDFiumLibrary> | undefined;
let opened: { key: string; document: PDFiumDocument } | undefined;

export function rasterizePdf(root: string, path: string, pageNumber: number, pixels: number) {
  return withWorkspaceFile(root, path, ["pdf"], async (file, size, revision) => {
    if (size > maxPdfBytes) throw new Error("PDF exceeds the 128 MiB reader limit.");
    const key = JSON.stringify([root, path, revision]);
    if (opened?.key !== key) {
      opened?.document.destroy();
      opened = undefined;
      const engine = await (library ??= PDFiumLibrary.init({ disableBase64Warning: true }));
      const document = await engine.loadDocument(await file.readFile());
      opened = { key, document };
    }
    const { document } = opened;
    const pages = document.getPageCount();
    if (pages < 1) throw new Error("PDF has no pages.");
    const pageIndex = Math.min(pageNumber, pages);
    const page = document.getPage(pageIndex - 1);
    try {
      const { originalWidth: width, originalHeight: height } = page.getOriginalSize();
      if (!Number.isFinite(width + height) || width <= 0 || height <= 0) {
        throw new Error("PDF page has invalid dimensions.");
      }
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
  });
}
