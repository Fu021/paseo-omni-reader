import { useCallback, useState } from "react";
import { ActivityIndicator, Text, View, type ListRenderItemInfo } from "react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import type { RpcOutput } from "@getpaseo/plugin";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { readMarkdownPage, type Fence, type TableContinuation } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration } from "./controls";
import { ExternalFileAction } from "./external-file";
import { RichMarkdown } from "./markdown";
import { messages } from "./messages";
import { ReaderFlatList as FlatList, ReaderScrollView as ScrollView } from "./reader-scroll";

const firstPage: { offset: number; revision?: string; fence?: Fence; table?: TableContinuation } = { offset: 0 };
const readingStyle = { width: "100%", maxWidth: 850, alignSelf: "center" } as const;
type Page = RpcOutput<typeof readMarkdownPage>;

export function MarkdownPanel(props: PluginFilePanelProps) {
  const { file, workspaceId, host, theme, layout: { compact, platform } } = props;
  const generation = useFileGeneration(file);
  const [attempt, setAttempt] = useState(0);
  const [source, setSource] = useState(false);
  const { t } = useTranslation(messages);
  const read = useRpc(readMarkdownPage);
  const document = useInfiniteQuery({
    queryKey: ["omni-reader", "markdown", host.id, workspaceId, file.path, file.modifiedAt, generation, attempt],
    queryFn: ({ pageParam }) => read({ workspaceId, path: file.path, ...pageParam }),
    initialPageParam: firstPage,
    getNextPageParam: ({ nextOffset, revision, fence, table }) =>
      nextOffset === null ? undefined : { offset: nextOffset, revision, fence, table },
    staleTime: Infinity,
    gcTime: 30_000,
    retry: false,
  });
  const rows = document.data?.pages ?? [];
  const { hasNextPage, isFetching, fetchNextPage } = document;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage({ cancelRefetch: false });
  }, [fetchNextPage, hasNextPage, isFetching]);
  const error = document.isError && <ReadError theme={theme} compact={compact} label={t("textError")}
    error={document.error} retry={t("retry")} onRetry={() => setAttempt((value) => value + 1)} />;
  const singlePage = platform !== "web" && rows.length === 1 && rows[0].nextOffset === null;
  const scrollKey = `${generation}:${attempt}`;
  const contentStyle = { paddingHorizontal: compact ? 14 : 24, paddingVertical: 16 };
  const renderPage = useCallback(({ item, index }: Pick<ListRenderItemInfo<Page>, "item" | "index">) => (
    <View style={[readingStyle, !source && index > 0 && { paddingTop: 12 }]}>
      {item.source.length === 0 && item.nextOffset === null && index === 0 ? (
        <Text style={{ color: theme.colors.foregroundMuted }}>{t("empty")}</Text>
      ) : source ? (
        <Text selectable style={{
          color: theme.colors.foreground, fontSize: compact ? 14 : 15, lineHeight: compact ? 21 : 24, fontFamily: "monospace",
        }}>{item.nextOffset === null ? item.source : item.source.replace(/\r?\n$/, "")}</Text>
      ) : <RichMarkdown theme={theme} text={item.markdown} compact={compact} hostId={host.id} />}
    </View>
  ), [compact, host.id, source, t, theme]);

  return (
    <View testID="omni-text-panel" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme}>
        <Control title={t("preview")} icon="BookOpenText" selected={!source} onPress={() => setSource(false)} theme={theme} compact={compact} />
        <Control title={t("source")} icon="Code" selected={source} onPress={() => setSource(true)} theme={theme} compact={compact} />
        <ExternalFileAction {...props} />
      </Toolbar>
      {document.isPending && <Loading />}
      {!rows.length && error}
      {singlePage && (
        <ScrollView key={scrollKey} directionalLockEnabled contentContainerStyle={contentStyle}>
          {renderPage({ item: rows[0], index: 0 })}
        </ScrollView>
      )}
      {!!rows.length && !singlePage && (
        <FlatList
          key={scrollKey}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          initialNumToRender={1}
          maxToRenderPerBatch={1}
          windowSize={3}
          directionalLockEnabled
          onEndReached={document.hasNextPage && !document.isError ? loadMore : undefined}
          onEndReachedThreshold={0.65}
          contentContainerStyle={contentStyle}
          renderItem={renderPage}
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
