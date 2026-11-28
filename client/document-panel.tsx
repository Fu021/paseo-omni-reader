import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View, type FlatList as NativeFlatList } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { FlatList, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { readStructuredDocument, type DocumentBlock } from "../shared/contracts";
import { Control, ReadError, ReaderInput, Toolbar, useFileGeneration, type Theme } from "./controls";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import { SlideSidebar } from "./page-tools";
import { ReaderFindPopup, useReaderFindVisibility } from "./reader-find";

function DataTable({ block, theme }: {
  block: Extract<DocumentBlock, { kind: "table" }>; theme: Theme;
}) {
  const widths = useMemo(() => {
    const columns: number[] = [];
    for (const row of block.rows) {
      for (const [column, value] of row.entries()) {
        const length = value.length + (value.match(/[\u2e80-\uffef]/g)?.length ?? 0);
        columns[column] = Math.max(columns[column] ?? 0, Math.min(240, Math.max(84, 24 + 8 * length)));
      }
    }
    return columns;
  }, [block]);
  const renderRow = (row: string[], index: number) => (
    <View key={index} role="row" style={{
      flexDirection: "row", borderBottomWidth: 1, borderColor: theme.colors.border,
      backgroundColor: index % 2 ? theme.colors.surface1 : theme.colors.surface0,
    }}>
      {widths.map((width, column) => (
        <Text key={column} selectable style={{
          color: theme.colors.foreground, width, paddingHorizontal: 10, paddingVertical: 8,
          borderRightWidth: 1, borderColor: theme.colors.border,
        }}>{row[column] ?? ""}</Text>
      ))}
    </View>
  );
  return (
    <ScrollView
      horizontal nestedScrollEnabled testID="omni-document-table"
      style={{ flexGrow: 0, maxWidth: "100%" }}
      contentContainerStyle={{ borderLeftWidth: 1, borderTopWidth: 1, borderColor: theme.colors.border }}
    >
      <View>{block.rows.map(renderRow)}</View>
    </ScrollView>
  );
}

export function StructuredPanel(props: PluginFilePanelProps) {
  const { file, host, workspaceId, theme, layout: { compact } } = props;
  const { t } = useTranslation(messages);
  const rpc = useRpc(readStructuredDocument);
  const generation = useFileGeneration(file);
  const [selected, setSelected] = useState(0);
  const { findOpen: finding, showFind, hideFind } = useReaderFindVisibility();
  const [slidesOpen, setSlidesOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [jump, setJump] = useState<{ section: number; block: number }>();
  const documentList = useRef<NativeFlatList<DocumentBlock>>(null);
  const retries = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const result = useQuery({
    queryKey: ["omni-reader", "document", host.id, workspaceId, file.path, file.modifiedAt, generation],
    queryFn: () => rpc({ workspaceId, path: file.path }),
    staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const sections = result.data?.sections ?? [];
  const index = Math.min(selected, Math.max(0, sections.length - 1));
  const active = sections[index];
  const slides = file.extension === "pptx";
  const goTo = (section: number) => { setSelected(section); setJump(undefined); };
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle || !result.data) return [];
    return result.data.sections.flatMap((section, sectionIndex) => section.blocks.flatMap((block, blockIndex) => {
      const text = block.kind === "table" ? block.rows.flat().join(" · ") : block.text;
      const match = text.toLowerCase().indexOf(needle);
      if (match < 0) return [];
      return [{ section: sectionIndex, block: blockIndex, text: text.slice(Math.max(0, match - 35), match + needle.length + 85) }];
    }));
  }, [result.data, search]);
  useEffect(() => {
    if (!jump || index !== jump.section || !active || jump.block >= active.blocks.length) return;
    retries.current = 0;
    documentList.current?.scrollToIndex({ index: jump.block, animated: false });
    return () => clearTimeout(retry.current);
  }, [active, index, jump]);
  return (
    <View testID="omni-structured-panel" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme} filePanel={props}>
        {slides
          ? <Control title={t("thumbnails")} icon="PanelLeft" selected={slidesOpen}
            onPress={() => setSlidesOpen((open) => !open)} theme={theme} compact={compact} />
          : <Control title={t("find")} icon="Search" selected={finding} onPress={finding ? hideFind : showFind}
            theme={theme} compact={compact} disabled={!result.data} />}
        <ExternalFileAction {...props} />
      </Toolbar>
      <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 12, paddingVertical: 6 }}>
        {t("officeLayoutUnavailable")}
      </Text>
      {result.isPending && <Loading />}
      {result.isError && (
        <ReadError theme={theme} compact={compact} label={t("textError")} error={result.error}
          retry={t("retry")} onRetry={() => { void result.refetch(); }} />
      )}
      {!slides && sections.length > 1 && (
        <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 4, gap: 4 }}>
          {sections.map((section, sectionIndex) => (
            <Control key={sectionIndex}
              title={section.title || `${t("sheet")} ${sectionIndex + 1}`} onPress={() => goTo(sectionIndex)}
              selected={index === sectionIndex} theme={theme} compact={compact} />
          ))}
        </ScrollView>
      )}
      {result.data?.truncated && (
        <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 12, paddingVertical: 6 }}>{t("documentTruncated")}</Text>
      )}
      <View style={{ flex: 1, minHeight: 0, flexDirection: "row" }}>
        {slides && slidesOpen && <SlideSidebar count={sections.length} page={index + 1}
          goTo={(page) => goTo(page - 1)} theme={theme} compact={compact} />}
        <View style={{ flex: 1, minHeight: 0, minWidth: 0 }}>
          {active && (active.blocks.length > 0 || active.title && slides) ? (
            <FlatList
              ref={documentList} key={index} data={active.blocks} keyExtractor={(_, blockIndex) => String(blockIndex)}
              onScrollToIndexFailed={({ index: target, averageItemLength }) => {
                documentList.current?.scrollToOffset({ offset: target * (averageItemLength || 32), animated: false });
                if (++retries.current > 4) return;
                clearTimeout(retry.current);
                retry.current = setTimeout(() => documentList.current?.scrollToIndex({ index: target, animated: false }), 100);
              }}
              contentContainerStyle={{ padding: compact ? 16 : 24, gap: 12 }}
              ListHeaderComponent={active.title ? (
                <Text selectable accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 24, fontWeight: "600" }}>
                  {active.title}
                </Text>
              ) : null}
              renderItem={({ item }) => item.kind === "table" ? <DataTable block={item} theme={theme} />
                : (
                  <Text selectable accessibilityRole={item.heading ? "header" : undefined} style={{
                    color: theme.colors.foreground, fontSize: item.heading ? 21 : 16,
                    lineHeight: item.heading ? 28 : 24, fontWeight: item.heading ? "600" : "400",
                  }}>{item.text}</Text>
                )}
            />
          ) : result.data && <Text style={{ padding: 16, color: theme.colors.foregroundMuted }}>{t("empty")}</Text>}
          {finding && (
            <ReaderFindPopup testID="omni-structured-find" theme={theme}>
              <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
                <ReaderInput theme={theme} accessibilityLabel={t("find")} placeholder={t("searchPlaceholder")}
                  autoFocus={Platform.OS === "web"} value={search} maxLength={256} onChangeText={setSearch} />
                <Control title={t("closeFind")} icon="X" onPress={hideFind} theme={theme} compact={compact} />
              </View>
              {!!search.trim() && <FlatList style={{ maxHeight: 150, flexGrow: 0 }} data={matches}
                keyboardShouldPersistTaps="handled" keyExtractor={({ section, block }) => `${section}:${block}`}
                ListEmptyComponent={<Text style={{ color: theme.colors.foregroundMuted, padding: 8 }}>{t("noMatches")}</Text>}
                renderItem={({ item }) => <Text accessibilityRole="link" numberOfLines={2}
                  onPress={() => { setSelected(item.section); setJump(item); hideFind(); }}
                  style={{ color: theme.colors.foreground, padding: 8 }}>{item.text}</Text>} />}
            </ReaderFindPopup>
          )}
        </View>
      </View>
    </View>
  );
}
