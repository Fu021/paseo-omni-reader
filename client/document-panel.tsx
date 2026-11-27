import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { readStructuredDocument, type DocumentBlock } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, type Theme } from "./controls";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import { ReaderFlatList as FlatList, ReaderScrollView as ScrollView } from "./reader-scroll";

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
  const result = useQuery({
    queryKey: ["omni-reader", "document", host.id, workspaceId, file.path, file.modifiedAt, generation],
    queryFn: () => rpc({ workspaceId, path: file.path }),
    staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const sections = result.data?.sections ?? [];
  const index = Math.min(selected, Math.max(0, sections.length - 1));
  const active = sections[index];
  const slides = file.extension === "pptx";
  return (
    <View testID="omni-structured-panel" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme}>
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
      {(sections.length > 1 || slides && !!sections.length) && (
        <ScrollView horizontal style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 4, gap: 4 }}>
          {sections.map((section, sectionIndex) => (
            <Control key={sectionIndex}
              title={(slides ? t("slide") : section.title || t("sheet")) + (slides || !section.title ? ` ${sectionIndex + 1}` : "")}
              onPress={() => setSelected(sectionIndex)} selected={index === sectionIndex} theme={theme} compact={compact} />
          ))}
        </ScrollView>
      )}
      {result.data?.truncated && (
        <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 12, paddingVertical: 6 }}>{t("documentTruncated")}</Text>
      )}
      {active && (active.blocks.length > 0 || active.title && slides) ? (
        <FlatList
          key={index} data={active.blocks} keyExtractor={(_, blockIndex) => String(blockIndex)}
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
    </View>
  );
}
