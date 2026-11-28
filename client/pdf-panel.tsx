import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Image, Keyboard, Text, TextInput, View, useWindowDimensions, type ViewStyle } from "react-native";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { copyText, Loading } from "@getpaseo/plugin/client/ui";
import {
  findDocumentText, readDocumentLayout, readDocumentText, renderOfficePage, renderPdfPage, type PageGlyph, type PageTextMatch,
} from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, useWebTitle, type Theme } from "./controls";
import { StructuredPanel } from "./document-panel";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import { useNativeContacts } from "./native-contacts";
import { PageFindOverlay } from "./page-find";
import { createPageRenderQueue } from "./page-render-queue";
import { PageSelectionOverlay, usePageSelection, type TextPage } from "./page-selection";
import { SlideSidebar } from "./page-tools";
import { ReaderFindBar, useFindResults, useReaderFindShortcuts, useReaderFindVisibility } from "./reader-find";
import { useReaderNotice } from "./reader-notice";
import {
  constrain, fitPagePosition, fitPages, jumpToPage, pageAt, pageBounds, visiblePages, zoomAt, type PageFit, type ReaderLayout,
} from "./pdf-geometry";
import { boundZoom, clamp, panAndPinch, type Contact, type Point, type Position, type Size } from "./viewport-geometry";
import { bindWebGestures, focusReaderFind } from "./web";
import { ZoomControls } from "./zoom-controls";

const initialPosition: Position = { x: 0, y: 0, scale: 1 };
const pageFindId = "omni-page-find";
type RenderPage = (page: number, pixels: number) => Promise<{ uri: string } | null>;
type ReaderKind = "pdf" | "office";

function quality(width: number) {
  return clamp(Math.ceil(width / 256) * 256, 256, 2560);
}

export function PdfPanel(props: PluginFilePanelProps) {
  const render = useRpc(renderPdfPage);
  const { workspaceId, file: { path } } = props;
  const renderPage = useCallback<RenderPage>((page, pixels) => render({ workspaceId, path, page, pixels }),
    [render, workspaceId, path]);
  return <PagedReader {...props} kind="pdf" render={renderPage} />;
}

export function OfficePanel(props: PluginFilePanelProps) {
  const render = useRpc(renderOfficePage);
  const { workspaceId, file: { path } } = props;
  const renderPage = useCallback<RenderPage>((page, pixels) => render({ workspaceId, path, page, pixels }),
    [render, workspaceId, path]);
  return <PagedReader {...props} kind="office" render={renderPage} />;
}

interface StoredView {
  version: string;
  geometry: ReaderLayout;
  position: Position;
  fit?: PageFit;
}

function resolvePosition(stored: StoredView | undefined, version: string, geometry: ReaderLayout) {
  if (!stored || stored.version !== version) return constrain(initialPosition, geometry);
  if (stored.geometry.viewport.width === geometry.viewport.width &&
    stored.geometry.viewport.height === geometry.viewport.height) return stored.position;
  const { position, geometry: previous } = stored;
  const previousTop = -position.y / position.scale;
  const number = pageAt(previous, previousTop);
  const previousPage = pageBounds(previous, number);
  const page = pageBounds(geometry, Math.min(number, geometry.pageCount));
  const fraction = (previousTop - previousPage.top) / previousPage.height;
  if (stored.fit) return fitPagePosition(geometry, Math.min(number, geometry.pageCount), stored.fit, fraction);
  return constrain({ ...position, y: -(page.top + page.height * fraction) * position.scale }, geometry);
}

const PageImage = memo(function PageImage({
  number, kind, label, errorLabel, retryLabel, render, enqueue, fileKey, left, top, width, height, pixels, theme, compact,
}: {
  number: number;
  kind: ReaderKind;
  label: string;
  errorLabel: string;
  retryLabel: string;
  render: RenderPage;
  enqueue: ReturnType<typeof createPageRenderQueue>;
  fileKey: readonly unknown[];
  left: number;
  top: number;
  width: number;
  height: number;
  pixels: number;
  theme: Theme;
  compact: boolean;
}) {
  const result = useQuery({
    queryKey: [...fileKey, "page", number, pixels],
    queryFn: ({ signal }) => enqueue(signal, () => render(number, pixels)),
    placeholderData: (previous) => previous ?? undefined,
    staleTime: Infinity,
    gcTime: 15_000,
    retry: (count, error) => count === 0 && error.message.includes("Reader is busy"),
  });
  return (
    <View pointerEvents={result.data ? "none" : "auto"} style={{
      position: "absolute", left, top, width, height,
      backgroundColor: result.data ? "#ffffff" : theme.colors.surface0,
    }}>
      {result.data ? (
        <Image testID={`omni-${kind}-page`} accessible accessibilityRole="image" accessibilityLabel={label}
          source={{ uri: result.data.uri }} resizeMode="stretch" resizeMethod="scale" fadeDuration={0}
          style={{ width: "100%", height: "100%" }} />
      ) : result.isPending ? <Loading /> : (
        <ReadError theme={theme} compact={compact} label={errorLabel} error={result.error}
          retry={retryLabel} onRetry={() => { void result.refetch(); }} />
      )}
    </View>
  );
});

function PagedReader(props: PluginFilePanelProps & { kind: ReaderKind; render: RenderPage }) {
  const { file, workspaceId, host, layout, theme, kind, render, tab } = props;
  const generation = useFileGeneration(file);
  const readLayout = useRpc(readDocumentLayout);
  const readText = useRpc(readDocumentText);
  const findText = useRpc(findDocumentText);
  const { t } = useTranslation(messages);
  const notify = useReaderNotice();
  const { scale: pixelRatio } = useWindowDimensions();
  const { compact, platform } = layout;
  const web = platform === "web";
  const tabActive = (tab as typeof tab & { active?: boolean }).active !== false;
  const slides = file.extension === "pptx";
  const pageFieldLabel = t(slides ? "slideNumber" : "page");
  const pageField = useWebTitle<TextInput>(pageFieldLabel);
  const errorLabel = t(kind === "pdf" ? "pdfError" : "officeError");
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [stored, setStored] = useState<StoredView>();
  const [draft, setDraft] = useState<string>();
  const [rasterScale, setRasterScale] = useState(1);
  const { findOpen, showFind, hideFind } = useReaderFindVisibility();
  const [slidesOpen, setSlidesOpen] = useState(slides);
  const [enqueue] = useState(createPageRenderQueue);
  const viewportRef = useRef<View>(null);
  const panelRef = useRef<View>(null);
  const pointers = useRef<Contact[]>([]);
  const operations = useRef<Parameters<typeof bindWebGestures>[1] | null>(null);
  const current = useRef<Position | null>(null);
  const beforeFind = useRef<StoredView>(undefined);

  const version = `${file.modifiedAt}:${generation}`;
  const fileKey = useMemo(() => ["omni-reader", kind, host.id, workspaceId, file.path, version],
    [kind, host.id, workspaceId, file.path, version]);
  const query = useQuery({
    queryKey: [...fileKey, kind === "office" ? "office-layout" : "layout"],
    queryFn: async ({ signal }) => {
      while (!signal.aborted) {
        const result = await readLayout({ workspaceId, path: file.path });
        if (result !== "loading") return result;
      }
      throw new Error("The document preview was cancelled.");
    },
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
  });
  const geometry = useMemo(() => query.data && viewport.width > 0 && viewport.height > 0
    ? fitPages(query.data, viewport)
    : null, [query.data, viewport]);
  const position = geometry ? resolvePosition(stored, version, geometry) : null;
  const scale = position?.scale ?? 1;
  const page = geometry && position ? pageAt(geometry, -position.y / scale) : 1;
  const pageCount = geometry?.pageCount ?? 0;
  const activeFit = stored?.version === version ? stored.fit : "page";
  const enabled = tabActive && !!position;
  const find = useFindResults(fileKey, enabled && findOpen,
    (criteria) => findText({ workspaceId, path: file.path, ...criteria }));
  const matchesByPage = useMemo(() => {
    const grouped = new Map<number, PageTextMatch[]>();
    for (const match of find.matches) {
      const page = grouped.get(match[0]);
      if (page) page.push(match);
      else grouped.set(match[0], [match]);
    }
    return grouped;
  }, [find.matches]);
  const { first, last } = geometry && position ? visiblePages(geometry, position) : { first: 1, last: 0 };
  const textPages = enabled ? Array.from({ length: Math.min(8, last - first + 1) }, (_, index) => first + index) : [];
  const matchPage = find.active?.[0];
  if (matchPage !== undefined && !textPages.includes(matchPage)) textPages.push(matchPage);
  const textQueries = useQueries({
    queries: textPages.map((number) => ({
      queryKey: [...fileKey, "text", number],
      queryFn: ({ signal }: { signal: AbortSignal }) => enqueue(signal, () => readText({ workspaceId, path: file.path, page: number })),
      staleTime: Infinity, gcTime: 30_000, retry: false,
    })),
  });
  const matchText = matchPage === undefined ? undefined : textQueries[textPages.indexOf(matchPage)];
  const findTextPage = (point: Point, number?: number): TextPage | undefined => {
    const view = current.current;
    if (!geometry || !view) return;
    const target = number ?? pageAt(geometry, (point.y - view.y) / view.scale);
    const content = textQueries[textPages.indexOf(target)]?.data;
    if (!content?.glyphs?.length) return;
    const bounds = pageBounds(geometry, target);
    return {
      number: target, text: content.text, glyphs: content.glyphs,
      left: view.x + (geometry.width - bounds.width) * view.scale / 2, top: view.y + bounds.top * view.scale,
      width: bounds.width * view.scale, height: bounds.height * view.scale,
    };
  };
  const selection = usePageSelection(findTextPage, version);
  const showCopied = () => notify?.(t("copied"));
  const copySelection = async (text: string) => {
    if (!text) return;
    try {
      await copyText(text);
      showCopied();
    } catch {
      notify?.(t("textCopyError"), true);
    }
  };

  function update(convert: (position: Position, geometry: ReaderLayout) => Position) {
    if (!current.current || !geometry) return false;
    const before = current.current;
    const next = convert(before, geometry);
    if (before.x === next.x && before.y === next.y && before.scale === next.scale) return false;
    current.current = next;
    setStored({ version, geometry, position: next, fit: next.scale === before.scale ? activeFit : undefined });
    return true;
  }

  function pan(previous: Contact[], next: Contact[]) {
    update((current, dimensions) => constrain(panAndPinch(current, previous, next), dimensions));
  }

  function track(next: Contact[], pointer: string) {
    const previous = pointers.current;
    pointers.current = next;
    if (selection.track(next, pointer)) return true;
    pan(previous, next);
  }
  const { handlers: nativeGestures, stopInertia } = useNativeContacts(viewportRef, enabled && !web, pan, ({ x, y }) =>
    update((position, dimensions) => constrain({ ...position, x: position.x + x, y: position.y + y }, dimensions)),
    (contacts) => selection.track(contacts, "touch"));

  const changeZoom = (resolve: (scale: number) => number) => {
    stopInertia();
    update((current, dimensions) => zoomAt(current, boundZoom(resolve(current.scale)),
      { x: viewport.width / 2, y: Math.min(viewport.height / 2, 120) }, dimensions));
  };
  const stepZoom = (factor: number) => changeZoom((scale) => scale * factor);
  const goTo = (target: number) => {
    stopInertia();
    update((current, dimensions) => jumpToPage(current, clamp(target, 1, dimensions.pageCount), dimensions));
  };
  const fit = (mode: PageFit) => {
    stopInertia();
    const view = current.current;
    if (!geometry || !view) return;
    const number = pageAt(geometry, -view.y / view.scale);
    const next = fitPagePosition(geometry, number, mode);
    current.current = next;
    setStored({ version, geometry, position: next, fit: mode });
  };
  const commitPage = () => {
    if (draft && /^\d+$/.test(draft)) goTo(Number(draft));
    setDraft(undefined);
  };
  const openFind = () => {
    if (findOpen) return focusReaderFind(panelRef.current, pageFindId);
    if (!web && geometry && current.current) {
      stopInertia();
      beforeFind.current = { position: current.current, version, geometry, fit: activeFit };
    }
    const selected = selection.text();
    if (selected && !selected.includes("\n")) find.changeQuery(selected.slice(0, 256));
    showFind();
  };
  const closeFind = () => {
    const saved = beforeFind.current;
    beforeFind.current = undefined;
    if (saved?.version === version) {
      stopInertia();
      setStored(saved);
    }
    hideFind();
  };
  useReaderFindShortcuts(panelRef, pageFindId, web && enabled,
    { open: openFind, close: closeFind, move: find.move, isOpen: () => findOpen }, viewportRef);
  const revealMatch = useRef<(match: PageTextMatch, glyphs?: PageGlyph[]) => void>(undefined);
  revealMatch.current = ([number, start, end], glyphs) => {
    const glyph = glyphs?.find(([first, last]) => last > start && first < end);
    if (!glyph) {
      goTo(number);
      return;
    }
    stopInertia();
    update((view, dimensions) => {
      const bounds = pageBounds(dimensions, number);
      const x = ((dimensions.width - bounds.width) / 2 + glyph[2] * bounds.width) * view.scale;
      const y = (bounds.top + glyph[3] * bounds.height) * view.scale;
      const right = x + (glyph[4] - glyph[2]) * bounds.width * view.scale;
      const bottom = y + (glyph[5] - glyph[3]) * bounds.height * view.scale;
      const margin = 12;
      const top = y + view.y >= margin && bottom + view.y <= viewport.height - margin
        ? view.y : viewport.height * 0.42 - y;
      return constrain({
        ...view,
        x: x + view.x >= margin && right + view.x <= viewport.width - margin ? view.x : viewport.width / 2 - x,
        y: Math.min(top, -bounds.top * view.scale),
      }, dimensions);
    });
  };

  useLayoutEffect(() => {
    current.current = position;
    operations.current = {
      contacts: track,
      overText: selection.overText,
      selectedText: selection.text,
      onCopied: showCopied,
      scroll: (delta) => update((position, dimensions) =>
        constrain({ ...position, x: position.x - delta.x, y: position.y - delta.y }, dimensions)),
      zoom: stepZoom,
      fit: () => fit("page"),
    };
  });
  useLayoutEffect(() => stopInertia(), [geometry, stopInertia, version]);
  useEffect(() => {
    if (find.active && (matchText?.isSuccess || matchText?.isError)) {
      revealMatch.current?.(find.active, matchText.data?.glyphs);
    }
  }, [geometry, matchText?.data, matchText?.isError, matchText?.isSuccess, find.active]);
  useEffect(() => {
    if (rasterScale === scale) return;
    const timeout = setTimeout(() => setRasterScale(scale), 150);
    return () => clearTimeout(timeout);
  }, [rasterScale, scale]);
  useEffect(() => {
    pointers.current = [];
  }, [enabled, version]);
  useEffect(() => {
    if (!web || !enabled) return;
    return bindWebGestures(viewportRef.current, {
      contacts: (contacts, pointer) => operations.current?.contacts(contacts, pointer),
      overText: (point) => operations.current?.overText?.(point) ?? false,
      selectedText: () => operations.current?.selectedText?.() ?? "",
      onCopied: () => operations.current?.onCopied?.(),
      scroll: (delta) => operations.current?.scroll(delta),
      zoom: (factor) => operations.current?.zoom(factor),
      fit: () => operations.current?.fit(),
    });
  }, [web, enabled]);

  if (kind === "office" && query.data === null) return <StructuredPanel {...props} />;
  let pages: React.ReactNode;
  if (tabActive && geometry && position) {
    const numbers = Array.from({ length: Math.min(last - first + 1, 20) }, (_, index) => first + index);
    const before = Math.max(1, first - 1);
    const after = Math.min(pageCount, last + 1);
    if (!web && last < after) numbers.push(after);
    if (!web && before < first) numbers.push(before);
    const origin = web ? 0 : pageBounds(geometry, before).top;
    const pageScale = web ? scale : 1;
    const images = numbers.map((number) => {
      const bounds = pageBounds(geometry, number);
      const left = (geometry.width - bounds.width) * pageScale / 2 + (web ? position.x : 0);
      const top = (bounds.top - origin) * pageScale + (web ? position.y : 0);
      const width = bounds.width * pageScale;
      const height = bounds.height * pageScale;
      const range = selection.selection;
      const matches = matchesByPage.get(number);
      const layer = range?.page === number || matches ? textQueries[textPages.indexOf(number)]?.data?.glyphs : undefined;
      return <View key={`${version}:${number}`} pointerEvents="box-none"
        style={{ position: "absolute", left, top, width, height }}>
        <PageImage {...{
          number, kind, fileKey, render, enqueue, theme, compact, errorLabel, left: 0, top: 0, width, height,
          label: `${t(slides ? "slide" : "page")} ${number}`, retryLabel: t("retry"),
          pixels: quality(bounds.width * rasterScale * Math.min(2, pixelRatio)),
        }} />
        {layer && matches && <PageFindOverlay {...{ width, height, glyphs: layer, matches }} active={find.active} />}
        {layer && range?.page === number && <PageSelectionOverlay {...{ width, height, glyphs: layer, range }}
          handles={!web || compact} accent={theme.colors.accent} scale={web ? 1 : scale} />}
      </View>;
    });
    const bottom = pageBounds(geometry, after);
    pages = web ? images : (
      <View pointerEvents="box-none" style={{
        position: "absolute", left: 0, top: 0, width: geometry.width, height: bottom.top + bottom.height - origin,
        transformOrigin: [0, 0, 0],
        transform: [{ translateX: position.x }, { translateY: position.y + origin * scale }, { scale }],
      }}>{images}</View>
    );
  }
  const findControl = <Control title={t("find")} icon="Search" disabled={!position} selected={findOpen}
    onPress={findOpen ? closeFind : openFind} theme={theme} compact={compact} />;
  const zoomControls = <ZoomControls {...{ scale, theme, compact, stepZoom }} disabled={!position}
    setZoom={(scale) => changeZoom(() => scale)} />;
  const applyPage = draft !== undefined && <Control title={t(slides ? "goToSlide" : "goToPage")} icon="CornerDownLeft"
    onPress={() => { commitPage(); Keyboard.dismiss(); }} theme={theme} compact={compact} small={!web} />;
  const pageControls = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
      <Control title={t(slides ? "previousSlide" : "previous")} icon="ChevronLeft" disabled={page <= 1} onPress={() => goTo(page - 1)}
        theme={theme} compact={compact} small={!web} />
      <TextInput
        ref={pageField}
        accessibilityLabel={pageFieldLabel}
        testID="omni-pdf-page-number"
        value={draft ?? String(page)}
        maxLength={7}
        inputMode="numeric"
        keyboardType="number-pad"
        returnKeyType="go"
        selectTextOnFocus
        onChangeText={setDraft}
        onSubmitEditing={commitPage}
        onBlur={commitPage}
        editable={!!pageCount}
        style={{
          color: theme.colors.foreground, borderColor: theme.colors.border,
          borderWidth: 1, borderRadius: 5, textAlign: "center", paddingHorizontal: 4, paddingVertical: 0,
          width: pageCount > 999 ? web ? 62 : 50 : web ? 42 : 38, height: web && compact ? 36 : 28,
        }}
      />
      {web && applyPage}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>/ {pageCount || "…"}</Text>
      {(!web && applyPage) || <Control title={t(slides ? "nextSlide" : "next")} icon="ChevronRight" disabled={page >= pageCount}
        onPress={() => goTo(page + 1)} theme={theme} compact={compact} small={!web} />}
    </View>
  );
  return (
    <View ref={panelRef} testID={`omni-${kind}-reader`} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface1 }}>
      <Toolbar theme={theme} filePanel={props} nativePrimary={!web && <>{pageControls}{zoomControls}</>}>
        {web && <>{pageControls}{zoomControls}</>}
        <Control title={t("fitWidth")} icon="MoveHorizontal" disabled={!position} selected={activeFit === "width"}
          onPress={() => fit("width")} theme={theme} compact={compact} />
        <Control title={t(slides ? "slideFit" : "reset")} icon="Scan" disabled={!position} selected={activeFit === "page"}
          onPress={() => fit("page")} theme={theme} compact={compact} />
        {findControl}
        {slides && <Control title={t("thumbnails")} icon="PanelLeft" selected={slidesOpen}
          onPress={() => setSlidesOpen((open) => !open)} theme={theme} compact={compact} />}
        <ExternalFileAction {...props} />
      </Toolbar>
      <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
        {slidesOpen && <SlideSidebar count={tabActive ? pageCount : 0} {...{ page, goTo, theme, compact }}
          preview={{ fileKey, enqueue, render }} />}
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          <View
            ref={viewportRef}
            testID={`omni-${kind}-viewport`}
            accessibilityLabel={t("documentPages")}
            tabIndex={web && enabled ? 0 : undefined}
            onLayout={({ nativeEvent: { layout: bounds } }) => setViewport((previous) =>
              bounds.width === previous.width && bounds.height === previous.height
                ? previous
                : { width: bounds.width, height: bounds.height },
            )}
            {...nativeGestures}
            style={[
              { flex: 1, minHeight: 0, overflow: "hidden" },
              web && ({ touchAction: "none", userSelect: "none" } as ViewStyle),
            ]}
          >
            {!tabActive ? null : pages ?? (query.isError ? (
              <ReadError theme={theme} compact={compact} label={errorLabel} error={query.error}
                retry={t("retry")} onRetry={() => { void query.refetch(); }} />
            ) : <Loading />)}
            {tabActive && selection.text() && (
              <View style={[{ position: "absolute", right: 8, borderWidth: 1, borderRadius: 7,
                borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
              findOpen ? { bottom: 8 } : { top: 8 }]}>
                <Control title={t("copySelection")} icon="Copy" onPress={() => { void copySelection(selection.text()); }}
                  theme={theme} compact={compact} />
              </View>
            )}
          </View>
          {findOpen && <ReaderFindBar testID={pageFindId} find={find} theme={theme} compact={compact} close={closeFind} />}
        </View>
      </View>
    </View>
  );
}
