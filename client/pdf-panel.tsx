import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Image, Keyboard, Text, TextInput, View, useWindowDimensions, type GestureResponderEvent, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { renderPdfPage } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration } from "./controls";
import { messages } from "./messages";
import { clamp, constrain, moveContacts, widthScale, zoomAt, type Contact, type Point, type Position, type Size } from "./pdf-geometry";
import { bindWebGestures } from "./web";

function quality(width: number) {
  return clamp(Math.ceil(width / 256) * 256, 256, 2560);
}

function nativeContacts(event: GestureResponderEvent): Contact[] {
  return [...event.nativeEvent.touches].slice(0, 2)
    .map(({ identifier, locationX, locationY }) => ({ id: Number(identifier), x: locationX, y: locationY }))
    .sort((first, second) => first.id - second.id);
}

export function PdfPanel(props: PluginFilePanelProps) {
  return <PdfReader key={props.file.path} {...props} />;
}

function PdfReader({ file, workspaceId, host, layout, theme }: PluginFilePanelProps) {
  const generation = useFileGeneration(file);
  const rpc = useRpc(renderPdfPage);
  const { t } = useTranslation(messages);
  const { scale: pixelRatio } = useWindowDimensions();
  const { compact, platform } = layout;
  const web = platform === "web";
  const [viewport, setViewport] = useState<Size>({ width: 0, height: 0 });
  const [page, setPage] = useState(1);
  const [number, setNumber] = useState("1");
  const [pageCount, setPageCount] = useState(0);
  const [requested, setRequested] = useState<{ key: string; width: number }>();
  const [position, setPosition] = useState<{ key: string; value: Position }>();
  const viewportRef = useRef<View>(null);
  const pointers = useRef<Contact[]>([]);
  const operations = useRef<Parameters<typeof bindWebGestures>[1] | null>(null);
  const active = useRef<Position | null>(null);

  const fileVersion = `${file.modifiedAt}:${generation}`;
  const viewKey = `${fileVersion}:${page}:${viewport.width}`;
  const pixels = requested?.key === viewKey ? requested.width : quality(viewport.width * Math.min(2, pixelRatio));
  const query = useQuery({
    queryKey: ["omni-reader", "pdf", host.id, workspaceId, file.path, fileVersion, page, pixels],
    queryFn: () => rpc({ workspaceId, path: file.path, page, pixels }),
    enabled: viewport.width > 0,
    placeholderData: (previous, source) =>
      source?.queryKey[5] === fileVersion && source.queryKey[6] === page ? previous : undefined,
    staleTime: Infinity,
    gcTime: 20_000,
    retry: false,
  });
  const image = query.data;
  const size: Size | null = image && viewport.width > 0
    ? { width: image.width, height: image.height }
    : null;
  const fit = size ? widthScale(size, viewport) : 1;
  const visible = size
    ? constrain(position?.key === viewKey ? position.value : { x: 0, y: 0, scale: fit }, size, viewport)
    : null;

  const goTo = (target: number) => {
    const next = clamp(target, 1, pageCount || 1);
    setPage(next);
    setNumber(String(next));
  };
  const commitPage = () => goTo(/^\d+$/.test(number) ? Number(number) : page);

  useEffect(() => {
    if (!image) return;
    setPageCount(image.pages);
    if (image.page !== page) {
      setPage(image.page);
      setNumber(String(image.page));
    }
  }, [image?.page, image?.pages, page]);

  const renderedWidth = size && visible ? size.width * visible.scale : viewport.width;
  const wanted = quality(renderedWidth * Math.min(2, pixelRatio));
  useEffect(() => {
    if (!renderedWidth || wanted === pixels) return;
    const timeout = setTimeout(() => setRequested({ key: viewKey, width: wanted }), 180);
    return () => clearTimeout(timeout);
  }, [pixels, renderedWidth, viewKey, wanted]);

  function update(convert: (current: Position, dimensions: Size) => Position) {
    if (!active.current || !size) return;
    const value = convert(active.current, size);
    active.current = value;
    setPosition({ key: viewKey, value });
  }

  function track(next: Contact[]) {
    const previous = pointers.current;
    pointers.current = next;
    if (next.length && previous.length) {
      update((current, dimensions) => moveContacts(current, previous, next, dimensions, viewport));
    }
  }

  const zoom = (factor: number, anchor: Point = { x: viewport.width / 2, y: viewport.height / 2 }) =>
    update((current, dimensions) => zoomAt(current, current.scale * factor, anchor, dimensions, viewport));

  useLayoutEffect(() => {
    active.current = visible;
    operations.current = {
      contacts: track,
      scroll: ({ x, y }) => update((current, dimensions) => constrain({
        ...current, x: current.x + x, y: current.y + y,
      }, dimensions, viewport)),
      zoom,
    };
  });
  useEffect(() => {
    pointers.current = [];
  }, [viewKey]);
  useEffect(() => {
    if (!web) return;
    return bindWebGestures(viewportRef.current, {
      contacts: (contacts) => operations.current?.contacts(contacts),
      scroll: (delta) => operations.current?.scroll(delta),
      zoom: (factor, anchor) => operations.current?.zoom(factor, anchor),
    });
  }, [web]);

  const hasImage = !!(image && visible);
  return (
    <View testID="omni-pdf-reader" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface1 }}>
      <Toolbar theme={theme}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
          <Control title="‹" label={t("previous")} disabled={page <= 1} onPress={() => goTo(page - 1)} theme={theme} compact={compact} />
          <TextInput
            accessibilityLabel={t("page")}
            testID="omni-pdf-page-number"
            value={number}
            maxLength={7}
            inputMode="numeric"
            keyboardType="number-pad"
            returnKeyType="go"
            selectTextOnFocus
            onChangeText={setNumber}
            onSubmitEditing={commitPage}
            onBlur={commitPage}
            editable={!!pageCount}
            style={{
              color: theme.colors.foreground, borderColor: theme.colors.border,
              borderWidth: 1, borderRadius: 5, textAlign: "center", paddingHorizontal: 4,
              paddingVertical: 0, minWidth: pageCount > 999 ? 52 : 38, height: compact ? 36 : 28,
            }}
          />
          {number !== String(page) && <Control title="↵" label={t("goToPage")} onPress={() => { commitPage(); Keyboard.dismiss(); }} theme={theme} compact={compact} />}
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>/ {pageCount || "…"}</Text>
          <Control title="›" label={t("next")} disabled={page >= pageCount} onPress={() => goTo(page + 1)} theme={theme} compact={compact} />
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 3 }}>
          <Control title="−" label={t("zoomOut")} disabled={!hasImage} onPress={() => zoom(1 / 1.25)} theme={theme} compact={compact} />
          <Text testID="omni-pdf-zoom" style={{ minWidth: 40, textAlign: "center", color: theme.colors.foregroundMuted, fontSize: 13 }}>
            {visible ? `${Math.round(visible.scale * 100)}%` : "…"}
          </Text>
          <Control title="+" label={t("zoomIn")} disabled={!hasImage} onPress={() => zoom(1.25)} theme={theme} compact={compact} />
          <Control title={t("fitWidth")} disabled={!hasImage} onPress={() => update((_, dimensions) => constrain({ x: 0, y: 0, scale: fit }, dimensions, viewport))} theme={theme} compact={compact} />
          <Control title={t("reset")} disabled={!hasImage} onPress={() => update((_, dimensions) => constrain({ x: 0, y: 0, scale: 1 }, dimensions, viewport))} theme={theme} compact={compact} />
        </View>
      </Toolbar>
      <View
        ref={viewportRef}
        testID="omni-pdf-viewport"
        onLayout={({ nativeEvent: { layout: bounds } }) => setViewport((previous) =>
          bounds.width === previous.width && bounds.height === previous.height
            ? previous
            : { width: bounds.width, height: bounds.height },
        )}
        onStartShouldSetResponder={web ? undefined : () => hasImage}
        onMoveShouldSetResponder={web ? undefined : () => hasImage}
        onResponderGrant={web ? undefined : (event) => { pointers.current = nativeContacts(event); }}
        onResponderMove={web ? undefined : (event) => track(nativeContacts(event))}
        onResponderRelease={web ? undefined : () => track([])}
        onResponderTerminate={web ? undefined : () => track([])}
        onResponderTerminationRequest={web ? undefined : () => false}
        style={[
          { flex: 1, minHeight: 0, overflow: "hidden" },
          web && ({ touchAction: "none", userSelect: "none" } as ViewStyle),
        ]}
      >
        {image && size && visible ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute", left: 0, top: 0,
              width: size.width * visible.scale, height: size.height * visible.scale,
              transform: [{ translateX: visible.x }, { translateY: visible.y }],
            }}
          >
            <Image
              testID="omni-pdf-page"
              accessible
              accessibilityRole="image"
              accessibilityLabel={`${t("page")} ${image.page}`}
              source={{ uri: image.uri }}
              resizeMode="stretch"
              resizeMethod="scale"
              fadeDuration={0}
              style={{ backgroundColor: "#ffffff", width: "100%", height: "100%" }}
            />
          </View>
        ) : query.isError ? (
          <ReadError theme={theme} compact={compact} label={t("pdfError")} error={query.error} retry={t("retry")} onRetry={() => { void query.refetch(); }} />
        ) : <Loading />}
      </View>
    </View>
  );
}
