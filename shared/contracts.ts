import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const markdownExtensions = ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn"];
export const textExtensions = ["txt", "text", "log"];
export const markdownKind = "rich-assistant-markdown";
export const messageSchema = z.object({ text: z.string() });
export const maxFormulaLength = 2400;
export const formulasPerRequest = 12;

const fileTarget = z.object({
  workspaceId: z.string().min(1).max(512),
  path: z.string().min(1).max(8192),
});

export const fenceSchema = z.object({
  marker: z.string().regex(/^(?:`{3,256}|~{3,256})$/),
  opening: z.string().max(1024),
});
export type Fence = z.infer<typeof fenceSchema>;

export const readTextPage = defineRpc({
  name: "text.page",
  input: fileTarget.extend({
    offset: z.number().int().nonnegative(),
    revision: z.string().max(200).optional(),
    fence: fenceSchema.optional(),
  }),
  output: z.object({
    source: z.string(),
    markdown: z.string(),
    size: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
    revision: z.string(),
    fence: fenceSchema.optional(),
  }),
});

export const formulaSchema = z.object({
  tex: z.string().min(1).max(maxFormulaLength),
  display: z.boolean(),
});
export type Formula = z.infer<typeof formulaSchema>;
const formulaPlatform = z.enum(["web", "ios", "android"]);
export type FormulaPlatform = z.infer<typeof formulaPlatform>;
const formulaImage = z.object({
  uris: z.array(z.string()).min(1).max(14),
  width: z.number().positive(),
  height: z.number().positive(),
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

export const renderPdfPage = defineRpc({
  name: "pdf.page",
  input: fileTarget.extend({
    page: z.number().int().min(1).max(1_000_000),
    pixels: z.number().int().min(256).max(2560),
  }),
  output: z.object({
    page: z.number().int().positive(),
    pages: z.number().int().positive(),
    width: z.number().positive(),
    height: z.number().positive(),
    uri: z.string(),
  }),
});
