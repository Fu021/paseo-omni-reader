import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, Text, View, type TextStyle } from "react-native";
import { useTranslation } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { lineOffsets, markdownParser } from "../shared/markdown-math";
import { inlineMathMarker, inlineMathReferenceFontSize, type InlineMath } from "../shared/reading-blocks";
import type { Theme } from "./controls";
import { messages } from "./messages";
import { ReaderScrollView as ScrollView } from "./reader-scroll";

const containsMath = new RegExp(inlineMathMarker.source);
const words = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh-CN", { granularity: "word" }) : undefined;
const opening = /^[([{“‘「『《（【]$/u;
const closing = /^[,.!?;:%)\]}、。，！？；：）】」』》”’]+$/u;
const headingScales = { h1: 1.6, h2: 1.4, h3: 1.2, h4: 1.1, h5: 1, h6: 1 };
type Token = ReturnType<typeof markdownParser.parse>[number];

function breakableText(text: string) {
  const parts: string[] = [];
  const normalized = text.replace(/[ \t]+/g, " ");
  const segments = words
    ? words.segment(normalized)
    : normalized.match(/[a-zA-Z\d]+| +|./gu) ?? [];
  for (const entry of segments) {
    const segment = typeof entry === "string" ? entry : entry.segment;
    const previous = parts.at(-1);
    if (previous && (/^\s+$/u.test(segment) || closing.test(segment) || opening.test(previous))) {
      parts[parts.length - 1] += segment;
    } else {
      parts.push(segment);
    }
  }
  return parts;
}

const InlineFormula = memo(function InlineFormula({ math, scrollWidth, textScale, onActions }: {
  math: InlineMath; scrollWidth?: number; textScale: number; onActions: (math: InlineMath) => void;
}) {
  const { t } = useTranslation(messages);
  const { image, tex } = math;
  const width = image.width * textScale;
  const height = image.height * textScale;
  const baseline = Math.min(image.height - 1, Math.max(0, image.baseline ?? image.height * 0.8));
  const formula = (
    <Pressable
      testID="omni-inline-math"
      accessibilityRole="button"
      accessibilityLabel={tex}
      accessibilityHint={t("formulaActionHint")}
      onLongPress={() => onActions(math)}
      accessibilityActions={[{ name: "activate", label: t("formulaActions") }]}
      onAccessibilityAction={({ nativeEvent }) => { if (nativeEvent.actionName === "activate") onActions(math); }}
      style={{ width, height, paddingTop: baseline * textScale }}
    >
      <Text allowFontScaling={false} importantForAccessibility="no" style={{ fontSize: 1, lineHeight: 1, color: "transparent" }}>{"\u200B"}</Text>
      <View pointerEvents="none" style={{ position: "absolute", top: 0, left: 0, width, height }}>
        <Image accessible={false} source={{ uri: image.uris[0] }} resizeMode="contain"
          fadeDuration={0} style={{ width, height }} />
      </View>
    </Pressable>
  );
  return scrollWidth === undefined ? formula
    : <ScrollView horizontal nestedScrollEnabled style={{ width: scrollWidth, height, flexGrow: 0 }}>{formula}</ScrollView>;
});

function inlineRuns(tokens: Token[], formulas: InlineMath[], theme: Theme, maxWidth: number,
  onActions: (math: InlineMath) => void, fontSize: number, fontScale: number): ReactNode[] {
  const runs: ReactNode[] = [];
  const marks: string[] = [];
  const textScale = fontScale * fontSize / inlineMathReferenceFontSize;
  const addText = (content: string, code = false) => {
    if (!content) return;
    const style: TextStyle = {
      color: theme.colors.foreground, fontSize, lineHeight: Math.round(fontSize * 1.5),
      fontWeight: marks.includes("strong") ? "700" : undefined,
      fontStyle: marks.includes("em") ? "italic" : undefined,
      textDecorationLine: marks.includes("s") ? "line-through" : undefined,
      ...(code ? { fontFamily: "monospace", backgroundColor: theme.colors.surface1 } : {}),
    };
    for (const part of breakableText(content)) {
      runs.push(<Text key={runs.length} selectable style={[style, { flexShrink: 1 }]}>{part}</Text>);
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.type === "link_open") {
      const end = tokens.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.type === "link_close");
      const href = token.attrGet("href");
      if (end > index && typeof href === "string" && href) {
        const label = tokens.slice(index + 1, end).map(({ content }) => content).join("")
          .replace(inlineMathMarker, (_, id) => formulas[Number(id)]?.tex ?? "")
          .replace(/[\\[\]\n]/g, (value) => value === "\n" ? " " : `\\${value}`);
        runs.push(
          <View key={runs.length} style={{ flexShrink: 1, maxWidth: "100%" }}>
            <Markdown>{`[${label}](<${href.replaceAll("<", "%3C").replaceAll(">", "%3E")}>)`}</Markdown>
          </View>,
        );
        index = end;
        continue;
      }
    }
    if (token.type === "hardbreak") {
      runs.push(<View key={runs.length} style={{ width: "100%", height: 0 }} />);
    } else if (token.type === "softbreak") {
      addText(" ");
    } else if (token.type === "text") {
      let offset = 0;
      for (const match of token.content.matchAll(inlineMathMarker)) {
        addText(token.content.slice(offset, match.index));
        const math = formulas[Number(match[1])];
        if (math) runs.push(
          <InlineFormula key={runs.length} math={math} textScale={textScale} onActions={onActions}
            scrollWidth={math.image.width * textScale > maxWidth ? maxWidth : undefined} />,
        );
        offset = match.index + match[0].length;
      }
      addText(token.content.slice(offset));
    } else if (token.type === "image" && token.attrGet("src")) {
      const alt = token.content.replace(/[\\[\]]/g, "\\$&");
      const src = String(token.attrGet("src")).replaceAll("<", "%3C").replaceAll(">", "%3E");
      runs.push(<View key={runs.length} style={{ maxWidth: "100%" }}><Markdown>{`![${alt}](<${src}>)`}</Markdown></View>);
    } else if (token.type === "code_inline" || token.type === "html_inline") {
      addText(token.content, token.type === "code_inline");
    } else if (["strong", "em", "s"].includes(token.tag)) {
      if (token.nesting === 1) marks.push(token.tag);
      else marks.splice(marks.lastIndexOf(token.tag), 1);
    }
  }
  return runs;
}

function NativeBlock({ source, tokens, theme, formulas, onActions, bodySize, fontScale }: {
  source: string; tokens: Token[]; theme: Theme; formulas: InlineMath[]; onActions: (math: InlineMath) => void;
  bodySize: number; fontScale: number;
}) {
  const [width, setWidth] = useState(0);
  const lists: (number | null)[] = [];
  let quoteDepth = 0;
  let bullet = "";
  return (
    <View onLayout={({ nativeEvent }) => setWidth(nativeEvent.layout.width)} style={{ gap: 6 }}>
      {tokens.map((token, index) => {
        if (token.type === "ordered_list_open") lists.push(Number(token.attrGet("start") ?? 1));
        if (token.type === "bullet_list_open") lists.push(null);
        if (token.type === "ordered_list_close" || token.type === "bullet_list_close") lists.pop();
        if (token.type === "blockquote_open") quoteDepth++;
        if (token.type === "blockquote_close") quoteDepth--;
        if (token.type === "list_item_open") {
          const number = lists.at(-1);
          bullet = number == null ? "•" : `${number}.`;
          if (number != null) lists[lists.length - 1] = number + 1;
        }
        if (token.type === "list_item_close") bullet = "";
        if (token.type === "fence" || token.type === "code_block") {
          const offsets = lineOffsets(source);
          return token.map && <Markdown key={index}>{source.slice(offsets[token.map[0]], offsets[token.map[1]])}</Markdown>;
        }
        if (token.type !== "inline" || !token.children) return null;
        const heading = tokens[index - 1]?.tag as keyof typeof headingScales | undefined;
        const fontSize = Math.round(bodySize * ((heading && headingScales[heading]) || 1));
        const indent = Math.min(6, quoteDepth + lists.length) * 12;
        const prefix = bullet;
        bullet = "";
        return (
          <View key={index} style={{ marginLeft: indent, flexDirection: "row", gap: prefix ? 6 : 0 }}>
            {!!prefix && <Text style={{ color: theme.colors.foregroundMuted, fontSize, lineHeight: Math.round(fontSize * 1.5) }}>{prefix}</Text>}
            <View style={{ flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", rowGap: 1 }}>
              {inlineRuns(token.children, formulas, theme,
                width ? Math.max(1, width - indent - (prefix ? 26 : 0)) : Infinity, onActions, fontSize, fontScale)}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export const NativeMarkdown = memo(function NativeMarkdown({ text, formulas, theme, onActions, bodySize, fontScale }: {
  text: string; formulas: InlineMath[]; theme: Theme; onActions: (math: InlineMath) => void;
  bodySize: number; fontScale: number;
}) {
  const sections = useMemo(() => {
    if (!containsMath.test(text)) return [{ text }];
    const offsets = lineOffsets(text);
    const tokens = markdownParser.parse(text, {});
    const roots = tokens.flatMap((token, index) => token.level === 0 && token.map ? [{ token, index }] : []);
    const parts: { text: string; tokens?: Token[] }[] = [];
    let offset = 0;
    for (const [index, root] of roots.entries()) {
      const [startLine, endLine] = root.token.map!;
      const start = offsets[startLine];
      const end = offsets[endLine];
      const content = text.slice(start, end);
      if (!containsMath.test(content)) continue;
      if (text.slice(offset, start).trim()) parts.push({ text: text.slice(offset, start) });
      parts.push({ text: content, tokens: tokens.slice(root.index, roots[index + 1]?.index) });
      offset = end;
    }
    if (text.slice(offset).trim()) parts.push({ text: text.slice(offset) });
    return parts;
  }, [text]);
  return sections.map((section, index) => (
    <Fragment key={index}>
      {section.tokens ? (
        <NativeBlock source={text} tokens={section.tokens} theme={theme} formulas={formulas}
          onActions={onActions} bodySize={bodySize} fontScale={fontScale} />
      ) : <Markdown>{section.text}</Markdown>}
    </Fragment>
  ));
});
