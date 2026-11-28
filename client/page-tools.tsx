import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Platform, Pressable, Text, View, type FlatList as NativeFlatList } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "@getpaseo/plugin/client";
import { FlatList } from "@getpaseo/plugin/client/ui";
import type { Theme } from "./controls";
import { messages } from "./messages";
import type { createPageRenderQueue } from "./page-render-queue";

type SlidePreview = {
  fileKey: readonly unknown[];
  enqueue: ReturnType<typeof createPageRenderQueue>;
  render: (page: number, pixels: number) => Promise<{ uri: string } | null>;
};

function SlideImage({ number, theme, fileKey, enqueue, render }: SlidePreview & { number: number; theme: Theme }) {
  const result = useQuery({
    queryKey: [...fileKey, "thumbnail", number], queryFn: ({ signal }) => enqueue(signal, () => render(number, 256)),
    staleTime: Infinity, gcTime: 30_000, retry: (count, error) => count === 0 && error.message.includes("Reader is busy"),
  });
  return result.data ? <Image accessible={false} source={{ uri: result.data.uri }} resizeMode="contain" fadeDuration={0}
    style={{ width: "100%", flex: 1 }} /> : <View style={{ flex: 1, justifyContent: "center" }}>
    {result.isPending && <ActivityIndicator color={theme.colors.foregroundMuted} />}
  </View>;
}

export function SlideSidebar({ count, page, goTo, theme, compact, preview }: {
  count: number; page: number; goTo: (page: number) => void; theme: Theme; compact: boolean; preview?: SlidePreview;
}) {
  const { t } = useTranslation(messages);
  const rowHeight = preview ? compact ? 66 : 92 : 44;
  const gap = 6;
  const slides = useMemo(() => Array.from({ length: count }, (_, index) => index + 1), [count]);
  const list = useRef<NativeFlatList<number>>(null);
  const offset = useRef(0);
  const [height, setHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  useEffect(() => {
    if (!height || !contentHeight || page > count) return;
    const top = gap + rowHeight * (page - 1);
    const bottom = top + rowHeight - gap;
    if (top < offset.current || bottom > offset.current + height) {
      list.current?.scrollToIndex({ index: page - 1, viewPosition: 0.5, animated: false });
    }
  }, [contentHeight, count, gap, height, page, rowHeight]);
  return (
    <View testID="omni-slide-sidebar" style={{
      width: compact ? 72 : 124, maxWidth: "28%", flexShrink: 0,
      borderRightWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0,
    }}>
      <FlatList ref={list} accessibilityLabel={t("thumbnails")} keyboardShouldPersistTaps="handled" nestedScrollEnabled
        style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: gap }}
        data={slides} keyExtractor={String}
        initialNumToRender={5} windowSize={3} maxToRenderPerBatch={5}
        onLayout={({ nativeEvent: { layout } }) => setHeight(layout.height)}
        onContentSizeChange={(_, height) => setContentHeight(height)}
        onScroll={({ nativeEvent: { contentOffset } }) => { offset.current = contentOffset.y; }} scrollEventThrottle={16}
        getItemLayout={(_, index) => ({ index, length: rowHeight, offset: gap + rowHeight * index })}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button" accessibilityLabel={`${t("slide")} ${item}`}
            accessibilityState={{ selected: page === item }} onPress={() => goTo(item)}
            {...(Platform.OS === "web" ? { "aria-pressed": page === item } : {})}
            style={{ height: rowHeight - gap, marginBottom: gap, padding: 4, borderWidth: 1, borderRadius: 6,
              alignItems: "center", justifyContent: "center", backgroundColor: page === item ? theme.colors.surface2 : theme.colors.surface0,
              borderColor: page === item ? theme.colors.accent : theme.colors.border }}>
            {preview && <SlideImage {...preview} number={item} theme={theme} />}
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 12 }}>{item}</Text>
          </Pressable>
        )} />
    </View>
  );
}
