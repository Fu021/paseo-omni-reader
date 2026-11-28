import type { RpcOutput } from "@getpaseo/plugin";
import type {
  Formula, FormulaPlatform, MarkdownSearchOptions, PageRun, findDocumentText, findWorksheetText, readDocumentText, searchMarkdownFile,
  readStructuredDocument, readWorksheet, renderFormulas, renderPdfPage,
} from "../shared/contracts";

export type EngineRequest =
  | { kind: "math"; color: string; platform: FormulaPlatform; formulas: Formula[] }
  | { kind: "pdf"; root: string; path: string; page: number; pixels: number }
  | { kind: "office"; key: string; data: Uint8Array; page: number; pixels: number }
  | { kind: "pdf-layout"; root: string; path: string }
  | { kind: "office-layout"; key: string; data: Uint8Array }
  | { kind: "pdf-text"; root: string; path: string; page: number }
  | { kind: "pdf-search"; root: string; path: string; query: string; options: MarkdownSearchOptions }
  | { kind: "office-text"; key: string; data: Uint8Array; page: number }
  | { kind: "office-search"; key: string; data: Uint8Array; query: string; options: MarkdownSearchOptions }
  | { kind: "markdown-search"; root: string; path: string; query: string; options: MarkdownSearchOptions; offset: number }
  | { kind: "document"; root: string; path: string }
  | { kind: "worksheet"; root: string; path: string; sheet: number }
  | { kind: "worksheet-search"; root: string; path: string; sheet: number; query: string; options: MarkdownSearchOptions };

export interface EngineResults {
  math: RpcOutput<typeof renderFormulas>;
  pdf: RpcOutput<typeof renderPdfPage>;
  office: EngineResults["pdf"];
  "pdf-layout": PageRun[];
  "office-layout": EngineResults["pdf-layout"];
  "pdf-text": NonNullable<RpcOutput<typeof readDocumentText>>;
  "pdf-search": NonNullable<RpcOutput<typeof findDocumentText>>;
  "office-text": EngineResults["pdf-text"];
  "office-search": EngineResults["pdf-search"];
  "markdown-search": RpcOutput<typeof searchMarkdownFile>;
  document: RpcOutput<typeof readStructuredDocument>;
  worksheet: RpcOutput<typeof readWorksheet>;
  "worksheet-search": RpcOutput<typeof findWorksheetText>;
}

export type EngineResponse =
  | { result: EngineResults[keyof EngineResults] }
  | { error: string };
