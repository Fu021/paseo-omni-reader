import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

const formulaSize = z.string().regex(/^(?:[5-9][0-9]|1[0-9]{2}|200)$/);

export const readerSettings = defineSettings({
  id: "reader",
  scope: "host",
  version: 1,
  schema: z.object({
    inlineFormulaSize: formulaSize.default("100"),
    displayFormulaSize: formulaSize.default("100"),
  }),
});
