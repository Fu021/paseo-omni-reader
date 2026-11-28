import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  useRpc, useSettings, useTranslation, type PluginClientContext, type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { copyText, Icon, Markdown, ScrollView, StreamedText, useToast } from "@getpaseo/plugin/client/ui";
import { Image, Modal, Platform, Pressable, SafeAreaView, ScrollView as NativeScrollView, Text, View, useWindowDimensions, type LayoutChangeEvent, type TextStyle } from "react-native";
import { formulaImageUri, formulasPerRequest, markdownKind, messageSchema, renderFormulas, type Formula, type FormulaImage } from "../shared/contracts";
import { findFormulas, formulaKey, formulaTitlePattern, markdownParser } from "../shared/markdown-math";
import { inlineMathMarker, inlineMathReferenceFontSize, readingBlocks, type ColumnAlignment, type InlineMath, type ReadingBlock } from "../shared/reading-blocks";
import { inlineReferenceLinks } from "../shared/markdown-references";
import { readerSettings } from "../shared/reader-settings";
import { Control, type Theme } from "./controls";
import { assistantReplacement, assistantReplyKey, shouldReplaceAssistant } from "./assistant-turn";
import { messages } from "./messages";
import { NativeMarkdown } from "./native-markdown";
import { useReaderNotice } from "./reader-notice";
import { Syntax, codeFontStyle } from "./syntax";
import { bindWebFormulas, webTableStyles } from "./web";

const maxDistinctFormulas = 144;
const inlineFormulaBaseScale = 0.5865;
const displayFormulaBaseScale = 0.85;
const displayMathWebReferenceFontSize = 15;

export function registerAssistantReading(client: PluginClientContext): () => void {
  const restored = new Set<string>();

  const removeRenderer = client.addTimelineRenderer({
    kind: markdownKind, version: 1, schema: messageSchema,
    Component: (props) => <AssistantReader {...props} restored={restored} />,
  });
  const removeTransformer = client.addTimelineTransformer({
    id: "assistant-math", query: { itemType: "assistant_message" },
    transform(input) {
      if (shouldReplaceAssistant(input.item.text)) return assistantReplacement(input);
    },
  });
  return () => {
    removeTransformer();
    removeRenderer();
    restored.clear();
  };
}

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

const CodeBlock = memo(function CodeBlock({ block, theme, compact }: {
  block: Extract<ReadingBlock, { kind: "code" }>; theme: Theme; compact: boolean;
}) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const notify = useReaderNotice();
  const copy = async () => {
    try {
      await copyText(block.text);
      if (notify) notify(t("copied"));
      else toast.show(t("copied"), { variant: "success" });
    } catch {
      if (notify) notify(t("copyError"), true);
      else toast.error(t("copyError"));
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
          codeFontStyle, { color: theme.colors.foreground },
          Platform.OS === "web" && ({ whiteSpace: "pre" } as TextStyle),
        ]}><Syntax source={block.text} language={block.language} theme={theme} /></Text>
      </ScrollView>
    </View>
  );
});

const tableCellLimit = 360;
const tableCellPadding = 12;
const webMathInCell = /!\[(?:\\.|[^\]\\])*\]\(data:image\/(?:png|svg\+xml);base64,[\w+/=]+ "(omni-latex:[^"]+)"\)/g;

function webCellLimit(rows: string[][], column: number, textScale: number): number {
  let widest = tableCellLimit;
  for (const row of rows) {
    for (const [, title] of (row[column] ?? "").matchAll(webMathInCell)) {
      const dimensions = formulaTitlePattern.exec(title);
      if (dimensions) widest = Math.max(widest, Math.ceil(Number(dimensions[1]) * textScale));
    }
  }
  return widest;
}

function nativeCellWidth(cell: string, formulas: InlineMath[], textScale: number): number {
  let totalMathWidth = 0;
  let widestFormula = 0;
  const authored = cell.replace(inlineMathMarker, (_, id) => {
    const width = (formulas[Number(id)]?.image.width ?? 0) * textScale;
    totalMathWidth += width;
    widestFormula = Math.max(widestFormula, width);
    return "";
  });
  const tokens = markdownParser.parseInline(authored, {})[0]?.children ?? [];
  let textWidth = 0;
  for (const token of tokens) {
    if (token.nesting !== 0) continue;
    for (const char of token.content) {
      if (/[\u2e80-\uffef]|\p{Extended_Pictographic}/u.test(char)) textWidth += 1;
      else if (/[\s.,:;!|ilI]/.test(char)) textWidth += 0.34;
      else if (/[A-Z@%]/.test(char)) textWidth += 0.72;
      else textWidth += 0.58;
    }
  }
  const preferredWidth = textWidth * inlineMathReferenceFontSize * textScale + totalMathWidth;
  return Math.ceil(Math.max(widestFormula, Math.min(tableCellLimit, preferredWidth))) + tableCellPadding * 2 + 2;
}

const TableBlock = memo(function TableBlock({ block: { rows, alignment }, theme, formulas, textScale, renderCell }: {
  block: Extract<ReadingBlock, { kind: "table" }>; theme: Theme; formulas: InlineMath[]; textScale: number;
  renderCell?: (cell: string, align?: ColumnAlignment) => React.ReactNode;
}) {
  const web = Platform.OS === "web";
  const columns = useMemo(() => rows[0]?.map((_, column) => web
    ? webCellLimit(rows, column, textScale)
    : rows.reduce((width, row) => Math.max(width, nativeCellWidth(row[column] ?? "", formulas, textScale)), 0)
  ) ?? [], [rows, formulas, textScale, web]);
  return (
    <ScrollView horizontal nestedScrollEnabled testID="omni-table-scroll"
      keyboardShouldPersistTaps={web ? undefined : "always"}
      decelerationRate={web ? undefined : "fast"}
      bounces={web ? undefined : false}
      style={{ alignSelf: "center", flexGrow: 0, maxWidth: "100%" }}>
      <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, overflow: "hidden" }}>
        <View role={web ? "table" : undefined} style={web && webTableStyles.table}>
          {rows.map((row, index) => (
            <View key={index} role={web ? "row" : undefined} style={[
              { flexDirection: "row", backgroundColor: !index ? theme.colors.surface2 : index % 2 ? theme.colors.surface0 : theme.colors.surface1 },
              web && webTableStyles.row,
            ]}>
              {row.map((cell, column) => {
                const target = /^!\[(?:\\.|[^\]\\])*\]\(([^ ]+)/.exec(cell)?.[1];
                const formula = target && formulaImageUri.test(target);
                return (
                  <View key={column} role={web ? index ? "cell" : "columnheader" : undefined} style={[
                    {
                      width: web ? undefined : columns[column], minWidth: 0, justifyContent: "center",
                      paddingHorizontal: tableCellPadding, paddingVertical: 8,
                      borderTopWidth: index ? 1 : 0, borderLeftWidth: column ? 1 : 0, borderColor: theme.colors.border,
                    },
                    web && [webTableStyles.cell, { textAlign: alignment[column] } as TextStyle],
                  ]}>
                    {renderCell ? renderCell(cell, alignment[column]) : (
                      <View style={{ maxWidth: columns[column] }}>
                        <Markdown>{formula ? `\u2060${cell}` : cell}</Markdown>
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </View>
    </ScrollView>
  );
});

function useCopyFormula() {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const notify = useReaderNotice();
  return useCallback(async (tex: string, showToast = true) => {
    try {
      await copyText(tex);
      if (showToast) {
        if (notify) notify(t("copied"));
        else toast.show(t("copied"), { variant: "success" });
      }
      return true;
    } catch {
      if (showToast) {
        if (notify) notify(t("formulaCopyError"), true);
        else toast.error(t("formulaCopyError"));
      }
      return false;
    }
  }, [t, toast, notify]);
}

function DisplayFormula({ block, theme, scale, onCopy }: {
  block: Extract<ReadingBlock, { kind: "formula" }>; theme: Theme; scale: number; onCopy?: (math: InlineMath) => void;
}) {
  const { t } = useTranslation(messages);
  const copy = useCopyFormula();
  const math = block.image && { tex: block.tex, image: block.image };
  return (
    <View style={{ minWidth: 0 }}>
      <ScrollView
        horizontal nestedScrollEnabled testID="omni-display-math"
        style={{ flexGrow: 0, maxWidth: "100%" }}
        contentContainerStyle={{ flexGrow: 1, alignItems: "center", justifyContent: "center" }}
      >
        {math ? (
          <Pressable
            testID="omni-display-formula"
            accessibilityRole="button" accessibilityLabel={block.tex}
            accessibilityHint={t(onCopy ? "formulaCopyHint" : "copyFormula")}
            onPress={onCopy ? () => onCopy(math) : () => { void copy(block.tex); }}
            style={Platform.OS === "web" ? { cursor: "pointer" } : undefined}
          >
            <Image
              source={{ uri: math.image.uris[0] }} resizeMode="contain"
              style={{ width: math.image.width * scale, height: math.image.height * scale, marginVertical: 4 }}
            />
          </Pressable>
        ) : (
          <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace" }}>{block.source}</Text>
        )}
      </ScrollView>
    </View>
  );
}

type FormulaSelection = { formula: InlineMath; status: "copying" | "copied" | "failed" };

function FormulaPreview({ selection, theme, copy, close }: {
  selection: FormulaSelection; theme: Theme; copy: (formula: InlineMath) => void; close: () => void;
}) {
  const { t } = useTranslation(messages);
  const { formula: { tex, image }, status } = selection;
  const [dismissedCopy, setDismissedCopy] = useState<FormulaSelection | null>(null);
  useEffect(() => {
    if (selection.status !== "copied") return;
    const timer = setTimeout(() => setDismissedCopy(selection), 2200);
    return () => clearTimeout(timer);
  }, [selection]);
  const { height, width } = useWindowDimensions();
  const cardWidth = Math.min(400, width - 32);
  const previewScale = Math.min(1.6, (cardWidth - 32) / image.width, height * 0.35 / image.height);
  return (
    <Modal transparent animationType="none" visible onRequestClose={close}
      supportedOrientations={["portrait", "landscape"]}>
      <View accessibilityViewIsModal onAccessibilityEscape={close}
        style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Pressable accessible={false} onPress={close}
          style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.45)" }} />
        <View testID="omni-formula-preview" style={{
          width: cardWidth, gap: 10, padding: 16, borderRadius: 12,
          backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border,
        }}>
          <Image accessible={false} fadeDuration={0} source={{ uri: image.uris[0] }} resizeMode="contain"
            style={{ alignSelf: "center", width: image.width * previewScale, height: image.height * previewScale }} />
          <NativeScrollView horizontal style={{ flexGrow: 0 }}
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}>
            <Text numberOfLines={1} accessibilityLabel={tex} style={{
              color: theme.colors.foreground, fontFamily: "monospace", fontSize: 14,
            }}>{tex.replace(/\r\n?|\n/g, " ")}</Text>
          </NativeScrollView>
          {status === "failed" && (
            <Text accessibilityRole="alert" style={{ color: theme.colors.foregroundMuted, textAlign: "center" }}>
              {t("formulaCopyError")}
            </Text>
          )}
          <View style={{ alignItems: "center" }}>
            <Control title={t("copyFormula")}
              theme={theme} compact disabled={status === "copying"} onPress={() => copy({ tex, image })} />
          </View>
        </View>
        {status === "copied" && dismissedCopy !== selection && (
          <SafeAreaView pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
            <View style={{
              alignSelf: "center", marginTop: 12, borderRadius: 16, borderWidth: 1, borderColor: theme.colors.border,
              paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", alignItems: "center", gap: 8,
              backgroundColor: theme.colors.surface0,
            }}>
              <Icon name="CheckCircle2" size={18} color={theme.colors.accent} />
              <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foreground }}>{t("copied")}</Text>
            </View>
          </SafeAreaView>
        )}
      </View>
    </Modal>
  );
}

export const RichMarkdown = memo(function RichMarkdown({ text: authored, theme, compact, hostId, anchors }: {
  text: string; theme: Theme; compact: boolean; hostId: string; anchors?: ReadonlyMap<string, () => void>;
}) {
  const text = useMemo(() => inlineReferenceLinks(authored), [authored]);
  const { t } = useTranslation(messages);
  const rpc = useRpc(renderFormulas);
  const settings = useSettings(readerSettings);
  const sizes = settings.status === "ready" ? settings.values : null;
  const inlineScale = inlineFormulaBaseScale * (Number(sizes?.inlineFormulaSize ?? 100) / 100);
  const platform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";
  const native = platform !== "web";
  const bodyReferenceSize = native ? inlineMathReferenceFontSize : displayMathWebReferenceFontSize;
  const { fontScale } = useWindowDimensions();
  const [bodySize, setBodySize] = useState(bodyReferenceSize);
  const fontWidths = useRef({ content: 0, reference: 0 });
  const measureFont = useCallback((sample: keyof typeof fontWidths.current, event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width <= 0 || width === fontWidths.current[sample]) return;
    fontWidths.current[sample] = width;
    const { content, reference } = fontWidths.current;
    if (content && reference) setBodySize(Math.round(bodyReferenceSize * content / reference));
  }, [bodyReferenceSize]);
  const measureContent = useCallback((event: LayoutChangeEvent) => measureFont("content", event), [measureFont]);
  const measureReference = useCallback((event: LayoutChangeEvent) => measureFont("reference", event), [measureFont]);
  const effectiveBodySize = bodySize * (native ? fontScale : 1);
  const displayScale = displayFormulaBaseScale * (Number(sizes?.displayFormulaSize ?? 100) / 100)
    * effectiveBodySize / bodyReferenceSize;
  const [selectedFormula, setSelectedFormula] = useState<FormulaSelection | null>(null);
  const root = useRef<View>(null);
  const copy = useCopyFormula();
  const showAndCopyFormula = useCallback((formula: InlineMath) => {
    const selection: FormulaSelection = { formula, status: "copying" };
    setSelectedFormula(selection);
    void copy(formula.tex, false).then((copied) => {
      setSelectedFormula((current) =>
        current === selection ? { formula, status: copied ? "copied" : "failed" } : current);
    });
  }, [copy]);
  const webActions = useRef({ copy, colors: theme.colors });
  webActions.current = { copy, colors: theme.colors };
  useEffect(() => {
    if (platform === "web") return bindWebFormulas(root.current, {
      copy: (tex) => { void webActions.current.copy(tex); },
      colors: () => webActions.current.colors,
    });
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
      blocks: readingBlocks(text, spans, images, !native, native ? nativeMath : undefined, inlineScale),
      nativeMath,
      retries: failed.map((query) => query.refetch),
      retrying: failed.some((query) => query.isFetching),
    };
  }, [formulas, inlineScale, native, spans, text]);
  const queries = useMemo(() => formulas.map((formula) => ({
    queryKey: ["omni-reader", "math-v4", hostId, color, platform, formulaKey(formula)],
    queryFn: () => request(formula),
    staleTime: Infinity,
    gcTime: 90_000,
    retry: false,
    retryOnMount: false,
  })), [color, formulas, hostId, platform, request]);
  const { blocks, nativeMath, retries, retrying } = useQueries({ queries, combine });
  const renderNative = useCallback((markdown: string, align?: ColumnAlignment) => (
    <NativeMarkdown text={markdown} formulas={nativeMath} theme={theme} onCopy={showAndCopyFormula} anchors={anchors}
      bodySize={bodySize} fontScale={fontScale} align={align} />
  ), [anchors, bodySize, fontScale, nativeMath, showAndCopyFormula, theme]);
  return (
    <View ref={root} testID="omni-markdown" style={{ minWidth: 0, gap: compact ? 12 : 16 }}>
      {(nativeMath.length > 0 || anchors?.size || blocks.some((block) => block.kind === "table" || block.kind === "formula")) ? (
        <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", width: 0, height: 0, overflow: "hidden", opacity: 0 }}>
          <View style={{ width: 256, alignItems: "flex-start" }}>
            <StreamedText text="00000000" phase="complete" numberOfLines={1} allowFontScaling={false}
              onLayout={measureContent} />
            <StreamedText text="00000000" phase="complete" numberOfLines={1} allowFontScaling={false}
              style={{ fontSize: bodyReferenceSize }}
              onLayout={measureReference} />
          </View>
        </View>
      ) : null}
      {blocks.map((block, index) => {
        if (block.kind === "markdown") return native
          ? <View key={index} style={{ gap: 8 }}>{renderNative(block.text)}</View>
          : <Markdown key={index}>{block.text}</Markdown>;
        if (block.kind === "code") return <CodeBlock key={index} block={block} theme={theme} compact={compact} />;
        if (block.kind === "table") return (
          <TableBlock key={index} block={block} theme={theme}
            formulas={nativeMath} textScale={effectiveBodySize / inlineMathReferenceFontSize}
            renderCell={native ? renderNative : undefined} />
        );
        return <DisplayFormula key={`${index}:${block.tex}`} block={block} theme={theme} scale={displayScale}
          onCopy={native ? showAndCopyFormula : undefined} />;
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
        <FormulaPreview selection={selectedFormula} theme={theme}
          copy={showAndCopyFormula} close={() => setSelectedFormula(null)} />
      )}
    </View>
  );
});

function AssistantReader({ item, theme, layout, host, agentId, restored }:
  PluginTimelineItemProps<ReturnType<typeof messageSchema.parse>> & { restored: Set<string> }) {
  const { text, phase, messageId } = item.data;
  const replyKey = messageId || phase !== "streaming"
    ? JSON.stringify([host.id, agentId, assistantReplyKey({ text, messageId })])
    : null;
  const [plainOverride, setPlainOverride] = useState<boolean>();
  const plain = plainOverride ?? (replyKey !== null && restored.has(replyKey));
  useEffect(() => {
    if (replyKey === null || plainOverride === undefined) return;
    if (plainOverride) restored.add(replyKey);
    else restored.delete(replyKey);
  }, [plainOverride, replyKey, restored]);
  const { t } = useTranslation(messages);
  const label = t(plain ? "resumeRendering" : "restoreReply");
  return (
    <>
      {plain ? <Markdown>{text}</Markdown>
        : <RichMarkdown text={text} theme={theme} compact={layout.compact} hostId={host.id} />}
      <Pressable testID="omni-reply-mode" accessibilityRole="button" accessibilityLabel={label}
        hitSlop={4} onPress={() => setPlainOverride(!plain)} style={({ pressed }) => ({
          alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4,
          marginTop: 8, height: 28, paddingHorizontal: 4, borderRadius: 6,
          backgroundColor: pressed ? theme.colors.surface2 : "transparent",
        })}>
        <Icon name={plain ? "Sigma" : "CodeXml"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
      </Pressable>
    </>
  );
}
