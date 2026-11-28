import type { MarkdownReference } from "../shared/contracts";
import type { rustReader } from "./rust-reader";

type Reader = Awaited<ReturnType<typeof rustReader>>;

export function markdownStructure(reader: Reader, source: string) {
  return JSON.parse(reader.markdownStructure(source)) as {
    tables: [first: number, end: number][];
    references: MarkdownReference[];
  };
}
