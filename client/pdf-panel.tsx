import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Image, Keyboard, Text, TextInput, View, useWindowDimensions, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { readDocumentLayout, renderOfficePage, renderPdfPage } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, useWebTitle, type Theme } from "./controls";
import { StructuredPanel } from "./document-panel";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import { useNativeContacts } from "./native-contacts";
import { createPageRenderQueue } from "./page-render-queue";
import {
  constrain, fitPages, jumpToPage, pageAt, pageBounds, visiblePages, zoomAt, type ReaderLayout,
} from "./pdf-geometry";
import { boundZoom, clamp, panAndPinch, type Contact, type Position, type Size } from "./viewport-geometry";
import { bindWebGestures } from "./web";
import { WorksheetPanel } from "./worksheet-panel";
import { ZoomControls } from "./zoom-controls";

const initialPosition: Position = { x: 0, y: 0, scale: 1 };
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
  const print = <PagedReader {...props} kind="office" render={renderPage} />;
  return props.file.extension === "xlsx" ? <WorksheetPanel props={props} print={print} /> : print;
}

interface StoredView {
  version: string;
  geometry: ReaderLayout;
  position: Position;
}

function resolvePosition(stored: StoredView | undefined, version: string, geometry: ReaderLayout) {
  if (!stored || stored.version !== version) return constrain(initialPosition, geometry);
  if (stored.geometry === geometry) return stored.position;
  const { position, geometry: previous } = stored;
  const previousTop = -position.y / position.scale;
  const number = pageAt(previous, previousTop);
  const previousPage = pageBounds(previous, number);
  const page = pageBounds(geometry, Math.min(number, geometry.pageCount));
  const fraction = (previousTop - previousPage.top) / previousPage.height;
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
    <View style={{
      position: "absolute", left, top, width, height,
      backgroundColor: result.data ? "#ffffff" : theme.colors.surface0,
    }}>
      {result.data ? (
        <View pointerEvents="none" style={{ flex: 1 }}>
          <Image testID={`omni-${kind}-page`} accessible accessibilityRole="image" accessibilityLabel={label}
            source={{ uri: result.data.uri }} resizeMode="stretch" resizeMethod="scale" fadeDuration={0}
            style={{ width: "100%", height: "100%" }} />
        </View>
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
  const { t } = useTranslation(messages);
  const { scale: pixelRatio } = useWindowDimensions();
  const { compact, platform } = layout;
  const web = platform === "web";
  const tabActive = (tab as typeof tab & { active?: boolean }).active !== false;
  const pageLabel = t(file.extension === "pptx" ? "slide" : "page");
  const pageField = useWebTitle<TextInput>(pageLabel);
  const errorLabel = t(kind === "pdf" ? "pdfError" : "officeError");
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [stored, setStored] = useState<StoredView>();
  const [draft, setDraft] = useState<string>();
  const [rasterScale, setRasterScale] = useState(1);
  const [enqueue] = useState(createPageRenderQueue);
  const viewportRef = useRef<View>(null);
  const pointers = useRef<Contact[]>([]);
  const operations = useRef<Parameters<typeof bindWebGestures>[1] | null>(null);
  const current = useRef<Position | null>(null);

  const version = `${file.modifiedAt}:${generation}`;
  const fileKey = useMemo(() => ["omni-reader", kind, host.id, workspaceId, file.path, version],
    [kind, host.id, workspaceId, file.path, version]);
  const query = useQuery({
    queryKey: [...fileKey, "layout"],
    queryFn: () => readLayout({ workspaceId, path: file.path }),
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
  const enabled = tabActive && !!position;
  const { first, last } = geometry && position ? visiblePages(geometry, position) : { first: 1, last: 0 };

  function update(convert: (position: Position, geometry: ReaderLayout) => Position) {
    if (!current.current || !geometry) return false;
    const before = current.current;
    const next = convert(before, geometry);
    if (before.x === next.x && before.y === next.y && before.scale === next.scale) return false;
    current.current = next;
    setStored({ version, geometry, position: next });
    return true;
  }

  function pan(previous: Contact[], next: Contact[]) {
    update((current, dimensions) => constrain(panAndPinch(current, previous, next), dimensions));
  }

  function track(next: Contact[]) {
    const previous = pointers.current;
    pointers.current = next;
    pan(previous, next);
  }
  const { handlers: nativeGestures, stopInertia } = useNativeContacts(viewportRef, enabled && !web, pan, ({ x, y }) =>
    update((position, dimensions) => constrain({ ...position, x: position.x + x, y: position.y + y }, dimensions)));

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
  const fit = (width: boolean) => {
    stopInertia();
    update((current, dimensions) => {
      const number = pageAt(dimensions, -current.y / current.scale);
      const zoom = width ? boundZoom(viewport.width / pageBounds(dimensions, number).width) : 1;
      return jumpToPage({ ...current, scale: zoom, x: (viewport.width - dimensions.width * zoom) / 2 }, number, dimensions);
    });
  };
  const commitPage = () => {
    if (draft && /^\d+$/.test(draft)) goTo(Number(draft));
    setDraft(undefined);
  };

  useLayoutEffect(() => {
    current.current = position;
    operations.current = {
      contacts: track,
      scroll: (delta) => update((position, dimensions) =>
        constrain({ ...position, x: position.x - delta.x, y: position.y - delta.y }, dimensions)),
      zoom: stepZoom,
      fit: () => fit(false),
    };
  });
  useLayoutEffect(() => stopInertia(), [geometry, stopInertia, version]);
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
      contacts: (contacts) => operations.current?.contacts(contacts),
      scroll: (delta) => operations.current?.scroll(delta),
      zoom: (factor) => operations.current?.zoom(factor),
      fit: () => operations.current?.fit(),
    });
  }, [web, enabled]);

  if (kind === "office" && query.data === null) {
    if (file.extension !== "xlsx") return <StructuredPanel {...props} />;
    return (
      <View style={{ flex: 1 }}>
        <Toolbar theme={theme}><ExternalFileAction {...props} /></Toolbar>
        <Text style={{ padding: 12, color: theme.colors.foregroundMuted }}>{t("printLayoutUnavailable")}</Text>
      </View>
    );
  }
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
      return <PageImage key={`${version}:${number}`} {...{
        number, kind, fileKey, render, enqueue, theme, compact, errorLabel, left, top,
        width: bounds.width * pageScale, height: bounds.height * pageScale,
        label: `${pageLabel} ${number}`, retryLabel: t("retry"),
        pixels: quality(bounds.width * rasterScale * Math.min(2, pixelRatio)),
      }} />;
    });
    const bottom = pageBounds(geometry, after);
    pages = web ? images : (
      <View style={{
        position: "absolute", left: 0, top: 0, width: geometry.width, height: bottom.top + bottom.height - origin,
        transformOrigin: [0, 0, 0],
        transform: [{ translateX: position.x }, { translateY: position.y + origin * scale }, { scale }],
      }}>{images}</View>
    );
  }
  return (
    <View testID={`omni-${kind}-reader`} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface1 }}>
      <Toolbar theme={theme}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Control title={t("previous")} icon="ChevronLeft" disabled={page <= 1} onPress={() => goTo(page - 1)} theme={theme} compact={compact} />
          <TextInput
            ref={pageField}
            accessibilityLabel={pageLabel}
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
              borderWidth: 1, borderRadius: 5, textAlign: "center", paddingHorizontal: 4,
              paddingVertical: 0, width: pageCount > 999 ? 62 : 42, height: compact ? 36 : 28,
            }}
          />
          {draft !== undefined && <Control title={t("goToPage")} icon="CornerDownLeft" onPress={() => { commitPage(); Keyboard.dismiss(); }} theme={theme} compact={compact} />}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>/ {pageCount || "…"}</Text>
          <Control title={t("next")} icon="ChevronRight" disabled={page >= pageCount} onPress={() => goTo(page + 1)} theme={theme} compact={compact} />
        </View>
        <ZoomControls {...{ scale, theme, compact, stepZoom }} disabled={!position} setZoom={(scale) => changeZoom(() => scale)} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Control title={t("fitWidth")} icon="MoveHorizontal" disabled={!position} onPress={() => fit(true)} theme={theme} compact={compact} />
          <Control title={t("reset")} icon="Scan" disabled={!position} onPress={() => fit(false)} theme={theme} compact={compact} />
          <ExternalFileAction {...props} />
        </View>
      </Toolbar>
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
      </View>
    </View>
  );
}
