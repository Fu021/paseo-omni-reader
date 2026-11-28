import { useMemo } from "react";
import { Text, type TextStyle } from "react-native";
import { refractor } from "refractor";
import latex from "refractor/latex";
import tsx from "refractor/tsx";
import type { Theme } from "./controls";

refractor.register(latex);
refractor.register(tsx);

type SyntaxNode = ReturnType<typeof refractor.highlight>["children"][number];

export const codeFontStyle = { fontFamily: "monospace", fontSize: 13, lineHeight: 21 } as const;

function tokenStyle(classes: unknown, colors: Theme["colors"], hostPalette: boolean): TextStyle | undefined {
  if (!Array.isArray(classes)) return;
  const kind = classes[1];
  if (typeof kind !== "string") return;
  if (hostPalette) {
    const sourceColor = kind === "title" ? "heading" : kind === "url" ? "link" : kind === "code" ? "string"
      : kind === "prolog" ? "comment" : kind === "class-name" ? "class" : kind === "attr-value" ? "string" : kind;
    return {
      color: `var(--colors-syntax-${sourceColor}, ${colors.foreground})`,
      ...(kind === "italic" ? { fontStyle: "italic" } : kind === "bold" ? { fontWeight: "700" } : {}),
    };
  }
  if (kind === "comment" || kind === "punctuation" || kind === "prolog") return { color: colors.foregroundMuted };
  if (kind === "string" || kind === "inserted" || kind === "attr-value") return { color: colors.statusSuccess };
  if (kind === "number" || kind === "constant" || kind === "boolean") return { color: colors.statusWarning };
  if (kind === "deleted") return { color: colors.statusDanger };
  if (kind === "italic") return { fontStyle: "italic" };
  if (kind === "bold" || kind === "title") return { fontWeight: "700", color: colors.accent };
  if (kind === "keyword" || kind === "tag" || kind === "url" || kind === "function" ||
    kind === "class-name" || kind === "property") return { color: colors.accent };
}

function renderSyntax(nodes: readonly SyntaxNode[], colors: Theme["colors"], hostPalette: boolean): React.ReactNode {
  return nodes.map((node, index) => {
    if (node.type === "text") return node.value;
    if (node.type === "element") {
      return <Text key={index} style={tokenStyle(node.properties.className, colors, hostPalette)}>
        {renderSyntax(node.children, colors, hostPalette)}
      </Text>;
    }
    return null;
  });
}

export function Syntax({ source, language, theme, hostPalette = false }: {
  source: string; language: string; theme: Theme; hostPalette?: boolean;
}) {
  const tokens = useMemo(() => {
    const grammar = language.toLowerCase();
    if (source.length > 32_768 || !grammar || !refractor.registered(grammar)) return undefined;
    try { return refractor.highlight(source, grammar).children; } catch { return undefined; }
  }, [source, language]);
  return tokens ? renderSyntax(tokens, theme.colors, hostPalette) : source;
}
