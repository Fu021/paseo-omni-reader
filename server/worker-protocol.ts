import type { RpcOutput } from "@getpaseo/plugin";
import type {
  Formula, FormulaPlatform, PageRun, readStructuredDocument, readWorksheet, renderFormulas, renderPdfPage,
} from "../shared/contracts";

export type EngineRequest =
  | { kind: "math"; color: string; platform: FormulaPlatform; formulas: Formula[] }
  | { kind: "pdf"; root: string; path: string; page: number; pixels: number }
  | { kind: "office"; key: string; data: Uint8Array; page: number; pixels: number }
  | { kind: "pdf-layout"; root: string; path: string }
  | { kind: "office-layout"; key: string; data: Uint8Array }
  | { kind: "document"; root: string; path: string }
  | { kind: "worksheet"; root: string; path: string; sheet: number };

export interface EngineResults {
  math: RpcOutput<typeof renderFormulas>;
  pdf: RpcOutput<typeof renderPdfPage>;
  office: EngineResults["pdf"];
  "pdf-layout": PageRun[];
  "office-layout": EngineResults["pdf-layout"];
  document: RpcOutput<typeof readStructuredDocument>;
  worksheet: RpcOutput<typeof readWorksheet>;
}

export type EngineResponse =
  | { result: EngineResults[keyof EngineResults] }
  | { error: string };
