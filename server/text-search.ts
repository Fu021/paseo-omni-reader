import type { MarkdownSearchOptions } from "../shared/contracts";

export function searchExpression(query: string, options: MarkdownSearchOptions, flexibleWhitespace = false) {
  let pattern = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!options.regex && flexibleWhitespace) pattern = pattern.replace(/\s+/g, "\\s+");
  if (options.wholeWord) {
    const word = "[\\p{L}\\p{M}\\p{N}_]";
    pattern = `(?<!${word})(?:${pattern})(?!${word})`;
  }
  try {
    return new RegExp(pattern, options.matchCase ? "gu" : "giu");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}
