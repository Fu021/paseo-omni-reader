import { parentPort } from "node:worker_threads";
import type { Formula, FormulaPlatform } from "../shared/contracts";
import { rasterizeFormulas } from "./math-engine";
import { rasterizePdf } from "./pdf-engine";

export type EngineRequest =
  | { kind: "math"; color: string; platform: FormulaPlatform; formulas: Formula[] }
  | { kind: "pdf"; root: string; path: string; page: number; pixels: number };

export interface EngineResults {
  math: Awaited<ReturnType<typeof rasterizeFormulas>>;
  pdf: Awaited<ReturnType<typeof rasterizePdf>>;
}

export type EngineResponse =
  | { result: EngineResults[keyof EngineResults] }
  | { error: string };

parentPort?.on("message", async (request: EngineRequest) => {
  try {
    const result = request.kind === "math"
      ? await rasterizeFormulas(request.formulas, request.color, request.platform)
      : await rasterizePdf(request.root, request.path, request.page, request.pixels);
    parentPort?.postMessage({ result } satisfies EngineResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not render the document.";
    parentPort?.postMessage({ error: message } satisfies EngineResponse);
  }
});
