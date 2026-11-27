import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Image, Keyboard, Text, TextInput, View, useWindowDimensions, type GestureResponderEvent, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { readDocumentLayout, renderOfficePage, renderPdfPage } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, type Theme } from "./controls";
import { StructuredPanel } from "./document-panel";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import {
  boundZoom, clamp, constrain, fitPages, jumpToPage, moveContacts, pageAt, pageBounds, zoomAt,
  type Contact, type Point, type Position, type ReaderLayout, type Size,
} from "./pdf-geometry";
import { bindWebGestures } from "./web";

const initialPosition: Position = { x: 0, y: 0, scale: 1 };
type RenderPage = (page: number, pixels: number) => Promise<{ uri: string } | null>;
type ReaderKind = "pdf" | "office";

function quality(width: number) {
  return clamp(Math.ceil(width / 256) * 256, 256, 2560);
}

function nativeContacts(event: GestureResponderEvent, origin: Point): Contact[] {
  return [...event.nativeEvent.touches].slice(0, 2)
    .map(({ identifier, pageX, pageY }) => ({ id: Number(identifier), x: pageX - origin.x, y: pageY - origin.y }))
    .sort((first, second) => first.id - second.id);
}

export function PdfPanel(props: PluginFilePanelProps) {
  const render = useRpc(renderPdfPage);
  return <PagedReader {...props} kind="pdf" render={(page, pixels) => render({ workspaceId: props.workspaceId, path: props.file.path, page, pixels })} />;
}

export function OfficePanel(props: PluginFilePanelProps) {
  const render = useRpc(renderOfficePage);
  return <PagedReader {...props} kind="office" render={(page, pixels) => render({ workspaceId: props.workspaceId, path: props.file.path, page, pixels })} />;
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

function PageImage({ number, kind, label, errorLabel, retryLabel, render, fileKey, bounds, position, trackWidth, pixels, theme, compact }: {
  number: number;
  kind: ReaderKind;
  label: string;
  errorLabel: string;
  retryLabel: string;
  render: RenderPage;
  fileKey: readonly unknown[];
  bounds: Size & { top: number };
  position: Position;
  trackWidth: number;
  pixels: number;
  theme: Theme;
  compact: boolean;
}) {
  const result = useQuery({
    queryKey: [...fileKey, "page", number, pixels],
    queryFn: () => render(number, pixels),
    placeholderData: (previous) => previous ?? undefined,
    staleTime: Infinity,
    gcTime: 15_000,
    retry: (count, error) => count === 0 && error.message.includes("Reader is busy"),
  });
  return (
    <View style={{
      position: "absolute", left: position.x + (trackWidth - bounds.width) * position.scale / 2,
      top: position.y + bounds.top * position.scale, width: bounds.width * position.scale,
      height: bounds.height * position.scale,
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
}

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
  const errorLabel = t(kind === "pdf" ? "pdfError" : "officeError");
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [stored, setStored] = useState<StoredView>();
  const [draft, setDraft] = useState<string>();
  const [rasterScale, setRasterScale] = useState(1);
  const viewportRef = useRef<View>(null);
  const pointers = useRef<Contact[]>([]);
  const touchOrigin = useRef<Point>({ x: 0, y: 0 });
  const operations = useRef<Parameters<typeof bindWebGestures>[1] | null>(null);
  const current = useRef<Position | null>(null);

  const version = `${file.modifiedAt}:${generation}`;
  const fileKey = ["omni-reader", kind, host.id, workspaceId, file.path, version];
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
  const top = position ? -position.y / scale : 0;
  const first = geometry ? Math.max(1, page - 1) : 1;
  const last = geometry ? Math.min(pageCount, pageAt(geometry, top + viewport.height / scale) + 1, first + 19) : 0;

  function update(convert: (position: Position, geometry: ReaderLayout) => Position) {
    if (!current.current || !geometry) return;
    const next = convert(current.current, geometry);
    current.current = next;
    setStored({ version, geometry, position: next });
  }

  function track(next: Contact[]) {
    const previous = pointers.current;
    pointers.current = next;
    if (next.length && previous.length) update((current, dimensions) => moveContacts(current, previous, next, dimensions));
  }

  const onZoom = (factor: number) => update((current, dimensions) => zoomAt(
    current, boundZoom(current.scale * factor, current.scale),
    { x: viewport.width / 2, y: Math.min(viewport.height / 2, 120) }, dimensions,
  ));
  const goTo = (target: number) => update((current, dimensions) =>
    jumpToPage(current, clamp(target, 1, dimensions.pageCount), dimensions));
  const fit = (width: boolean) => update((current, dimensions) => {
    const number = pageAt(dimensions, -current.y / current.scale);
    const zoom = width ? viewport.width / pageBounds(dimensions, number).width : 1;
    return jumpToPage({ ...current, scale: zoom, x: (viewport.width - dimensions.width * zoom) / 2 }, number, dimensions);
  });
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
      zoom: onZoom,
      fit: () => fit(false),
    };
  });
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

  if (kind === "office" && query.data === null) return <StructuredPanel {...props} />;
  return (
    <View testID={`omni-${kind}-reader`} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface1 }}>
      <Toolbar theme={theme}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Control title="‹" label={t("previous")} disabled={page <= 1} onPress={() => goTo(page - 1)} theme={theme} compact={compact} />
          <TextInput
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
          {draft !== undefined && <Control title="↵" label={t("goToPage")} onPress={() => { commitPage(); Keyboard.dismiss(); }} theme={theme} compact={compact} />}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>/ {pageCount || "…"}</Text>
          <Control title="›" label={t("next")} disabled={page >= pageCount} onPress={() => goTo(page + 1)} theme={theme} compact={compact} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 3 }}>
          <Control title="−" label={t("zoomOut")} disabled={!position} onPress={() => onZoom(1 / 1.25)} theme={theme} compact={compact} />
          <Text testID="omni-pdf-zoom" style={{ minWidth: 40, textAlign: "center", color: theme.colors.foregroundMuted, fontSize: 13 }}>
            {position ? `${Math.round(scale * 100)}%` : "…"}
          </Text>
          <Control title="+" label={t("zoomIn")} disabled={!position} onPress={() => onZoom(1.25)} theme={theme} compact={compact} />
          <Control title={t("fitWidth")} disabled={!position} onPress={() => fit(true)} theme={theme} compact={compact} />
          <Control title={t("reset")} disabled={!position} onPress={() => fit(false)} theme={theme} compact={compact} />
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
        onStartShouldSetResponder={web ? undefined : () => enabled}
        onMoveShouldSetResponder={web ? undefined : () => enabled}
        onResponderGrant={web ? undefined : (event) => {
          const { pageX, pageY, locationX, locationY } = event.nativeEvent;
          touchOrigin.current = { x: pageX - locationX, y: pageY - locationY };
          pointers.current = nativeContacts(event, touchOrigin.current);
        }}
        onResponderMove={web ? undefined : (event) => track(nativeContacts(event, touchOrigin.current))}
        onResponderRelease={web ? undefined : () => track([])}
        onResponderTerminate={web ? undefined : () => track([])}
        onResponderTerminationRequest={web ? undefined : () => false}
        style={[
          { flex: 1, minHeight: 0, overflow: "hidden" },
          web && ({ touchAction: "none", userSelect: "none" } as ViewStyle),
        ]}
      >
        {geometry && position ? Array.from({ length: last - first + 1 }, (_, index) => {
          const number = first + index;
          const bounds = pageBounds(geometry, number);
          return <PageImage key={`${version}:${number}`} {...{
            number, kind, fileKey, render, bounds, position, theme, compact, errorLabel,
            label: `${pageLabel} ${number}`, retryLabel: t("retry"), trackWidth: geometry.width,
            pixels: quality(bounds.width * rasterScale * Math.min(2, pixelRatio)),
          }} />;
        }) : query.isError ? (
          <ReadError theme={theme} compact={compact} label={errorLabel} error={query.error}
            retry={t("retry")} onRetry={() => { void query.refetch(); }} />
        ) : <Loading />}
      </View>
    </View>
  );
}
