import type { PDFiumDocument } from "@hyzyla/pdfium/inline";
import type { PageGlyph } from "../shared/contracts";

type Page = ReturnType<PDFiumDocument["getPage"]>;
type TextGeometryPage = {
  pageIdx: number;
  loadTextPage(): number;
  module: {
    _FPDFText_CountChars(text: number): number;
    _FPDFText_GetUnicode(text: number, index: number): number;
    _FPDFText_GetLooseCharBox(text: number, index: number, rect: number): number;
    _FPDF_PageToDevice(page: number, x: number, y: number, width: number, height: number, rotation: number,
      pdfX: number, pdfY: number, deviceX: number, deviceY: number): number;
    HEAPF32: Float32Array;
    HEAP32: Int32Array;
    wasmExports: { malloc(size: number): number; free(address: number): void };
  };
};

const resolution = 10_000;
const maxGlyphs = 16_384;

export function readPageText(page: Page, positioned: boolean) {
  const { module, pageIdx, loadTextPage } = page as unknown as TextGeometryPage;
  const textPage = loadTextPage.call(page);
  const count = module._FPDFText_CountChars(textPage);
  const buffer = positioned ? module.wasmExports.malloc(16) : 0;
  if (positioned && !buffer) throw new Error("Could not allocate the page text buffer.");
  const slot = buffer >>> 2;
  const toDevice = (x: number, y: number) => {
    module._FPDF_PageToDevice(pageIdx, 0, 0, resolution, resolution, 0, x, y, buffer, buffer + 4);
    return [module.HEAP32[slot], module.HEAP32[slot + 1]];
  };
  let text = "";
  const glyphs: PageGlyph[] = [];
  try {
    for (let index = 0; index < Math.min(count, maxGlyphs); index++) {
      const code = module._FPDFText_GetUnicode(textPage, index);
      if (code <= 0 || code > 0x10ffff || code === 13) continue;
      const start = text.length;
      text += String.fromCodePoint(code);
      if (!positioned || code === 10 || !module._FPDFText_GetLooseCharBox(textPage, index, buffer)) continue;
      const [left, top, right, bottom] = module.HEAPF32.subarray(slot, slot + 4);
      if (!(right > left && top > bottom)) continue;
      const [firstX, firstY] = toDevice(left, top);
      const [lastX, lastY] = toDevice(right, bottom);
      if (firstX === lastX || firstY === lastY) continue;
      glyphs.push([start, text.length, Math.min(firstX, lastX) / resolution, Math.min(firstY, lastY) / resolution,
        Math.max(firstX, lastX) / resolution, Math.max(firstY, lastY) / resolution]);
    }
    return { text, glyphs, truncated: count > maxGlyphs };
  } finally {
    if (buffer) module.wasmExports.free(buffer);
  }
}
