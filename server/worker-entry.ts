import { parentPort } from "node:worker_threads";
import type { EngineRequest, EngineResponse, EngineResults } from "./worker-protocol";

declare const __OMNI_MATH_WORKER__: boolean;

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
    } else if (request.kind === "worksheet") {
      const { loadWorksheet } = await import("./worksheet");
      result = await loadWorksheet(request.root, request.path, request.sheet);
    } else {
      throw new Error("Invalid document request.");
    }
    parentPort?.postMessage({ result } satisfies EngineResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not render the document.";
    parentPort?.postMessage({ error: message } satisfies EngineResponse);
  }
});
