import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const markdownExtensions = ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"];
export const officeExtensions = ["docx", "xlsx", "pptx"];
export const markdownKind = "rich-assistant-markdown";
export const messageSchema = z.object({
  text: z.string(),
  phase: z.enum(["streaming", "complete"]).optional(),
  messageId: z.string().optional(),
  plain: z.literal(true).optional(),
});
export const maxFormulaLength = 2400;
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

export const maxMarkdownTableLine = 8192;
const markdownTableLine = z.string().min(1).max(maxMarkdownTableLine).regex(/^[^\r\n]+$/);
const tableContinuation = z.object({ header: markdownTableLine, separator: markdownTableLine });
export type TableContinuation = z.infer<typeof tableContinuation>;

export const readMarkdownPage = defineRpc({
  name: "markdown.page",
  input: fileTarget.extend({
    offset: z.number().int().nonnegative(),
    revision: z.string().max(200).optional(),
    fence: fenceSchema.optional(),
    table: tableContinuation.optional(),
  }),
  output: z.object({
    source: z.string(),
    markdown: z.string(),
    nextOffset: z.number().int().nonnegative().nullable(),
    revision: z.string(),
    fence: fenceSchema.optional(),
    table: tableContinuation.optional(),
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
  output: z.array(pageRun).min(1).nullable(),
});
export const renderPdfPage = defineRpc({ name: "pdf.page", input: pageTarget, output: renderedPage });
export const renderOfficePage = defineRpc({ name: "office.page", input: pageTarget, output: renderedPage.nullable() });
