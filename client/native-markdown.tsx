import { Fragment, memo, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, Text, View, type TextStyle } from "react-native";
import { useTranslation } from "@getpaseo/plugin/client";
import { Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { lineOffsets, markdownParser } from "../shared/markdown-math";
import { inlineMathMarker, inlineMathReferenceFontSize, type ColumnAlignment, type InlineMath } from "../shared/reading-blocks";
import type { Theme } from "./controls";
import { messages } from "./messages";

const containsMath = new RegExp(inlineMathMarker.source);
const words = typeof Intl.Segmenter === "function" ? new Intl.Segmenter("zh-CN", { granularity: "word" }) : undefined;
const opening = /^[([{“‘「『《（【]$/u;
const closing = /^[,.!?;:%)\]}、。，！？；：）】」』》”’]+$/u;
const headingScales = { h1: 1.6, h2: 1.4, h3: 1.2, h4: 1.1, h5: 1, h6: 1 };
type Token = ReturnType<typeof markdownParser.parse>[number];
type Anchors = ReadonlyMap<string, () => void>;

function linkedLabel(tokens: Token[], formulas: InlineMath[]) {
  const escape = (value: string) => value.replace(/[\\\[\]*_~`\n]/g, (mark) => mark === "\n" ? " " : `\\${mark}`);
  return tokens.map((token) => {
    if (token.type === "hardbreak" || token.type === "softbreak") return " ";
    if (token.type === "code_inline") {
      const fence = "`".repeat(Math.max(0, ...Array.from(token.content.matchAll(/`+/g), ([part]) => part.length)) + 1);
      return `${fence} ${token.content} ${fence}`;
    }
    if (token.type === "image" && token.attrGet("src")) {
      return `![${escape(token.content)}](<${String(token.attrGet("src")).replace(/[<>]/g, encodeURIComponent)}>)`;
    }
    if (["strong", "em", "s"].includes(token.tag)) return token.markup;
    return escape(token.content.replace(inlineMathMarker, (_, id) => formulas[Number(id)]?.tex ?? ""));
  }).join("");
}

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

const InlineFormula = memo(function InlineFormula({ math, scrollWidth, textScale, onCopy }: {
  math: InlineMath; scrollWidth?: number; textScale: number; onCopy: (math: InlineMath) => void;
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
      accessibilityHint={t("formulaCopyHint")}
      onPress={() => onCopy(math)}
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
  onCopy: (math: InlineMath) => void, fontSize: number, fontScale: number, anchors?: Anchors): ReactNode[] {
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
        const children = tokens.slice(index + 1, end);
        const action = anchors?.get(href);
        const label = linkedLabel(children, formulas);
        const title = String(token.attrGet("title") ?? "").replace(/[\\"]/g, "\\$&");
        runs.push(action ? (
          <Text key={runs.length} accessibilityRole="link" onPress={action}
            style={{ flexShrink: 1, color: theme.colors.accent, fontSize, textDecorationLine: "underline" }}>
            {children.map(({ content }) => content).join("")}
          </Text>
        ) : (
          <View key={runs.length} style={{ flexShrink: 1, maxWidth: "100%" }}>
            <Markdown>{`[${label}](<${href.replaceAll("<", "%3C").replaceAll(">", "%3E")}>${title ? ` "${title}"` : ""})`}</Markdown>
          </View>
        ));
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
          <InlineFormula key={runs.length} math={math} textScale={textScale} onCopy={onCopy}
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

function NativeBlock({ source, tokens, theme, formulas, onCopy, bodySize, fontScale, align, anchors }: {
  source: string; tokens: Token[]; theme: Theme; formulas: InlineMath[]; onCopy: (math: InlineMath) => void;
  bodySize: number; fontScale: number; align?: ColumnAlignment; anchors?: Anchors;
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
        if (token.type === "hr") return <Markdown key={index}>{"---"}</Markdown>;
        if (token.type !== "inline" || !token.children) return null;
        const heading = tokens[index - 1]?.tag as keyof typeof headingScales | undefined;
        const fontSize = Math.round(bodySize * ((heading && headingScales[heading]) || 1));
        const indent = Math.min(6, quoteDepth + lists.length) * 12;
        const prefix = bullet;
        bullet = "";
        return (
          <View key={index} style={{ marginLeft: indent, flexDirection: "row", gap: prefix ? 6 : 0 }}>
            {!!prefix && <Text style={{ color: theme.colors.foregroundMuted, fontSize, lineHeight: Math.round(fontSize * 1.5) }}>{prefix}</Text>}
            <View style={{
              flex: 1, flexDirection: "row", flexWrap: "wrap", alignItems: "baseline", rowGap: 1,
              justifyContent: align === "right" ? "flex-end" : align === "center" ? "center" : "flex-start",
            }}>
              {inlineRuns(token.children, formulas, theme,
                width ? Math.max(1, width - indent - (prefix ? 26 : 0)) : Infinity, onCopy, fontSize, fontScale, anchors)}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export const NativeMarkdown = memo(function NativeMarkdown({ text, formulas, theme, onCopy, bodySize, fontScale, align, anchors }: {
  text: string; formulas: InlineMath[]; theme: Theme; onCopy: (math: InlineMath) => void;
  bodySize: number; fontScale: number; align?: ColumnAlignment; anchors?: Anchors;
}) {
  const sections = useMemo(() => {
    if (!align && !containsMath.test(text) && !(anchors?.size && text.includes("#"))) return [{ text }];
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
      const block = tokens.slice(root.index, roots[index + 1]?.index);
      if (!align && !containsMath.test(content) && !block.some((token) => token.children?.some((child) =>
        child.type === "link_open" && anchors?.has(String(child.attrGet("href")))))) continue;
      if (text.slice(offset, start).trim()) parts.push({ text: text.slice(offset, start) });
      parts.push({ text: content, tokens: block });
      offset = end;
    }
    if (text.slice(offset).trim()) parts.push({ text: text.slice(offset) });
    return parts;
  }, [align, anchors, text]);
  return sections.map((section, index) => (
    <Fragment key={index}>
      {section.tokens ? (
        <NativeBlock source={text} tokens={section.tokens} theme={theme} formulas={formulas}
          onCopy={onCopy} bodySize={bodySize} fontScale={fontScale} align={align} anchors={anchors} />
      ) : <Markdown>{section.text}</Markdown>}
    </Fragment>
  ));
});
