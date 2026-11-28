import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { maxFormulaLength, maxMarkdownTableLine } from "./markdown-constants";

export { markdownExtensions, markdownSearchPageSize, maxFormulaLength, maxMarkdownTableLine } from "./markdown-constants";

export const pagedOfficeExtensions = ["docx", "pptx"];
export const officeExtensions = [...pagedOfficeExtensions, "xlsx"];
export const markdownKind = "rich-assistant-markdown";
export const messageSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]).optional(),
  messageId: z.string().optional(),
});
export const formulasPerRequest = 12;
export const formulaImageUri = /^data:image\/(?:png|svg\+xml);base64,/;

const fileTarget = z.object({
  workspaceId: z.string().min(1).max(512),
  path: z.string().min(1).max(8192),
});

export const openWorkspaceFile = defineRpc({
  name: "file.open-externally",
  input: fileTarget,
  output: z.object({ opened: z.literal(true) }),
});

const fenceSchema = z.object({
  marker: z.string().regex(/^(?:`{3,256}|~{3,256})$/),
  opening: z.string().max(1024),
});
export type Fence = z.infer<typeof fenceSchema>;

const markdownTableLine = z.string().min(1).max(maxMarkdownTableLine).regex(/^[^\r\n]+$/);
const tableContinuation = z.object({ header: markdownTableLine, separator: markdownTableLine });
export type TableContinuation = z.infer<typeof tableContinuation>;

export const readMarkdownPage = defineRpc({
  name: "markdown.page",
  input: fileTarget.extend({
    offset: z.number().int().nonnegative(),
    firstLine: z.number().int().positive().optional(),
    atLine: z.number().int().positive().optional(),
    revision: z.string().max(200).optional(),
    fence: fenceSchema.optional(),
    table: tableContinuation.optional(),
  }),
  output: z.object({
    source: z.string(),
    markdown: z.string(),
    nextOffset: z.number().int().nonnegative().nullable(),
    revision: z.string(),
    offset: z.number().int().nonnegative(),
    firstLine: z.number().int().positive(),
    nextLine: z.number().int().positive(),
    prefixLines: z.number().int().nonnegative(),
    fence: fenceSchema.optional(),
    table: tableContinuation.optional(),
  }),
});

const lineNumber = z.number().int().positive();
const markdownReference = z.object({
  label: z.string(), destination: z.string(), title: z.string().optional(),
});
export type MarkdownReference = z.infer<typeof markdownReference>;

export const readMarkdownInfo = defineRpc({
  name: "markdown.info",
  input: fileTarget,
  output: z.object({
    revision: z.string(),
    lineCount: lineNumber,
    headings: z.array(z.object({ line: lineNumber, anchor: z.string(), title: z.string(), level: z.number().int() })),
    frontMatter: z.array(z.object({ key: z.string(), value: z.string() })),
    frontMatterEnd: z.number().int().nonnegative(),
    references: z.array(markdownReference),
  }),
});

export const readMarkdownSource = defineRpc({
  name: "markdown.source",
  input: fileTarget.extend({ line: lineNumber, through: lineNumber.optional() }),
  output: z.object({
    revision: z.string(),
    firstLine: lineNumber,
    lines: z.array(z.object({ text: z.string(), ending: z.enum(["", "\n", "\r", "\r\n"]), truncated: z.boolean() })),
    nextLine: lineNumber.nullable(),
  }),
});

const markdownSearchOptions = z.object({
  matchCase: z.boolean(), wholeWord: z.boolean(), regex: z.boolean(),
});
export type MarkdownSearchOptions = z.infer<typeof markdownSearchOptions>;

export const searchMarkdownFile = defineRpc({
  name: "markdown.search",
  input: fileTarget.extend({
    query: z.string().min(1).max(256), options: markdownSearchOptions, offset: z.number().int().nonnegative(),
  }),
  output: z.object({
    revision: z.string(),
    hits: z.array(z.object({ line: lineNumber, column: z.number().int().nonnegative(), length: z.number().int().nonnegative() })),
    total: z.number().int().nonnegative(),
    invalidPattern: z.boolean(),
  }),
});

const documentBlock = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("paragraph"), text: z.string(), heading: z.boolean().optional() }),
  z.object({ kind: z.literal("table"), rows: z.array(z.array(z.string())) }),
]);
const documentSection = z.object({ title: z.string().optional(), blocks: z.array(documentBlock) });
export type DocumentBlock = z.infer<typeof documentBlock>;
export type DocumentSection = z.infer<typeof documentSection>;
export const readStructuredDocument = defineRpc({
  name: "document.preview",
  input: fileTarget,
  output: z.object({ sections: z.array(documentSection), truncated: z.boolean() }),
});

const sheetCell = z.tuple([z.number(), z.number(), z.string(), z.number(), z.boolean()]);
const worksheet = z.object({
  columns: z.array(z.number()),
  rows: z.array(z.number()),
  styles: z.array(z.object({
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    color: z.string().optional(),
    fill: z.string().optional(),
    fontSize: z.number().optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    wrap: z.boolean().optional(),
  })),
  cells: z.array(sheetCell),
  merges: z.array(z.tuple([z.number(), z.number(), z.number(), z.number()])),
  truncated: z.boolean(),
});
export type Worksheet = z.infer<typeof worksheet>;
export const readWorksheet = defineRpc({
  name: "office.worksheet",
  input: fileTarget.extend({ sheet: z.number().int().min(0).max(255) }),
  output: z.object({ names: z.array(z.string()), sheet: worksheet }),
});
const worksheetMatch = z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative(),
  z.number().int().nonnegative(), z.number().int().positive()]);
export type WorksheetMatch = z.infer<typeof worksheetMatch>;
export const findWorksheetText = defineRpc({
  name: "office.worksheet-find",
  input: readWorksheet.input.extend({ query: z.string().min(1).max(256), options: markdownSearchOptions }),
  output: z.object({ matches: z.array(worksheetMatch), limited: z.boolean(), invalidPattern: z.boolean() }),
});

export const formulaSchema = z.object({
  tex: z.string().min(1).max(maxFormulaLength),
  display: z.boolean(),
});
export type Formula = z.infer<typeof formulaSchema>;
const formulaPlatform = z.enum(["web", "ios", "android"]);
export type FormulaPlatform = z.infer<typeof formulaPlatform>;
const formulaImage = z.object({
  uris: z.array(z.string().regex(formulaImageUri)).length(1),
  width: z.number().positive(),
  height: z.number().positive(),
  baseline: z.number().optional(),
});
export type FormulaImage = z.infer<typeof formulaImage>;

export const renderFormulas = defineRpc({
  name: "math.render",
  input: z.object({
    color: z.string().regex(/^#[0-9a-f]{6}$/i),
    platform: formulaPlatform,
    formulas: z.array(formulaSchema).min(1).max(formulasPerRequest),
  }),
  output: z.object({ images: z.array(formulaImage.nullable()) }),
});

const pageTarget = fileTarget.extend({
  page: z.number().int().min(1).max(1_000_000),
  pixels: z.number().int().min(256).max(2560),
});
const renderedPage = z.object({
  page: z.number().int().positive(),
  pages: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
  uri: z.string(),
});

const pageRun = z.object({
  count: z.number().int().positive(),
  width: z.number().positive(),
  height: z.number().positive(),
});
export type PageRun = z.infer<typeof pageRun>;

export const readDocumentLayout = defineRpc({
  name: "document.layout",
  input: fileTarget,
  output: z.union([z.array(pageRun).min(1), z.null(), z.literal("loading")]),
});
const pageGlyph = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
export type PageGlyph = z.infer<typeof pageGlyph>;
export const readDocumentText = defineRpc({
  name: "document.text",
  input: fileTarget.extend({ page: lineNumber }),
  output: z.object({ text: z.string(), truncated: z.boolean(), glyphs: z.array(pageGlyph).optional() }).nullable(),
});
const pageTextMatch = z.tuple([lineNumber, z.number().int().nonnegative(), z.number().int().positive()]);
export type PageTextMatch = z.infer<typeof pageTextMatch>;
export const findDocumentText = defineRpc({
  name: "document.find-text",
  input: fileTarget.extend({ query: z.string().min(1).max(256), options: markdownSearchOptions }),
  output: z.object({ matches: z.array(pageTextMatch), limited: z.boolean(), invalidPattern: z.boolean() }).nullable(),
});
export const renderPdfPage = defineRpc({ name: "pdf.page", input: pageTarget, output: renderedPage });
export const renderOfficePage = defineRpc({ name: "office.page", input: pageTarget, output: renderedPage.nullable() });
