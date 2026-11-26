import { useState } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { markdownExtensions, readTextPage, sourceExtensions, type Fence } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration } from "./controls";
import { messages } from "./messages";
import { RichMarkdown } from "./markdown";
import { ExternalFileAction } from "./external-file";

interface Cursor {
  offset: number;
  revision?: string;
  fence?: Fence;
}

const firstPage: Cursor = { offset: 0 };

export function TextPanel({ file, workspaceId, host, theme, layout }: PluginFilePanelProps) {
  const generation = useFileGeneration(file);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const { t } = useTranslation(messages);
  const rpc = useRpc(readTextPage);
  const markdown = markdownExtensions.includes(file.extension);
  const { compact } = layout;
  const document = useInfiniteQuery({
    queryKey: ["omni-reader", "text", host.id, workspaceId, file.path, file.modifiedAt, generation, attempt],
    queryFn: ({ pageParam }) => rpc({ workspaceId, path: file.path, ...pageParam }),
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
  const restart = () => setAttempt((value) => value + 1);
  const readingStyle = { width: "100%" as const, maxWidth: 850, alignSelf: "center" as const };
  return (
    <View testID="omni-text-panel" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme}>
        {markdown && (
          <>
            <Control title={t("preview")} selected={!source} onPress={() => setSource(false)} theme={theme} compact={compact} />
            <Control title={t("source")} selected={source} onPress={() => setSource(true)} theme={theme} compact={compact} />
          </>
        )}
        <ExternalFileAction file={file} theme={theme} compact={compact} />
      </Toolbar>
      {document.isPending && <Loading />}
      {!rows.length && document.isError && (
        <ReadError theme={theme} compact={compact} label={t("textError")} error={document.error} retry={t("retry")} onRetry={restart} />
      )}
      {!!rows.length && (
        <FlatList
          key={`${generation}:${attempt}`}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          windowSize={3}
          onEndReachedThreshold={0.65}
          onEndReached={document.isError ? undefined : loadMore}
          contentContainerStyle={{ paddingHorizontal: compact ? 14 : 24, paddingVertical: 16 }}
          renderItem={({ item, index }) => (
            <View style={[readingStyle, markdown && !source && index > 0 ? { paddingTop: 12 } : undefined]}>
              {item.size === 0 ? (
                <Text style={{ color: theme.colors.foregroundMuted }}>{t("empty")}</Text>
              ) : markdown && !source ? (
                <RichMarkdown theme={theme} text={item.markdown} compact={compact} hostId={host.id} />
              ) : (
                <Text selectable style={{
                  color: theme.colors.foreground, fontSize: compact ? 14 : 15, lineHeight: compact ? 21 : 24,
                  fontFamily: source || sourceExtensions.includes(file.extension) ? "monospace" : undefined,
                }}>
                  {item.nextOffset === null ? item.source : item.source.replace(/\r?\n$/, "")}
                </Text>
              )}
            </View>
          )}
          ListFooterComponent={
            <View style={[readingStyle, { alignItems: "flex-start", paddingTop: 8 }]}>
              {document.isError ? (
                <ReadError theme={theme} compact={compact} label={t("textError")} error={document.error} retry={t("retry")} onRetry={restart} />
              ) : document.isFetchingNextPage ? (
                <ActivityIndicator color={theme.colors.foregroundMuted} />
              ) : document.hasNextPage ? (
                <Control title={t("loadMore")} onPress={loadMore} theme={theme} compact={compact} />
              ) : null}
            </View>
          }
        />
      )}
    </View>
  );
}
