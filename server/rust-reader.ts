import { createRequire } from "node:module";
import { join } from "node:path";
import { workerData } from "node:worker_threads";
import { officeDirectory } from "./office-location";

export interface RustWorkbook {
  sheetFiles(): string;
  previewSheet(source: string): string;
}

interface RustReader {
  Workbook: new (workbook: string, relationships: string, styles: string, strings: string) => RustWorkbook;
  markdownStructure(source: string): string;
  markdownHeading(source: string): string;
  encodePageJpeg(pixels: Uint8Array, width: number, height: number, maxBytes: number): Uint8Array;
  configureMathFont(bytes: Uint8Array): void;
  renderFormula(tex: string, display: boolean, color: string, vector: boolean): {
    width: number;
    height: number;
    baseline: number;
    vector: boolean;
    bytes(): Uint8Array;
  } | undefined;
}

let runtime: Promise<RustReader> | undefined;

export function readerDirectory() {
  return typeof workerData === "string" ? Promise.resolve(workerData) : officeDirectory();
}

export function rustReader() {
  return runtime ??= readerDirectory().then((directory) => {
    const requireFromPlugin = createRequire(join(directory, "package.json"));
    return requireFromPlugin("./server/generated/rust-reader.cjs") as RustReader;
  }).catch((error) => {
    runtime = undefined;
    throw error;
  });
}
