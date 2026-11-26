import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginTimelineItemProps, type PluginTimelineTransformerContribution } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, ScrollView, useToast } from "@getpaseo/plugin/client/ui";
import { Image, Platform, Pressable, Text, View, type TextStyle } from "react-native";
import { formulaImageUri, formulasPerRequest, markdownKind, renderFormulas, type Formula, type FormulaImage } from "../shared/contracts";
import { findFormulas, formulaKey, possibleMath } from "../shared/markdown-math";
import { inlineMathMarker, readingBlocks, type InlineMath, type ReadingBlock } from "../shared/reading-blocks";
import { Control, type Theme } from "./controls";
import { messages } from "./messages";
import { NativeMarkdown } from "./native-markdown";
import { bindWebInlineFormulas } from "./web";

const maxMessageSize = 160_000;
const maxDistinctFormulas = 144;

export const transformAssistant: PluginTimelineTransformerContribution<"assistant_message">["transform"] =
  ({ item }) => {
    if (!item.text.trim() || item.text.length > maxMessageSize) return;
    if (/^ {0,3}(?:`{3,}|~{3,})\s*(?:ui|app)\b/m.test(item.text)) return;
    if (!possibleMath.test(item.text) && !/(?:^|\n) {0,3}(?:`{3,}|~{3,})|\|[ \t]*:?-{2,}/.test(item.text)) return;
    return { items: [{ type: "plugin", kind: markdownKind, version: 1, data: { text: item.text } }] };
  };

function batchFormulas(render: (formulas: Formula[]) => Promise<{ images: (FormulaImage | null)[] }>) {
  const pending: {
    formula: Formula;
    resolve: (image: FormulaImage | null) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let scheduled = false;

  async function flush() {
    while (pending.length) {
      const batch = pending.splice(0, formulasPerRequest);
      try {
        const { images } = await render(batch.map(({ formula }) => formula));
        batch.forEach(({ resolve }, index) => resolve(images[index] ?? null));
      } catch (error) {
        batch.forEach(({ reject }) => reject(error));
      }
    }
    scheduled = false;
  }

  return (formula: Formula) => new Promise<FormulaImage | null>((resolve, reject) => {
    pending.push({ formula, resolve, reject });
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { void flush(); });
  });
}

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
  const authored = cell.replace(/!\[(?:\\.|[^\]\\])*\]\(data:image\/(?:png|svg\+xml);base64,[\w+/=]+(?: "[^"]*")?\)/g, "formula")
    .replace(inlineMathMarker, "formula")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  const width = authored.length + (authored.match(/[\u2e80-\uffef]/g)?.length ?? 0);
  return Math.max(100, Math.min(360, width * 7 + 32));
}

function TableBlock({ rows, theme, renderCell }: {
  rows: string[][]; theme: Theme; renderCell?: (cell: string) => React.ReactNode;
}) {
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
              const target = /^!\[(?:\\.|[^\]\\])*\]\(([^ ]+)/.exec(cell)?.[1];
              const formula = target && formulaImageUri.test(target);
              return (
                <View key={column} style={{
                  width: widths[column], minWidth: 0, paddingHorizontal: 12, paddingVertical: 8,
                  borderLeftWidth: column ? 1 : 0, borderLeftColor: theme.colors.border,
                }}>
                  {renderCell ? renderCell(cell) : <Markdown>{formula ? `\u2060${cell}` : cell}</Markdown>}
                </View>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function useCopyFormula() {
  const { t } = useTranslation(messages);
  const toast = useToast();
  return async (tex: string) => {
    try {
      await copyText(tex);
      toast.show(t("copied"), { variant: "success" });
    } catch {
      toast.error(t("formulaCopyError"));
    }
  };
}

function DisplayFormula({ block, theme, onActions }: {
  block: Extract<ReadingBlock, { kind: "formula" }>; theme: Theme; onActions?: (tex: string) => void;
}) {
  const { t } = useTranslation(messages);
  const copy = useCopyFormula();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ minWidth: 0, zIndex: hovered || focused ? 1 : 0 }}>
      <ScrollView
        horizontal nestedScrollEnabled testID="omni-display-math"
        style={{ flexGrow: 0, maxWidth: "100%" }}
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
      >
        {block.image ? (
          <Pressable
            accessibilityRole="button" accessibilityLabel={block.tex}
            accessibilityHint={t(onActions ? "formulaActionHint" : "copyFormula")}
            onPress={onActions ? undefined : () => { void copy(block.tex); }}
            onLongPress={onActions && (() => onActions(block.tex))}
            accessibilityActions={onActions && [{ name: "activate", label: t("formulaActions") }]}
            onAccessibilityAction={onActions && (({ nativeEvent }) => {
              if (nativeEvent.actionName === "activate") onActions(block.tex);
            })}
            onHoverIn={() => setHovered(true)} onHoverOut={() => setHovered(false)}
            onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
          >
            <Image
              source={{ uri: block.image.uris[0] }} resizeMode="contain"
              style={{ width: block.image.width, height: block.image.height, marginVertical: 4 }}
            />
          </Pressable>
        ) : (
          <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace" }}>{block.source}</Text>
        )}
      </ScrollView>
      {Platform.OS === "web" && block.image && (hovered || focused) && (
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{
          position: "absolute", top: "100%", alignSelf: "center", maxWidth: "100%", padding: 8,
          borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface2,
        }}>
          <Text style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 13 }}>{block.tex}</Text>
        </View>
      )}
    </View>
  );
}

function FormulaActions({ tex, theme, compact, close }: {
  tex: string; theme: Theme; compact: boolean; close: () => void;
}) {
  const { t } = useTranslation(messages);
  const copy = useCopyFormula();
  const [showSource, setShowSource] = useState(false);
  return (
    <Modal title={t("formulaActions")} open onOpenChange={(open) => { if (!open) close(); }}>
      <Modal.Content>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          <Control title={t("copyFormula")} theme={theme} compact={compact} onPress={() => { close(); void copy(tex); }} />
          <Control title={t("showFormula")} selected={showSource} theme={theme} compact={compact}
            onPress={() => setShowSource((current) => !current)} />
        </View>
        {showSource && (
          <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 15 }}>{tex}</Text>
        )}
      </Modal.Content>
    </Modal>
  );
}

export function RichMarkdown({ text, theme, compact, hostId }: {
  text: string; theme: Theme; compact: boolean; hostId: string;
}) {
  const { t } = useTranslation(messages);
  const rpc = useRpc(renderFormulas);
  const [selectedFormula, setSelectedFormula] = useState<string | null>(null);
  const root = useRef<View>(null);
  const copyInline = useCopyFormula();
  const copyRef = useRef(copyInline);
  copyRef.current = copyInline;
  const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
  const native = platform !== "web";
  useEffect(() => {
    if (platform === "web") return bindWebInlineFormulas(root.current, (tex) => { void copyRef.current(tex); });
  }, [platform]);
  const color = asRgb(theme.colors.foreground);
  const request = useMemo(() => batchFormulas((formulas) => rpc({ color, platform, formulas })), [rpc, color, platform]);
  const spans = useMemo(() => findFormulas(text), [text]);
  const formulas = useMemo(() => {
    const unique = new Map<string, Formula>();
    for (const span of spans) {
      if (unique.size >= maxDistinctFormulas) break;
      unique.set(formulaKey(span), { tex: span.tex, display: span.display });
    }
    return [...unique.values()];
  }, [spans]);
  const combine = useCallback((queries: readonly {
    data?: FormulaImage | null; isError: boolean; isFetching: boolean; refetch: () => Promise<unknown>;
  }[]) => {
    const images = new Map<string, FormulaImage | null>();
    const failed = queries.filter((query, index) => {
      if (query.data) images.set(formulaKey(formulas[index]), query.data);
      return query.isError || query.data === null;
    });
    const nativeMath: InlineMath[] = [];
    return {
      blocks: readingBlocks(text, spans, images, !native, native ? nativeMath : undefined),
      nativeMath,
      retries: failed.map((query) => query.refetch),
      retrying: failed.some((query) => query.isFetching),
    };
  }, [formulas, native, spans, text]);
  const { blocks, nativeMath, retries, retrying } = useQueries({
    queries: formulas.map((formula) => ({
      queryKey: ["omni-reader", "math-v2", hostId, color, platform, formulaKey(formula)],
      queryFn: () => request(formula),
      staleTime: Infinity,
      gcTime: 90_000,
      retry: false,
      retryOnMount: false,
    })),
    combine,
  });
  const renderNative = (markdown: string) => (
    <NativeMarkdown text={markdown} formulas={nativeMath} theme={theme} onActions={setSelectedFormula} />
  );
  return (
    <View ref={root} testID="omni-markdown" style={{ minWidth: 0, gap: compact ? 12 : 16 }}>
      {blocks.map((block, index) => {
        if (block.kind === "markdown") return native
          ? <View key={index} style={{ gap: 8 }}>{renderNative(block.text)}</View>
          : <Markdown key={index}>{block.text}</Markdown>;
        if (block.kind === "code") return <CodeBlock key={index} block={block} theme={theme} compact={compact} />;
        if (block.kind === "table") return <TableBlock key={index} rows={block.rows} theme={theme} renderCell={native ? renderNative : undefined} />;
        return <DisplayFormula key={`${index}:${block.tex}`} block={block} theme={theme} onActions={native ? setSelectedFormula : undefined} />;
      })}
      {retries.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
          <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            {t("formulaError")}
          </Text>
          <Control title={t("retryRendering")} theme={theme} compact={compact} disabled={retrying}
            onPress={() => { void Promise.allSettled(retries.map((retry) => retry())); }} />
        </View>
      )}
      {selectedFormula !== null && (
        <FormulaActions tex={selectedFormula} theme={theme} compact={compact} close={() => setSelectedFormula(null)} />
      )}
    </View>
  );
}

export function AssistantReader({ item, theme, layout, host }: PluginTimelineItemProps<{ text: string }>) {
  return <RichMarkdown text={item.data.text} theme={theme} compact={layout.compact} hostId={host.id} />;
}
