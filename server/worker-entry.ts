import { parentPort } from "node:worker_threads";
import type { Formula, FormulaPlatform } from "../shared/contracts";
import type { rasterizeFormulas } from "./math-engine";
import type { inspectPdf, rasterizePdf } from "./pdf-engine";
import type { loadStructuredDocument } from "./structured-document";

declare const __OMNI_MATH_WORKER__: boolean;

export type EngineRequest =
  | { kind: "math"; color: string; platform: FormulaPlatform; formulas: Formula[] }
  | { kind: "pdf"; root: string; path: string; page: number; pixels: number }
  | { kind: "office"; key: string; data: Uint8Array; page: number; pixels: number }
  | { kind: "pdf-layout"; root: string; path: string }
  | { kind: "office-layout"; key: string; data: Uint8Array }
  | { kind: "document"; root: string; path: string };

export interface EngineResults {
  math: Awaited<ReturnType<typeof rasterizeFormulas>>;
  pdf: Awaited<ReturnType<typeof rasterizePdf>>;
  office: EngineResults["pdf"];
  "pdf-layout": Awaited<ReturnType<typeof inspectPdf>>;
  "office-layout": EngineResults["pdf-layout"];
  document: Awaited<ReturnType<typeof loadStructuredDocument>>;
}

export type EngineResponse =
  | { result: EngineResults[keyof EngineResults] }
  | { error: string };

parentPort?.on("message", async (request: EngineRequest) => {
  try {
    let result: EngineResults[keyof EngineResults];
    if (__OMNI_MATH_WORKER__) {
      if (request.kind !== "math") throw new Error("Invalid formula request.");
      const { rasterizeFormulas } = await import("./math-engine");
      result = await rasterizeFormulas(request.formulas, request.color, request.platform);
    } else if (request.kind === "pdf" || request.kind === "pdf-layout") {
      const { rasterizePdf, inspectPdf } = await import("./pdf-engine");
      result = request.kind === "pdf-layout"
        ? await inspectPdf(request.root, request.path)
        : await rasterizePdf(request.root, request.path, request.page, request.pixels);
    } else if (request.kind === "office" || request.kind === "office-layout") {
      const { rasterizePdfPage, inspectPdfPages } = await import("./pdf-engine");
      const bytes = async () => request.data;
      result = request.kind === "office-layout"
        ? await inspectPdfPages(request.key, bytes)
        : await rasterizePdfPage(request.key, bytes, request.page, request.pixels);
    } else if (request.kind === "document") {
      const { loadStructuredDocument } = await import("./structured-document");
      result = await loadStructuredDocument(request.root, request.path);
    } else {
      throw new Error("Invalid document request.");
    }
    parentPort?.postMessage({ result } satisfies EngineResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not render the document.";
    parentPort?.postMessage({ error: message } satisfies EngineResponse);
  }
});
