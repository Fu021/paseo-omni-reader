import { useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { readMarkdownPage, type Fence } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration } from "./controls";
import { ExternalFileAction } from "./external-file";
import { RichMarkdown } from "./markdown";
import { messages } from "./messages";

const firstPage: { offset: number; revision?: string; fence?: Fence } = { offset: 0 };
const readingStyle = { width: "100%", maxWidth: 850, alignSelf: "center" } as const;

export function MarkdownPanel(props: PluginFilePanelProps) {
  const { file, workspaceId, host, theme, layout: { compact } } = props;
  const generation = useFileGeneration(file);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const { t } = useTranslation(messages);
  const read = useRpc(readMarkdownPage);
  const document = useInfiniteQuery({
    queryKey: ["omni-reader", "markdown", host.id, workspaceId, file.path, file.modifiedAt, generation, attempt],
    queryFn: ({ pageParam }) => read({ workspaceId, path: file.path, ...pageParam }),
    initialPageParam: firstPage,
    getNextPageParam: ({ nextOffset, revision, fence }) =>
      nextOffset === null ? undefined : { offset: nextOffset, revision, fence },
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
  });
  const rows = document.data?.pages ?? [];
  const loadMore = () => {
    if (document.hasNextPage && !document.isFetching) void document.fetchNextPage({ cancelRefetch: false });
  };
  const error = document.isError && <ReadError theme={theme} compact={compact} label={t("textError")}
    error={document.error} retry={t("retry")} onRetry={() => setAttempt((value) => value + 1)} />;

  return (
    <View testID="omni-text-panel" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme}>
        <Control title={t("preview")} icon="BookOpenText" selected={!source} onPress={() => setSource(false)} theme={theme} compact={compact} />
        <Control title={t("source")} icon="Code" selected={source} onPress={() => setSource(true)} theme={theme} compact={compact} />
        <ExternalFileAction {...props} />
      </Toolbar>
      {document.isPending && <Loading />}
      {!rows.length && error}
      {!!rows.length && (
        <FlatList
          key={`${generation}:${attempt}`}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          windowSize={3}
          onScroll={document.isError ? undefined : ({ nativeEvent }) => {
            const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
            if (contentOffset.y > 0 && contentSize.height - contentOffset.y <= layoutMeasurement.height * 1.65) loadMore();
          }}
          scrollEventThrottle={80}
          contentContainerStyle={{ paddingHorizontal: compact ? 14 : 24, paddingVertical: 16 }}
          renderItem={({ item, index }) => (
            <View style={[readingStyle, !source && index > 0 && { paddingTop: 12 }]}>
              {item.source.length === 0 && item.nextOffset === null && index === 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted }}>{t("empty")}</Text>
              ) : source ? (
                <Text selectable style={{
                  color: theme.colors.foreground, fontSize: compact ? 14 : 15, lineHeight: compact ? 21 : 24, fontFamily: "monospace",
                }}>{item.nextOffset === null ? item.source : item.source.replace(/\r?\n$/, "")}</Text>
              ) : <RichMarkdown theme={theme} text={item.markdown} compact={compact} hostId={host.id} />}
            </View>
          )}
          ListFooterComponent={
            <View style={[readingStyle, { alignItems: "flex-start", paddingTop: 8 }]}>
              {error || (document.isFetchingNextPage ? <ActivityIndicator color={theme.colors.foregroundMuted} />
                : document.hasNextPage && <Control title={t("loadMore")} onPress={loadMore} theme={theme} compact={compact} />)}
            </View>
          }
        />
      )}
    </View>
  );
}
