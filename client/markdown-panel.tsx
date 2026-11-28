import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Animated, Dimensions, Easing, Platform, Text, View, useWindowDimensions,
  type FlatList as NativeFlatList, type TextStyle, type ViewStyle } from "react-native";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { useRpc, useTabState, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Loading, Markdown, ScrollView } from "@getpaseo/plugin/client/ui";
import { z } from "zod";
import { readMarkdownInfo, readMarkdownPage, readMarkdownSource } from "../shared/contracts";
import { findFormulas, lineOffsets, markdownParser } from "../shared/markdown-math";
import { inlineReferenceLinks, markdownReferences } from "../shared/markdown-references";
import { Control, ReadError, Toolbar, useFileGeneration } from "./controls";
import { shouldReplaceAssistant } from "./assistant-turn";
import { ExternalFileAction } from "./external-file";
import { RichMarkdown } from "./markdown";
import { bindMarkdownScroll } from "./markdown-scroll";
import { ReaderFindBar, useMarkdownFind, useReaderFindShortcuts, useReaderFindVisibility, type MarkdownMatch } from "./reader-find";
import { messages } from "./messages";
import { Syntax } from "./syntax";
import { bindMarkdownAnchors, focusReaderFind, observeCodeFont, readerSelection,
  revealMarkdownMatch, webReadingWidth } from "./web";

type Page = RpcOutput<typeof readMarkdownPage>;
type Info = RpcOutput<typeof readMarkdownInfo>;
type FileTarget = RpcInput<typeof readMarkdownInfo>;
type PageCursor = Omit<RpcInput<typeof readMarkdownPage>, keyof FileTarget>;
type LineRange = { first: number; last: number };
type PreviewBlock = { key: string; first: number; last: number; text: string };
const markdownTabState = z.object({ mode: z.enum(["source", "preview", "split"]).nullable() });
type Mode = NonNullable<z.infer<typeof markdownTabState>["mode"]>;
type SourceRow = RpcOutput<typeof readMarkdownSource>["lines"][number] & { number: number };
type SourcePosition = { first: number; count: number };
type SourceJump = { line: number; center: boolean; offset?: number };
type PreviewJump = { line: number; index?: number; find?: boolean };
type SplitPane = "preview" | "source";
const defaultCodeSize = 12;
const wideSplitWidth = 680;
const contentFrame = { width: "100%", alignSelf: "center", paddingHorizontal: 8 } as const;
const nativeReadingWidth = { maxWidth: 820 };
const cachedBlocks = new WeakMap<Page, { info?: Info; blocks: PreviewBlock[] }>();
const webGutter = { position: "sticky", left: 0, zIndex: 1 } as unknown as ViewStyle;
const fixedSourceScroll = { overflowAnchor: "none" } as unknown as ViewStyle;
const preformatted = { whiteSpace: "pre", tabSize: 4 } as TextStyle;
const wrappedSource = { whiteSpace: "pre-wrap", overflowWrap: "anywhere", tabSize: 4 } as TextStyle;
const hiddenOnWeb = { visibility: "hidden" } as unknown as ViewStyle;
const sourceProbeText = "```\n00000000\n00000000\n```";

function SourceScroll({ wrap, width, children }: { wrap: boolean; width: number; children: ReactNode }) {
  if (wrap) return children;
  return <ScrollView horizontal nestedScrollEnabled directionalLockEnabled style={{ flex: 1 }}
    contentContainerStyle={{ minWidth: "100%", width: Math.max(180, width), flexGrow: 1 }}>{children}</ScrollView>;
}

function previewBlocks(page: Page, info?: Info): PreviewBlock[] {
  const cached = cachedBlocks.get(page);
  if (cached && cached.info === info) return cached.blocks;
  const metadataLines = info?.revision === page.revision && page.prefixLines === 0
    ? Math.max(0, info.frontMatterEnd - page.firstLine + 1) : 0;
  const source = metadataLines ? page.markdown.slice(lineOffsets(page.markdown)[metadataLines] ?? page.markdown.length) : page.markdown;
  if (!source.trim()) return [];
  const text = source;
  const references = info?.revision === page.revision ? info.references : markdownReferences(text);
  const offsets = lineOffsets(text);
  const formulas = findFormulas(text).filter((span) => span.block);
  const starts = markdownParser.parse(text, {}).filter((token) => token.level === 0 && token.map)
    .map((token) => token.map![0]);
  const boundaries = [...new Set([0, ...starts, offsets.length - 1])].filter((line) =>
    !formulas.some((span) => span.start < offsets[line] && offsets[line] < span.end));
  const blocks: PreviewBlock[] = [];
  const sourceBase = page.firstLine + metadataLines - page.prefixLines;
  const lastSource = page.nextLine - Number(/(?:\r\n|\r|\n)$/.test(page.source));
  for (const [index, line] of boundaries.slice(0, -1).entries()) {
    const next = boundaries[index + 1];
    const block = text.slice(offsets[line], offsets[next]).trimEnd();
    if (!block || (block.trimStart().startsWith("[") && !markdownParser.parse(block, {}).length)) continue;
    const first = Math.max(page.firstLine + metadataLines, sourceBase + line);
    const last = Math.max(first, Math.min(lastSource, sourceBase + line + block.split(/\r\n|\r|\n/).length - 1));
    blocks.push({ key: `${page.offset}:${index}`, first, last, text: inlineReferenceLinks(block, references) });
  }
  cachedBlocks.set(page, { info, blocks });
  return blocks;
}

function Metadata({ info, theme }: { info: Info; theme: PluginFilePanelProps["theme"] }) {
  return (
    <View style={{ backgroundColor: theme.colors.surface1, borderColor: theme.colors.border, borderWidth: 1,
      borderRadius: 8, padding: 12, gap: 6 }}>
      {info.frontMatter.map(({ key, value }) => (
        <View key={key} style={{ flexDirection: "row", gap: 12 }}>
          <Text selectable style={{ flex: 1, color: theme.colors.foregroundMuted, fontWeight: "600" }}>{key}</Text>
          <Text selectable style={{ flex: 2, color: theme.colors.foreground }}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function MatchText({ text, matches, active, theme }: {
  text: string; matches: MarkdownMatch[]; active?: MarkdownMatch; theme: PluginFilePanelProps["theme"];
}) {
  let offset = 0;
  const parts = matches.map((match) => {
    const preceding = text.slice(offset, match.column);
    offset = Math.min(text.length, match.column + match.length);
    if (match.column > text.length) return preceding;
    const selected = match === active;
    return (
      <Text key={match.column}>
        {preceding}<Text {...(selected ? { dataSet: { activeMatch: "true" } } : {})} style={{
          backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
          color: selected ? theme.colors.accentForeground : theme.colors.foreground,
          ...(match.length === 0 ? { borderLeftWidth: 2, borderColor: theme.colors.accent } : {}),
        }}>{text.slice(match.column, offset) || "\u200B"}</Text>
      </Text>
    );
  });
  return <>{parts}{text.slice(offset)}</>;
}

export function MarkdownPanel(props: PluginFilePanelProps) {
  const { file, workspaceId, host, theme, params, revision, layout: { compact, platform } } = props;
  const generation = useFileGeneration(file);
  const { t } = useTranslation(messages);
  const tabActive = (props.tab as typeof props.tab & { active?: boolean }).active !== false;
  const read = useRpc(readMarkdownPage);
  const readInfo = useRpc(readMarkdownInfo);
  const readSource = useRpc(readMarkdownSource);
  const target = useMemo<FileTarget>(() => ({ workspaceId, path: file.path }), [workspaceId, file.path]);
  const [attempt, setAttempt] = useState(0);
  const [panelWidth, setPanelWidth] = useState(0);
  const screen = Dimensions.get("screen");
  const desktopLayout = platform === "web" || (Platform.OS === "ios" && Platform.isPad)
    || Math.min(screen.width, screen.height) >= 600;
  const sideBySide = desktopLayout && panelWidth >= wideSplitWidth;
  const defaultMode = sideBySide ? "split" : "preview";
  const [savedView, setTabState] = useTabState(props.tab, markdownTabState, { mode: null });
  const [selectedMode, setMode] = useState(savedView.mode);
  const mode = selectedMode ?? (params.lineStart ? "source" : defaultMode);
  const split = mode === "split";
  useEffect(() => {
    if (sideBySide && selectedMode === null && !params.lineStart) {
      setMode("split");
      setTabState({ mode: "split" });
    }
  }, [params.lineStart, selectedMode, setTabState, sideBySide]);
  const previewVisible = mode !== "source";
  const sourceVisible = mode === "source" || split;
  const [visited, setVisited] = useState({ preview: !params.lineStart, source: !!params.lineStart });
  useEffect(() => {
    setVisited((current) => {
      const preview = current.preview || previewVisible;
      const source = current.source || sourceVisible;
      return preview === current.preview && source === current.source ? current : { preview, source };
    });
  }, [previewVisible, sourceVisible]);
  const [targetLine, setTargetLine] = useState(1);
  const [sourceLine, setSourceLine] = useState(params.lineStart ?? 1);
  const [flash, setFlash] = useState<LineRange | undefined>();
  const [sourceJump, setSourceJump] = useState<SourceJump>();
  const [flashOpacity] = useState(() => new Animated.Value(0));
  const { findOpen, showFind, hideFind } = useReaderFindVisibility();
  const defaultFamily = platform === "ios" ? "ui-monospace" : "monospace";
  const [codeFont, setCodeFont] = useState({ size: defaultCodeSize, family: defaultFamily, digitWidth: defaultCodeSize * 0.62 });
  const visibleLine = useRef(1);
  const visibleSource = useRef(params.lineStart ?? 1);
  const previewOffset = useRef(0);
  const sourceOffset = useRef(0);
  const sourceHeight = useRef(0);
  const nativeSplitDriver = useRef<SplitPane>(undefined);
  const beforeFind = useRef<{ version: string; mode: Mode; sourceLine: number; sourceOffset: number;
    targetLine: number; previewOffset: number }>(undefined);
  const restorePreview = useRef<{ line: number; offset: number }>(undefined);
  const nativePreviewJump = useRef<number>(undefined);
  const previewHeaderHeight = useRef(0);
  const currentBlock = useRef<PreviewBlock>(undefined);
  const panelRoot = useRef<View>(null);
  const previewRoot = useRef<View>(null);
  const sourceRoot = useRef<View>(null);
  const codeProbe = useRef<View>(null);
  const previewList = useRef<NativeFlatList<PreviewBlock>>(null);
  const sourceList = useRef<NativeFlatList<SourceRow>>(null);
  const sourceWindow = useRef<SourcePosition>({ first: 1, count: 0 });
  const webScroll = useRef<ReturnType<typeof bindMarkdownScroll>>(undefined);
  const pendingPreview = useRef<PreviewJump>(undefined);
  const placePreview = useRef<(line: number) => void>(undefined);
  const previewFrame = useRef<number>(undefined);
  const scrollRetryTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scrollTries = useRef(0);
  const completedJump = useRef<SourceJump>(undefined);
  const version = `${file.modifiedAt}:${generation}:${attempt}`;
  const fileKey = ["omni-reader", "markdown", host.id, workspaceId, file.path, version] as const;
  const find = useMarkdownFind(target, fileKey, tabActive && findOpen);
  const versionRef = useRef(version);
  if (versionRef.current !== version) {
    versionRef.current = version;
    setTargetLine(visibleLine.current);
    setSourceLine(visibleSource.current);
  }
  const changeMode = useCallback((next: Mode) => {
    nativeSplitDriver.current = undefined;
    if (next !== selectedMode) {
      setMode(next);
      setTabState({ mode: next });
    }
  }, [selectedMode, setTabState]);
  const jumpToSource = useCallback((line: number, center = false) => {
    clearTimeout(scrollRetryTimer.current);
    const { first, count } = sourceWindow.current;
    if (line < first || line >= first + count) setSourceLine(Math.max(1, line - (center ? 24 : 0)));
    setSourceJump({ line, center });
    visibleSource.current = line;
  }, []);
  const showPreview = useCallback((line: number) => {
    nativeSplitDriver.current = undefined;
    visibleLine.current = line;
    if (platform === "web" && previewVisible && placePreview.current) {
      placePreview.current(line);
    } else {
      previewOffset.current = 0;
      setTargetLine(line);
    }
    beforeFind.current = undefined;
    if (findOpen) hideFind();
    if (split) jumpToSource(line);
  }, [findOpen, hideFind, jumpToSource, platform, previewVisible, split]);
  const handledLocation = useRef<{ line: number; revision: number }>(undefined);
  useEffect(() => {
    if (!params.lineStart) {
      handledLocation.current = undefined;
      return;
    }
    if (handledLocation.current?.line === params.lineStart && handledLocation.current.revision === revision) return;
    handledLocation.current = { line: params.lineStart, revision };
    changeMode("source");
    jumpToSource(params.lineStart, true);
  }, [params.lineStart, revision, changeMode, jumpToSource]);
  useEffect(() => () => {
    clearTimeout(scrollRetryTimer.current);
    if (previewFrame.current !== undefined) cancelAnimationFrame(previewFrame.current);
  }, []);
  useEffect(() => {
    if (platform !== "web") return;
    return observeCodeFont(codeProbe.current, (size, family, digitWidth) => {
      const resolvedFamily = family || defaultFamily;
      setCodeFont((prior) => prior.size === size && prior.family === resolvedFamily && prior.digitWidth === digitWidth
        ? prior : { size, family: resolvedFamily, digitWidth });
    });
  }, [platform, defaultFamily]);

  const infoQuery = useQuery({
    queryKey: [...fileKey, "info"], queryFn: () => readInfo(target), staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const info = infoQuery.data;
  const preview = useInfiniteQuery({
    queryKey: [...fileKey, "preview", targetLine],
    queryFn: ({ pageParam }) => read({ ...target, ...pageParam }),
    initialPageParam: { offset: 0, atLine: targetLine > 1 ? targetLine : undefined } as PageCursor,
    getNextPageParam: ({ nextOffset, nextLine, revision, fence, table }): PageCursor | undefined => nextOffset === null ? undefined
      : { offset: nextOffset, firstLine: nextLine, revision, fence, table },
    enabled: visited.preview || previewVisible, staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const source = useInfiniteQuery({
    queryKey: [...fileKey, "source", sourceLine],
    queryFn: ({ pageParam }) => readSource({ ...target, line: pageParam }),
    initialPageParam: sourceLine,
    getNextPageParam: (page) => page.nextLine ?? undefined,
    enabled: visited.source || sourceVisible, staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const anchors = useMemo(() => new Map(info?.headings.filter(({ anchor }) => anchor).map(({ anchor, line }) =>
    [`#${encodeURIComponent(anchor)}`, () => showPreview(line)])), [info, showPreview]);
  const anchorsRef = useRef(anchors);
  anchorsRef.current = anchors;
  useEffect(() => {
    if (platform !== "web" || (!visited.preview && !previewVisible)) return;
    return bindMarkdownAnchors(previewRoot.current, (href) => {
      let key = href;
      try { key = `#${encodeURIComponent(decodeURIComponent(href.slice(1)))}`; } catch { return false; }
      const action = anchorsRef.current.get(key);
      action?.();
      return !!action;
    });
  }, [platform, visited.preview, previewVisible]);

  const blocks = useMemo(() => preview.data?.pages.flatMap((page, index) => previewBlocks(page, info)
    .filter((block) => index > 0 || block.last >= targetLine)) ?? [], [info, preview.data, targetLine]);
  const sourceRows = useMemo(() => source.data?.pages.flatMap((page) => page.lines.map((line, index) =>
    ({ ...line, number: page.firstLine + index }))) ?? [], [source.data]);
  const firstSource = sourceRows[0]?.number ?? sourceLine;
  sourceWindow.current = { first: firstSource, count: sourceRows.length };
  const web = platform === "web";
  const flashLoaded = !!flash && flash.first >= firstSource && flash.first < firstSource + sourceRows.length;
  useEffect(() => {
    if (!sourceVisible || !flashLoaded) return;
    const flashFrame = requestAnimationFrame(() => {
      flashOpacity.setValue(0.24);
      Animated.timing(flashOpacity, {
        toValue: 0, duration: 920, delay: 130, easing: Easing.out(Easing.quad), useNativeDriver: !web,
      }).start(({ finished }) => {
        if (finished) setFlash((current) => current === flash ? undefined : current);
      });
    });
    return () => {
      cancelAnimationFrame(flashFrame);
      flashOpacity.stopAnimation();
    };
  }, [flash, flashLoaded, flashOpacity, sourceVisible, web]);
  const dimensions = useWindowDimensions();
  const fontScale = platform === "web" ? 1 : dimensions.fontScale;
  const sourceFontSize = codeFont.size * fontScale;
  const rowHeight = sourceFontSize * 1.45;
  const codeStyle = { fontFamily: codeFont.family, fontSize: sourceFontSize, lineHeight: rowHeight, includeFontPadding: false } as const;
  const wrapSource = mode === "source" && (!web || /\.(?:md|markdown)$/i.test(file.name) && file.size <= 1024 * 1024);
  const sourceTop = web ? 16 : 0;
  const sourcePixel = (line: number) => sourceTop + (line - firstSource) * rowHeight;
  const showBlockSource = (range: LineRange) => {
    changeMode(split || sideBySide ? "split" : "source");
    const viewport = split ? web ? webScroll.current?.sourceViewport() : { top: sourceOffset.current, height: sourceHeight.current } : undefined;
    const first = sourcePixel(range.first);
    const end = sourcePixel(range.last + 1);
    const shown = viewport && range.first >= firstSource && range.first < firstSource + sourceRows.length
      && first >= viewport.top - 1
      && (end - first > viewport.height ? first + rowHeight : end) <= viewport.top + viewport.height + 1;
    if (!shown) jumpToSource(range.first, true);
    setFlash({ ...range });
  };
  const gutterWidth = web ? Math.max(21, Math.ceil(String(info?.lineCount ?? sourceRows.at(-1)?.number ?? 1).length * codeFont.digitWidth + 9))
    : Math.max(56, String(info?.lineCount ?? sourceRows.at(-1)?.number ?? 1).length * sourceFontSize * 0.62 + 15);
  const sourceWidth = useMemo(() => Math.min(26_000, sourceRows.reduce((width, { text }) => {
    const length = text.length + (text.match(/[\u2e80-\uffef\t]/g)?.length ?? 0) * 2;
    return Math.max(width, gutterWidth + 19 + length * sourceFontSize * 0.67);
  }, 0)), [gutterWidth, sourceFontSize, sourceRows]);
  const hitsByLine = useMemo(() => {
    const groups = new Map<number, MarkdownMatch[]>();
    for (const hit of find.hits) {
      const group = groups.get(hit.line);
      if (group) group.push(hit);
      else groups.set(hit.line, [hit]);
    }
    return groups;
  }, [find.hits]);
  const openFind = () => {
    if (findOpen) return focusReaderFind(panelRoot.current, "omni-markdown-find");
    if (!web) beforeFind.current = {
      version, mode, sourceLine, sourceOffset: sourceOffset.current, targetLine, previewOffset: previewOffset.current,
    };
    const selected = web ? readerSelection(panelRoot.current) : "";
    if (selected && !selected.includes("\n")) find.changeQuery(selected.slice(0, 256));
    showFind();
  };
  const closeFind = () => {
    hideFind();
    const saved = beforeFind.current;
    beforeFind.current = undefined;
    nativePreviewJump.current = undefined;
    if (pendingPreview.current?.find) pendingPreview.current = undefined;
    if (saved?.version !== version) return;
    clearTimeout(scrollRetryTimer.current);
    changeMode(saved.mode);
    if (saved.mode !== "preview") {
      setSourceLine(saved.sourceLine);
      setSourceJump({ line: saved.sourceLine, center: false, offset: saved.sourceOffset });
    }
    if (saved.mode === "source") return;
    if (targetLine !== saved.targetLine) {
      restorePreview.current = { line: saved.targetLine, offset: saved.previewOffset };
      setTargetLine(saved.targetLine);
    } else if (previewOffset.current !== saved.previewOffset) {
      previewList.current?.scrollToOffset({ offset: saved.previewOffset, animated: false });
    }
  };
  useReaderFindShortcuts(panelRoot, "omni-markdown-find", web && tabActive,
    { open: openFind, close: closeFind, move: find.move, isOpen: () => findOpen });
  useEffect(() => {
    if (!sourceVisible || !sourceJump || sourceJump === completedJump.current ||
      sourceJump.line < firstSource || sourceJump.line >= firstSource + sourceRows.length) return;
    const frame = requestAnimationFrame(() => {
      const list = sourceList.current;
      if (!list) return;
      completedJump.current = sourceJump;
      scrollTries.current = 0;
      const offset = sourceTop + (sourceJump.line - firstSource) * rowHeight;
      const scroller = split ? webScroll.current : undefined;
      const viewport = scroller?.sourceViewport();
      if (viewport && scroller?.scrollSource(sourceJump.center
        ? offset - (viewport.height - rowHeight) * 0.35 : sourceJump.offset ?? offset)) return;
      if (sourceJump.center) {
        list.scrollToIndex({ index: sourceJump.line - firstSource, viewPosition: 0.35, animated: false });
      } else {
        list.scrollToOffset({ offset: sourceJump.offset ?? Math.max(0, sourceJump.line - firstSource) * rowHeight, animated: false });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [firstSource, rowHeight, sourceJump, sourceRows.length, sourceTop, sourceVisible, split]);
  const recoverSourceScroll = ({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
    if (scrollTries.current++ >= 3) return;
    const list = sourceList.current;
    list?.scrollToOffset({ offset: index * (averageItemLength || rowHeight), animated: false });
    scrollRetryTimer.current = setTimeout(() => {
      if (list && list === sourceList.current) list.scrollToIndex({ index, viewPosition: 0.35, animated: false });
    }, 70);
  };
  useEffect(() => {
    if (!web || !find.active || sourceJump?.line !== find.active.line || !sourceVisible ||
      find.active.line < firstSource || find.active.line >= firstSource + sourceRows.length) return;
    const timeout = setTimeout(() => revealMarkdownMatch(sourceRoot.current), 100);
    return () => clearTimeout(timeout);
  }, [find.active, firstSource, sourceJump, sourceRows.length, sourceVisible, web]);
  const alignPreview = useRef<() => void>(undefined);
  alignPreview.current = () => {
    const pending = pendingPreview.current;
    const scroller = webScroll.current;
    if (!pending || !scroller || preview.isPending) return;
    if (scroller.scrollPreview(pending.line, pending.find)) {
      pendingPreview.current = undefined;
      visibleLine.current = Math.floor(pending.line);
      return;
    }
    const last = blocks.at(-1);
    if (pending.line < targetLine || last && pending.line > last.last + 1 && preview.hasNextPage) {
      if (preview.isFetching) return;
      if (pending.line >= targetLine && last && pending.line < last.last + 128) {
        void preview.fetchNextPage({ cancelRefetch: false });
      } else {
        setTargetLine(Math.max(1, Math.floor(pending.line)));
      }
      return;
    }
    if (!last || pending.line > last.last + 1) {
      scroller.scrollPreviewToEnd();
      pendingPreview.current = undefined;
      return;
    }
    const next = blocks.findIndex((block) => block.first > pending.line);
    const index = Math.max(0, (next < 0 ? blocks.length : next) - 1);
    if (index === pending.index || !previewList.current) return;
    pending.index = index;
    previewList.current.scrollToIndex({ index, animated: false });
  };
  placePreview.current = (line) => {
    pendingPreview.current = { line, index: pendingPreview.current?.index };
    alignPreview.current?.();
  };
  const schedulePreviewAlignment = useCallback(() => {
    if (!pendingPreview.current || previewFrame.current !== undefined) return;
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = undefined;
      alignPreview.current?.();
    });
  }, []);
  useEffect(() => {
    schedulePreviewAlignment();
  }, [blocks, preview.isFetching, schedulePreviewAlignment, targetLine]);

  const jumpToNativePreview = (line: number, viewPosition: number) => {
    if (line <= (info?.frontMatterEnd ?? 0)) {
      if (targetLine === 1) previewList.current?.scrollToOffset({ offset: 0, animated: false });
      else setTargetLine(1);
      return;
    }
    const next = blocks.findIndex(({ first }) => first > line);
    const index = next < 0 ? blocks.length - 1 : Math.max(0, next - 1);
    const last = blocks.at(-1);
    if (!last || line < targetLine || (line > last.last && preview.hasNextPage) || !previewList.current) {
      if (!viewPosition && preview.isPending) return;
      if (targetLine !== line) setTargetLine(line);
      return;
    }
    if (!viewPosition && blocks[index] === currentBlock.current && previewOffset.current > previewHeaderHeight.current + 1) return;
    nativePreviewJump.current = line;
    previewList.current.scrollToIndex({ index, viewPosition, animated: false });
    nativePreviewJump.current = undefined;
  };
  const navigateToMatch = useRef<(match: MarkdownMatch) => void>(undefined);
  navigateToMatch.current = (match) => {
    nativeSplitDriver.current = undefined;
    if (sourceVisible) jumpToSource(match.line, true);
    if (!previewVisible) return;
    if (web) {
      pendingPreview.current = { line: match.line, find: true };
      schedulePreviewAlignment();
    } else {
      jumpToNativePreview(match.line, 0.25);
    }
  };
  useEffect(() => {
    if (find.active) navigateToMatch.current?.(find.active);
    else {
      nativePreviewJump.current = undefined;
      if (pendingPreview.current?.find) pendingPreview.current = undefined;
    }
  }, [find.active, previewVisible, sourceVisible]);
  const restorePreviewPosition = () => {
    const restore = restorePreview.current;
    if (!restore || restore.line !== targetLine || !previewList.current) return;
    restorePreview.current = undefined;
    previewList.current.scrollToOffset({ offset: restore.offset, animated: false });
  };
  const previewMatchMarker = (first: number, last: number) => {
    const line = find.active?.line;
    return previewVisible && line !== undefined && line >= first && line <= last
      ? <View testID="omni-markdown-preview-match" pointerEvents="none" style={{ position: "absolute",
        left: 1, top: 0, bottom: 0, width: 2, borderRadius: 1, backgroundColor: theme.colors.accent }} />
      : null;
  };

  const scrollActions = useRef<Parameters<typeof bindMarkdownScroll>[1]>(undefined);
  scrollActions.current = {
    previewStart: () => targetLine,
    preview: (line) => {
      if (pendingPreview.current) return schedulePreviewAlignment();
      if (!previewVisible || line === undefined) return;
      visibleLine.current = Math.floor(line);
      if (!split) return;
      if (line < firstSource || line >= firstSource + sourceRows.length) {
        if (Math.floor(line) !== sourceJump?.line) jumpToSource(Math.floor(line));
      } else {
        webScroll.current?.scrollSource(line === firstSource ? 0 : sourcePixel(line));
      }
    },
    source: (offset, atEnd) => {
      if (!split || !sourceRows.length) return;
      const line = Math.min(firstSource + sourceRows.length - 1, firstSource + Math.max(0, offset - sourceTop) / rowHeight);
      visibleSource.current = Math.floor(line);
      if (atEnd && !source.hasNextPage && !preview.hasNextPage) {
        pendingPreview.current = undefined;
        webScroll.current?.scrollPreviewToEnd();
      } else {
        placePreview.current?.(line);
      }
    },
    previewInteraction: () => { pendingPreview.current = undefined; },
  };
  const hasPreview = visited.preview || previewVisible;
  useEffect(() => {
    if (!web) return;
    webScroll.current = bindMarkdownScroll(panelRoot.current, {
      previewStart: () => scrollActions.current?.previewStart() ?? 1,
      preview: (line) => scrollActions.current?.preview(line),
      source: (offset, atEnd) => scrollActions.current?.source(offset, atEnd),
      previewInteraction: () => scrollActions.current?.previewInteraction(),
    });
    return () => {
      webScroll.current?.dispose();
      webScroll.current = undefined;
    };
  }, [web]);
  const followNativePreview = useRef<() => void>(undefined);
  followNativePreview.current = () => {
    if (!previewVisible) return;
    const line = previewOffset.current <= previewHeaderHeight.current + 1 ? targetLine : currentBlock.current?.first;
    if (!line || visibleLine.current === line) return;
    visibleLine.current = line;
    if (split && nativeSplitDriver.current === "preview") jumpToSource(line);
  };
  const onVisible = useRef(({ viewableItems }: { viewableItems: { item: PreviewBlock; isViewable: boolean }[] }) => {
    currentBlock.current = viewableItems.find(({ isViewable }) => isViewable)?.item;
    if (web) schedulePreviewAlignment();
    else followNativePreview.current?.();
  });
  const followNativeSource = useRef<(line: number) => void>(undefined);
  followNativeSource.current = (line) => {
    if (split && nativeSplitDriver.current === "source") jumpToNativePreview(line, 0);
  };
  useEffect(() => {
    if (!web && !preview.isPending) followNativeSource.current?.(visibleSource.current);
  }, [blocks, preview.isPending, web]);
  const onVisibleSource = useRef(({ viewableItems }: { viewableItems: { item: { number: number }; isViewable: boolean }[] }) => {
    const line = viewableItems.find(({ isViewable }) => isViewable)?.item.number;
    if (!line) return;
    visibleSource.current = line;
    if (!web) followNativeSource.current?.(line);
  });
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 0 });
  const readingWidth = platform === "web" ? webReadingWidth : nativeReadingWidth;
  const pane = (visible: boolean): ViewStyle => split
    ? { flex: 1, minHeight: 0, minWidth: 0 }
    : { position: "absolute", top: 0, bottom: 0, left: 0, right: 0, opacity: visible ? 1 : 0, zIndex: visible ? 1 : 0,
      ...(!visible && web ? hiddenOnWeb : {}) };
  const error = (cause: unknown, retry: () => void) => <ReadError theme={theme} compact={compact} label={t("textError")}
    error={cause} retry={t("retry")} onRetry={retry} />;
  const retryFile = () => setAttempt((value) => value + 1);
  const loadPreview = () => {
    if (preview.hasNextPage && !preview.isFetching && !preview.isError) void preview.fetchNextPage({ cancelRefetch: false });
  };
  const loadSource = () => {
    if (source.hasNextPage && !source.isFetching && !source.isError) void source.fetchNextPage({ cancelRefetch: false });
  };
  return (
    <View ref={panelRoot} testID="omni-text-panel" {...(web ? { tabIndex: 0 } : {})}
      onLayout={({ nativeEvent }) => setPanelWidth(nativeEvent.layout.width)}
      style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme} filePanel={props} lines={info?.lineCount}>
        <Control title={t("preview")} icon="BookOpenText" selected={previewVisible && !split}
          onPress={() => changeMode("preview")} theme={theme} compact={compact} />
        <Control title={t("splitMarkdown")} icon={sideBySide ? "Columns2" : "Rows2"} selected={split} theme={theme} compact={compact}
          onPress={() => { if (!split) { changeMode("split"); jumpToSource(visibleLine.current); } }} />
        <Control title={t("source")} icon="Code" selected={mode === "source"} theme={theme} compact={compact}
          onPress={() => { changeMode("source"); jumpToSource(visibleSource.current, true); }} />
        <Control title={t("find")} icon="Search" selected={findOpen} onPress={findOpen ? closeFind : openFind}
          theme={theme} compact={compact} />
        <ExternalFileAction {...props} />
      </Toolbar>
      {web && (
        <View ref={codeProbe} {...{ dataSet: { pmono: "" } }} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
          style={[{ position: "absolute", width: 280, left: -300 }, hiddenOnWeb]}>
          <Markdown>{sourceProbeText}</Markdown>
        </View>
      )}
        <View testID={split ? "omni-markdown-split" : undefined}
          style={{ flex: 1, minHeight: 0, minWidth: 0, flexDirection: split && sideBySide ? "row" : "column" }}>
        {hasPreview && (
          <View ref={previewRoot} testID="omni-markdown-preview-pane" style={pane(previewVisible)} pointerEvents={previewVisible ? "auto" : "none"}
            accessibilityElementsHidden={!previewVisible} importantForAccessibility={previewVisible ? "auto" : "no-hide-descendants"}>
            {preview.isPending ? <Loading /> : <FlatList ref={previewList} key={`${version}:${targetLine}`} data={blocks} testID="omni-markdown-preview-scroll"
              keyExtractor={({ key }) => key} keyboardShouldPersistTaps="handled" directionalLockEnabled
              initialNumToRender={6} maxToRenderPerBatch={6} windowSize={5}
              onViewableItemsChanged={onVisible.current} viewabilityConfig={viewabilityConfig.current}
              onScrollToIndexFailed={({ index, averageItemLength }) => {
                if (web) {
                  const pending = pendingPreview.current;
                  if (!pending) return;
                  const line = Math.floor(pending.line);
                  if (targetLine !== line) setTargetLine(line);
                  else previewList.current?.scrollToOffset({ offset: index * Math.max(averageItemLength, 20), animated: false });
                  return;
                }
                const line = nativePreviewJump.current;
                if (line !== undefined && targetLine !== line) setTargetLine(line);
              }}
              onScrollBeginDrag={!web && split ? () => { nativeSplitDriver.current = "preview"; } : undefined}
              onContentSizeChange={web ? undefined : restorePreviewPosition}
              onScroll={web ? undefined : ({ nativeEvent }) => { previewOffset.current = nativeEvent.contentOffset.y; followNativePreview.current?.(); }}
              scrollEventThrottle={32}
              contentContainerStyle={{ paddingHorizontal: compact ? 8 : 16, paddingVertical: 12, gap: 12 }}
              onEndReached={previewVisible ? loadPreview : undefined} onEndReachedThreshold={0.65}
              ListHeaderComponent={targetLine <= (info?.frontMatterEnd ?? 0) && info?.frontMatter.length
                ? <View style={[contentFrame, readingWidth]}
                  {...(web ? { dataSet: { previewIndex: "-1", sourceFirst: "1", sourceLast: String(info.frontMatterEnd) } } : {})}
                  onLayout={({ nativeEvent }) => { previewHeaderHeight.current = nativeEvent.layout.height; }}>
                  <Metadata info={info} theme={theme} />
                  {previewMatchMarker(1, info.frontMatterEnd)}
                </View> : null}
              ListEmptyComponent={!preview.hasNextPage && !preview.isError && !(info?.frontMatter.length)
                ? <Text style={{ color: theme.colors.foregroundMuted }}>{t("empty")}</Text> : null}
              ListFooterComponent={preview.isError ? error(preview.error, retryFile) : preview.isFetchingNextPage
                ? <ActivityIndicator /> : preview.hasNextPage
                  ? <Control title={t("loadMore")} theme={theme} compact={compact} onPress={loadPreview} /> : null}
              renderItem={({ item, index }) => (
                <View testID="omni-markdown-file-frame"
                  style={[contentFrame, readingWidth, { flexDirection: "row", gap: 4 }]}
                  {...(web ? { dataSet: { previewIndex: String(index), sourceFirst: String(item.first), sourceLast: String(item.last) } } : {})}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    {shouldReplaceAssistant(item.text) || (platform !== "web" && anchors.size > 0 && /\]\(<?#/.test(item.text))
                      ? <RichMarkdown theme={theme} compact={compact} text={item.text} hostId={host.id}
                          anchors={platform === "web" ? undefined : anchors} />
                      : <Markdown>{item.text}</Markdown>}
                  </View>
                  <Control title={t("showBlockSource")} icon="Code2" theme={theme} compact={compact} small
                    onPress={() => showBlockSource({ first: item.first, last: item.last })} />
                  {previewMatchMarker(item.first, item.last)}
                </View>
              )} />}
          </View>
        )}
        {(visited.source || sourceVisible) && (
          <View ref={sourceRoot} testID="omni-markdown-source-pane" {...(web ? { dataSet: { pmono: "" } } : {})}
            style={[pane(sourceVisible), split && { borderColor: theme.colors.border,
              borderLeftWidth: sideBySide ? 1 : 0, borderTopWidth: sideBySide ? 0 : 1 }]}
            pointerEvents={sourceVisible ? "auto" : "none"}
            accessibilityElementsHidden={!sourceVisible} importantForAccessibility={sourceVisible ? "auto" : "no-hide-descendants"}>
            {firstSource > 1 && <Toolbar theme={theme}>
              <Control title={t("earlierLines")} icon="ChevronsUp" theme={theme} compact={compact}
                onPress={() => setSourceLine(Math.max(1, firstSource - 128))} />
            </Toolbar>}
            {source.isPending ? <Loading /> : <SourceScroll wrap={wrapSource} width={sourceWidth}>
              <FlatList ref={sourceList} key={`${version}:${sourceLine}:${wrapSource}`} data={sourceRows} keyExtractor={({ number }) => String(number)}
                testID="omni-markdown-source-scroll"
                style={[{ flex: 1 }, split && fixedSourceScroll]} keyboardShouldPersistTaps="handled" directionalLockEnabled nestedScrollEnabled
                onLayout={web ? undefined : ({ nativeEvent }) => { sourceHeight.current = nativeEvent.layout.height; }}
                onScrollBeginDrag={!web && split ? () => { nativeSplitDriver.current = "source"; } : undefined}
                onScroll={web ? undefined : ({ nativeEvent }) => { sourceOffset.current = nativeEvent.contentOffset.y; }}
                scrollEventThrottle={32}
                onViewableItemsChanged={onVisibleSource.current} viewabilityConfig={viewabilityConfig.current}
                contentContainerStyle={{ paddingVertical: sourceTop }}
                getItemLayout={wrapSource ? undefined : (_, index) => ({ length: rowHeight, offset: sourceTop + index * rowHeight, index })}
                onScrollToIndexFailed={wrapSource ? recoverSourceScroll : undefined}
                initialNumToRender={28} maxToRenderPerBatch={24} windowSize={5}
                onEndReached={sourceVisible ? loadSource : undefined} onEndReachedThreshold={0.75}
                ListFooterComponent={source.isError ? error(source.error, retryFile) : source.isFetchingNextPage ? <ActivityIndicator />
                  : source.hasNextPage ? <Control title={t("loadMore")} theme={theme} compact={compact} onPress={loadSource} /> : null}
                renderItem={({ item }) => {
                  const flashing = !!flash && item.number >= flash.first && item.number <= flash.last;
                  const linked = mode === "source" && params.lineStart !== undefined
                    && item.number >= params.lineStart && item.number <= (params.lineEnd ?? params.lineStart);
                  const active = find.active?.line === item.number;
                  const matches = hitsByLine.get(item.number);
                  const backgroundColor = linked || active ? theme.colors.surface2 : theme.colors.surface0;
                  return (
                    <View {...(web ? { dataSet: { sourceRow: "true", flash: String(flashing) } } : {})}
                      style={{ flexDirection: "row", height: wrapSource ? undefined : rowHeight, minHeight: rowHeight,
                        paddingRight: wrapSource ? 2 : 12, backgroundColor }}>
                      <View {...(web ? { dataSet: { sourceGutter: "true" } } : {})}
                        style={[{ backgroundColor, width: gutterWidth }, web && webGutter,
                          web && { borderRightWidth: 1, borderColor: theme.colors.border }]}>
                        <Text allowFontScaling={false}
                          style={[codeStyle, { color: linked || active ? theme.colors.foreground : theme.colors.foregroundMuted,
                            textAlign: "right", paddingRight: web ? 3 : 12 }]}>
                          {item.number}
                        </Text>
                      </View>
                      <Text allowFontScaling={false} numberOfLines={!web && !wrapSource ? 1 : undefined} selectable
                        style={[codeStyle, { flex: 1, paddingLeft: web ? 6 : 0, color: theme.colors.foreground },
                          web && (wrapSource ? wrappedSource : preformatted)]}>
                        {matches ? <MatchText text={item.text} matches={matches} active={find.active} theme={theme} />
                          : <Syntax source={item.text} language="markdown" theme={theme} hostPalette={web} />}{item.truncated ? "…" : ""}
                      </Text>
                      {flashing && <Animated.View pointerEvents="none" style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0,
                        zIndex: 2, backgroundColor: theme.colors.accent, opacity: flashOpacity }} />}
                    </View>
                  );
                }} />
            </SourceScroll>}
          </View>
        )}
        {findOpen && <ReaderFindBar testID="omni-markdown-find" find={find} theme={theme} compact={compact} close={closeFind} />}
        </View>
    </View>
  );
}
