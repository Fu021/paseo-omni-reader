import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginTimelineItemProps, type PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { copyText, Markdown, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { Image, Platform, Text, View, type TextStyle } from "react-native";
import { formulasPerRequest, markdownKind, renderFormulas, type Formula, type FormulaImage } from "../shared/contracts";
import { findFormulas, formulaKey, possibleMath } from "../shared/markdown-math";
import { readingBlocks, type ReadingBlock } from "../shared/reading-blocks";
import { Control, type Theme } from "./controls";
import { messages } from "./messages";

const maxMessageSize = 160_000;
const maxDistinctFormulas = 144;

export const transformAssistant: PluginTimelineTransformerContribution<"assistant_message">["transform"] =
  ({ item, phase }) => {
    if (phase !== "complete" || item.text.length > maxMessageSize) return;
    if (/^ {0,3}(?:`{3,}|~{3,})\s*(?:ui|app)\b/m.test(item.text)) return;
    if (!possibleMath.test(item.text) && !/(?:^|\n) {0,3}(?:`{3,}|~{3,})|\|[ \t]*:?-{2,}/.test(item.text)) return;
    return { items: [{ type: "plugin", kind: markdownKind, version: 1, data: { text: item.text } }] };
  };

function asRgb(color: string): string {
  if (/^#[\da-f]{6}$/i.test(color)) return color;
  if (/^#[\da-f]{3}$/i.test(color)) return color.replace(/[\da-f]/gi, "$&$&");
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(color);
  if (rgb) return "#" + rgb.slice(1).map((channel) => Math.min(255, Number(channel)).toString(16).padStart(2, "0")).join("");
  return "#16181a";
}

function CodeBlock({ block, theme, compact }: {
  block: Extract<ReadingBlock, { kind: "code" }>; theme: Theme; compact: boolean;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const copy = async () => {
    try {
      await copyText(block.text);
      toast.show(t("copied"), { variant: "success" });
    } catch {
      toast.error(t("copyError"));
    }
  };
  return (
    <View style={{
      minWidth: 0, borderColor: theme.colors.border, borderWidth: 1, borderRadius: 8,
      backgroundColor: theme.colors.surface1, overflow: "hidden",
    }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{block.language}</Text>
        <Control title={t("copyCode")} theme={theme} compact={compact} onPress={() => { void copy(); }} />
      </View>
      <ScrollView
        horizontal nestedScrollEnabled testID="omni-code-scroll"
        style={{ flexGrow: 0, maxWidth: "100%" }}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12 }}
      >
        <Text selectable style={[
          { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13, lineHeight: 20 },
          Platform.OS === "web" && ({ whiteSpace: "pre" } as TextStyle),
        ]}>{block.text}</Text>
      </ScrollView>
    </View>
  );
}

function tableWidth(cell: string): number {
  const authored = cell.replace(/!\[[^\]]*\]\(data:image\/png;base64,[^)]+\)/g, "formula")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const width = authored.length + (authored.match(/[\u2e80-\uffef]/g)?.length ?? 0);
  return Math.max(100, Math.min(360, width * 7 + 32));
}

function TableBlock({ rows, theme }: { rows: string[][]; theme: Theme }) {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map((row) => tableWidth(row[column] ?? "")))) ?? [];
  return (
    <ScrollView horizontal nestedScrollEnabled testID="omni-table-scroll" style={{ flexGrow: 0, maxWidth: "100%" }}>
      <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" }}>
        {rows.map((row, index) => (
          <View key={index} style={{
            flexDirection: "row", borderTopWidth: index ? 1 : 0, borderTopColor: theme.colors.border,
            backgroundColor: !index ? theme.colors.surface2 : index % 2 ? theme.colors.surface0 : theme.colors.surface1,
          }}>
            {row.map((cell, column) => {
              const formula = /^!\[.*\]\(data:image\/png;base64,/.test(cell);
              return (
                <View key={column} style={{
                  width: widths[column], minWidth: 0, paddingHorizontal: 12, paddingVertical: 8,
                  borderLeftWidth: column ? 1 : 0, borderLeftColor: theme.colors.border,
                }}>
                  <Markdown>{formula ? `\u2060${cell}` : cell}</Markdown>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

export function RichMarkdown({ text, theme, compact }: { text: string; theme: Theme; compact: boolean }) {
  const rpc = useRpc(renderFormulas);
  const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
  const color = asRgb(theme.colors.foreground);
  const spans = useMemo(() => findFormulas(text), [text]);
  const batches = useMemo(() => {
    const unique = new Map<string, Formula>();
    for (const span of spans) {
      if (unique.size >= maxDistinctFormulas) break;
      unique.set(formulaKey(span), { tex: span.tex, display: span.display });
    }
    const formulas = [...unique.values()];
    const groups: Formula[][] = [];
    for (let start = 0; start < formulas.length; start += formulasPerRequest) {
      groups.push(formulas.slice(start, start + formulasPerRequest));
    }
    return groups;
  }, [spans]);
  const combine = useCallback((queries: readonly { data?: { images: (FormulaImage | null)[] } }[]) => {
    const images = new Map<string, FormulaImage | null>();
    for (const [index, query] of queries.entries()) {
      const formulas = batches[index];
      query.data?.images.forEach((image, offset) => {
        if (formulas[offset]) images.set(formulaKey(formulas[offset]), image);
      });
    }
    return readingBlocks(text, spans, images);
  }, [batches, spans, text]);
  const blocks = useQueries({
    queries: batches.map((formulas) => ({
      queryKey: ["omni-reader", "math", color, platform, formulas],
      queryFn: () => rpc({ color, platform, formulas }),
      staleTime: Infinity,
      gcTime: 90_000,
      retry: false,
    })),
    combine,
  });
  return (
    <View testID="omni-markdown" style={{ minWidth: 0, gap: compact ? 12 : 16 }}>
      {blocks.map((block, index) => {
        if (block.kind === "markdown") return <Markdown key={index}>{block.text}</Markdown>;
        if (block.kind === "code") return <CodeBlock key={index} block={block} theme={theme} compact={compact} />;
        if (block.kind === "table") return <TableBlock key={index} rows={block.rows} theme={theme} />;
        return (
          <ScrollView key={index} horizontal nestedScrollEnabled testID="omni-display-math" style={{ flexGrow: 0, maxWidth: "100%" }}>
            <Image
              accessible accessibilityLabel={block.tex} source={{ uri: block.image.uris[0] }} resizeMode="contain"
              style={{ width: block.image.width, height: block.image.height, marginVertical: 4 }}
            />
          </ScrollView>
        );
      })}
    </View>
  );
}

export function AssistantReader({ item, theme, layout }: PluginTimelineItemProps<{ text: string }>) {
  return <RichMarkdown text={item.data.text} theme={theme} compact={layout.compact} />;
}
