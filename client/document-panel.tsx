import { useMemo, useState } from "react";
import { Image, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useFileUrl, useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { DocumentFrame, FlatList, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { imageExtensions, readStructuredDocument, type DocumentBlock } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, type Theme } from "./controls";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";

function DataTable({ block, theme, fill = false }: {
  block: Extract<DocumentBlock, { kind: "table" }>; theme: Theme; fill?: boolean;
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
      backgroundColor: block.header && index === 0 ? theme.colors.surface2 : index % 2 ? theme.colors.surface1 : theme.colors.surface0,
    }}>
      {widths.map((width, column) => (
        <Text key={column} selectable style={{
          color: theme.colors.foreground, width, paddingHorizontal: 10, paddingVertical: 8,
          borderRightWidth: 1, borderColor: theme.colors.border,
          fontWeight: block.header && index === 0 ? "600" : "400",
        }}>{row[column] ?? ""}</Text>
      ))}
    </View>
  );
  return (
    <ScrollView
      horizontal nestedScrollEnabled testID="omni-document-table"
      style={{ flexGrow: fill ? 1 : 0, maxWidth: "100%" }}
      contentContainerStyle={{ borderLeftWidth: 1, borderTopWidth: 1, borderColor: theme.colors.border }}
    >
      {fill ? (
        <FlatList data={block.rows} style={{ width: widths.reduce((sum, width) => sum + width, 0) }}
          nestedScrollEnabled keyExtractor={(_, index) => String(index)}
          renderItem={({ item, index }) => renderRow(item, index)} />
      ) : <View>{block.rows.map(renderRow)}</View>}
    </ScrollView>
  );
}

export function StructuredPanel(props: PluginFilePanelProps) {
  return <StructuredReader key={props.file.path} {...props} />;
}

function StructuredReader({ file, host, workspaceId, theme, layout: { compact } }: PluginFilePanelProps) {
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
  const tabular = file.extension === "xlsx" || file.extension === "csv" || file.extension === "tsv";
  const slides = file.extension === "pptx";
  return (
    <View testID="omni-structured-panel" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme}>
        <ExternalFileAction file={file} theme={theme} compact={compact} />
      </Toolbar>
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
      {tabular && active?.blocks[0]?.kind === "table" && active.blocks[0].rows.length > 0 ? (
        <DataTable key={index} block={active.blocks[0]} theme={theme} fill />
      ) : active && (active.blocks.length > 0 && !tabular || active.title && slides) ? (
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

export function VisualPanel({ file, theme, layout: { compact } }: PluginFilePanelProps) {
  const url = useFileUrl(file);
  const { t } = useTranslation(messages);
  const image = imageExtensions.includes(file.extension);
  const [failed, setFailed] = useState<string>();
  return (
    <View testID="omni-visual-panel" style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme}>
        <ExternalFileAction file={file} theme={theme} compact={compact} />
      </Toolbar>
      {url.status === "loading" ? <Loading /> : url.status === "error" || url.url === failed ? (
        <Text accessibilityRole="alert" style={{ color: theme.colors.foreground, padding: 16 }}>{t("textError")}</Text>
      ) : image ? (
        <Image testID="omni-file-image" accessibilityLabel={file.name} accessible source={{ uri: url.url }}
          onError={() => setFailed(url.url)} resizeMode="contain" style={{ flex: 1, width: "100%" }} />
      ) : <DocumentFrame testID="omni-file-frame" url={url.url} />}
    </View>
  );
}
