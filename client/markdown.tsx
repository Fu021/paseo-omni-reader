import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  useRpc, useSettings, useTranslation, type PluginClientContext, type PluginTimelineItemProps,
} from "@getpaseo/plugin/client";
import { copyText, Icon, Markdown, StreamedText, useToast } from "@getpaseo/plugin/client/ui";
import { Image, Modal, Platform, Pressable, ScrollView as NativeScrollView, Text, View, useWindowDimensions, type LayoutChangeEvent, type TextStyle } from "react-native";
import { formulaImageUri, formulasPerRequest, markdownKind, messageSchema, renderFormulas, type Formula, type FormulaImage } from "../shared/contracts";
import { findFormulas, formulaKey, formulaTitlePattern, markdownParser } from "../shared/markdown-math";
import { inlineMathMarker, inlineMathReferenceFontSize, readingBlocks, type InlineMath, type ReadingBlock } from "../shared/reading-blocks";
import { readerSettings } from "../shared/reader-settings";
import { Control, type Theme } from "./controls";
import { assistantReplacement, assistantReplyKey, shouldReplaceAssistant, type AssistantReply } from "./assistant-turn";
import { messages } from "./messages";
import { NativeMarkdown } from "./native-markdown";
import { ReaderScrollView as ScrollView } from "./reader-scroll";
import { bindWebFormulas, webTableStyles } from "./web";

const maxDistinctFormulas = 144;
const inlineFormulaBaseScale = 0.51;
const displayMathWebReferenceFontSize = 15;

export function registerAssistantReading(client: PluginClientContext): () => void {
  const restored = new Set<string>();

  function registerTransformer() {
    return client.addTimelineTransformer({
      id: "assistant-math", query: { itemType: "assistant_message" },
      transform(input) {
        if (!shouldReplaceAssistant(input.item.text)) return;
        return assistantReplacement(input, restored.has(assistantReplyKey(input.item)));
      },
    });
  }

  function setOriginalReply(reply: AssistantReply, original: boolean) {
    const key = assistantReplyKey(reply);
    if (restored.has(key) === original) return;
    if (original) restored.add(key);
    else restored.delete(key);
    removeTransformer();
    removeTransformer = registerTransformer();
  }

  const removeRenderer = client.addTimelineRenderer({
    kind: markdownKind, version: 1, schema: messageSchema,
    Component: (props) => <AssistantReader {...props} setOriginalReply={setOriginalReply} />,
  });
  let removeTransformer = registerTransformer();
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

const TableBlock = memo(function TableBlock({ rows, theme, formulas, textScale, renderCell }: {
  rows: string[][]; theme: Theme; formulas: InlineMath[]; textScale: number; renderCell?: (cell: string) => React.ReactNode;
}) {
  const web = Platform.OS === "web";
  const columns = useMemo(() => rows[0]?.map((_, column) => web
    ? webCellLimit(rows, column, textScale)
    : rows.reduce((width, row) => Math.max(width, nativeCellWidth(row[column] ?? "", formulas, textScale)), 0)
  ) ?? [], [rows, formulas, textScale, web]);
  return (
    <ScrollView horizontal nestedScrollEnabled testID="omni-table-scroll"
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
                    web && webTableStyles.cell,
                  ]}>
                    {renderCell ? renderCell(cell) : (
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
  return async (tex: string) => {
    try {
      await copyText(tex);
      toast.show(t("copied"), { variant: "success" });
    } catch {
      toast.error(t("formulaCopyError"));
    }
  };
}

function DisplayFormula({ block, theme, scale, onActions }: {
  block: Extract<ReadingBlock, { kind: "formula" }>; theme: Theme; scale: number; onActions?: (math: InlineMath) => void;
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
            accessibilityHint={t(onActions ? "formulaActionHint" : "copyFormula")}
            onPress={onActions ? undefined : () => { void copy(block.tex); }}
            onLongPress={onActions && (() => onActions(math))}
            accessibilityActions={onActions && [{ name: "activate", label: t("formulaActions") }]}
            onAccessibilityAction={onActions && (({ nativeEvent }) => {
              if (nativeEvent.actionName === "activate") onActions(math);
            })}
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

function FormulaActions({ formula: { tex, image }, theme, compact, close }: {
  formula: InlineMath; theme: Theme; compact: boolean; close: () => void;
}) {
  const { t } = useTranslation(messages);
  const copy = useCopyFormula();
  const [showSource, setShowSource] = useState(false);
  const { height, width } = useWindowDimensions();
  const cardWidth = Math.min(400, width - 32);
  const previewScale = Math.min(1.6, height * 0.35 / image.height);
  return (
    <Modal transparent animationType="fade" visible onRequestClose={close}
      supportedOrientations={["portrait", "landscape"]}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <Pressable accessible={false} onPress={close}
          style={{ position: "absolute", inset: 0, backgroundColor: "rgba(0,0,0,0.45)" }} />
        <View accessibilityViewIsModal onAccessibilityEscape={close} style={{
          width: cardWidth, maxHeight: height * 0.8, borderRadius: 12, overflow: "hidden",
          backgroundColor: theme.colors.surface1, borderWidth: 1, borderColor: theme.colors.border,
        }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingLeft: 14, paddingRight: 3 }}>
            <Text accessibilityRole="header" style={{
              flex: 1, color: theme.colors.foreground, fontWeight: "600",
            }}>{t("formulaActions")}</Text>
            <Control icon="X" title={t("closeReader")} onPress={close} theme={theme} compact />
          </View>
          <NativeScrollView style={{ flexGrow: 0, flexShrink: 1 }} contentContainerStyle={{ gap: 8, padding: 12, paddingTop: 0 }}>
            <NativeScrollView horizontal nestedScrollEnabled testID="omni-formula-preview"
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ flexGrow: 1, justifyContent: "center", alignItems: "center" }}>
              <Image accessible accessibilityLabel={tex} fadeDuration={0}
                source={{ uri: image.uris[0] }} resizeMode="contain"
                style={{ width: image.width * previewScale, height: image.height * previewScale }} />
            </NativeScrollView>
            <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 6 }}>
              <Control title={t("copyFormula")} theme={theme} compact={compact} onPress={() => { close(); void copy(tex); }} />
              <Control title={t(showSource ? "hideFormula" : "showFormula")} selected={showSource} theme={theme} compact={compact}
                onPress={() => setShowSource((current) => !current)} />
            </View>
            {showSource && (
              <Text selectable style={{
                color: theme.colors.foreground, fontFamily: "monospace", fontSize: 15, textAlign: "center",
              }}>{tex}</Text>
            )}
          </NativeScrollView>
        </View>
      </View>
    </Modal>
  );
}

export const RichMarkdown = memo(function RichMarkdown({ text, theme, compact, hostId }: {
  text: string; theme: Theme; compact: boolean; hostId: string;
}) {
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
  const displayScale = (Number(sizes?.displayFormulaSize ?? 100) / 100) * effectiveBodySize / bodyReferenceSize;
  const [selectedFormula, setSelectedFormula] = useState<InlineMath | null>(null);
  const root = useRef<View>(null);
  const copy = useCopyFormula();
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
  const renderNative = useCallback((markdown: string) => (
    <NativeMarkdown text={markdown} formulas={nativeMath} theme={theme} onActions={setSelectedFormula}
      bodySize={bodySize} fontScale={fontScale} />
  ), [bodySize, fontScale, nativeMath, theme]);
  return (
    <View ref={root} testID="omni-markdown" style={{ minWidth: 0, gap: compact ? 12 : 16 }}>
      {(nativeMath.length > 0 || blocks.some((block) => block.kind === "table" || block.kind === "formula")) && (
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
      )}
      {blocks.map((block, index) => {
        if (block.kind === "markdown") return native
          ? <View key={index} style={{ gap: 8 }}>{renderNative(block.text)}</View>
          : <Markdown key={index}>{block.text}</Markdown>;
        if (block.kind === "code") return <CodeBlock key={index} block={block} theme={theme} compact={compact} />;
        if (block.kind === "table") return (
          <TableBlock key={index} rows={block.rows} theme={theme}
            formulas={nativeMath} textScale={effectiveBodySize / inlineMathReferenceFontSize}
            renderCell={native ? renderNative : undefined} />
        );
        return <DisplayFormula key={`${index}:${block.tex}`} block={block} theme={theme} scale={displayScale}
          onActions={native ? setSelectedFormula : undefined} />;
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
        <FormulaActions formula={selectedFormula} theme={theme} compact={compact} close={() => setSelectedFormula(null)} />
      )}
    </View>
  );
});

function AssistantReader({ item, theme, layout, host, setOriginalReply }:
  PluginTimelineItemProps<ReturnType<typeof messageSchema.parse>> & {
    setOriginalReply: (reply: AssistantReply, original: boolean) => void;
  }) {
  const { text, phase, messageId, plain } = item.data;
  const { t } = useTranslation(messages);
  const label = t(plain ? "resumeRendering" : "restoreReply");
  return (
    <>
      {plain ? <Markdown>{text}</Markdown>
        : <RichMarkdown text={text} theme={theme} compact={layout.compact} hostId={host.id} />}
      {phase !== "streaming" && (
        <Pressable testID="omni-reply-mode" accessibilityRole="button" accessibilityLabel={label}
          hitSlop={4} onPress={() => setOriginalReply({ text, messageId }, !plain)} style={({ pressed }) => ({
            alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4,
            marginTop: 8, height: 28, paddingHorizontal: 4, borderRadius: 6,
            backgroundColor: pressed ? theme.colors.surface2 : "transparent",
          })}>
          <Icon name={plain ? "Sigma" : "CodeXml"} size={14} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{label}</Text>
        </Pressable>
      )}
    </>
  );
}
