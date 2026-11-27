import { useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { readWorksheet, type Worksheet } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, type Theme } from "./controls";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import { boundZoom } from "./pdf-geometry";
import { ZoomControls } from "./zoom-controls";

const gutter = 48;
const headingHeight = 26;

function offsets(values: number[], scale: number) {
  let position = 0;
  return [0, ...values.map((value) => position += value * scale)];
}

function visibleRange(values: number[], start: number, length: number) {
  const end = values.findIndex((value) => value > start + length + 80);
  const last = end < 0 ? values.length - 1 : end;
  const first = values.findIndex((value) => value > start - 80);
  return { first: first < 0 ? last : Math.max(0, first - 1), end: last };
}

function columnName(column: number) {
  let name = "";
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function WorksheetGrid({ sheet, scale, theme }: { sheet: Worksheet; scale: number; theme: Theme }) {
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [left, setLeft] = useState(0);
  const [top, setTop] = useState(0);
  const columns = useMemo(() => offsets(sheet.columns, scale), [sheet.columns, scale]);
  const rows = useMemo(() => offsets(sheet.rows, scale), [sheet.rows, scale]);
  const width = columns[columns.length - 1];
  const height = rows[rows.length - 1];
  const columnRange = visibleRange(columns, Math.min(left, Math.max(0, width - viewport.width)), viewport.width);
  const rowRange = visibleRange(rows, Math.min(top, Math.max(0, height - viewport.height)), viewport.height);
  const cellIndex = useMemo(() => {
    const byRow = new Map<number, Map<number, Worksheet["cells"][number]>>();
    for (const cell of sheet.cells) {
      const [row, column] = cell;
      const cells = byRow.get(row) ?? new Map();
      cells.set(column, cell);
      byRow.set(row, cells);
    }
    return byRow;
  }, [sheet.cells]);
  const gridColor = theme.colors.border;
  const header = {
    position: "absolute", justifyContent: "center", alignItems: "center",
    backgroundColor: theme.colors.surface1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: gridColor,
  } as const;
  const headerText = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const rowNumbers = [];
  const columnLabels = [];
  const cells = [];
  const covered = new Set<number>();
  const columnCount = sheet.columns.length;

  const renderCell = (row: number, column: number, lastRow = row, lastColumn = column) => {
    const cell = cellIndex.get(row)?.get(column);
    const style = cell ? sheet.styles[cell[3]] : undefined;
    const cellWidth = columns[lastColumn + 1] - columns[column];
    const cellHeight = rows[lastRow + 1] - rows[row];
    if (cellWidth <= 0 || cellHeight <= 0) return null;
    return (
      <View key={`${row}:${column}`} style={{
        position: "absolute", left: columns[column], top: rows[row], width: cellWidth, height: cellHeight,
        justifyContent: "center", paddingHorizontal: 4 * scale, overflow: "hidden",
        backgroundColor: style?.fill ?? theme.colors.surface0,
        borderRightWidth: 1, borderBottomWidth: 1, borderColor: gridColor,
      }}>
        {cell?.[2] ? (
          <Text selectable numberOfLines={style?.wrap ? undefined : 1} style={{
            color: style?.color ?? (style?.fill ? "#181818" : theme.colors.foreground),
            textAlign: style?.align ?? (cell[4] ? "right" : "left"),
            fontSize: (style?.fontSize ?? 14) * scale,
            fontWeight: style?.bold ? "700" : "400", fontStyle: style?.italic ? "italic" : "normal",
            fontVariant: ["tabular-nums"],
          }}>{cell[2]}</Text>
        ) : null}
      </View>
    );
  };
  for (const [row, column, lastRow, lastColumn] of sheet.merges) {
    if (lastRow < rowRange.first || row >= rowRange.end || lastColumn < columnRange.first || column >= columnRange.end) continue;
    cells.push(renderCell(row, column, lastRow, lastColumn));
    for (let rowIndex = Math.max(row, rowRange.first); rowIndex <= Math.min(lastRow, rowRange.end - 1); rowIndex++) {
      for (let colIndex = Math.max(column, columnRange.first); colIndex <= Math.min(lastColumn, columnRange.end - 1); colIndex++) {
        covered.add(rowIndex * columnCount + colIndex);
      }
    }
  }
  for (let column = columnRange.first; column < columnRange.end; column++) {
    const size = columns[column + 1] - columns[column];
    if (size <= 0) continue;
    columnLabels.push(
      <View key={column} style={{ ...header, left: columns[column] - left, width: size, height: headingHeight }}>
        <Text style={headerText}>{columnName(column)}</Text>
      </View>,
    );
  }
  for (let row = rowRange.first; row < rowRange.end; row++) {
    const size = rows[row + 1] - rows[row];
    if (size <= 0) continue;
    rowNumbers.push(
      <View key={row} style={{ ...header, top: rows[row] - top, width: gutter, height: size }}>
        <Text style={headerText}>{row + 1}</Text>
      </View>,
    );
    for (let column = columnRange.first; column < columnRange.end; column++) {
      if (!covered.has(row * columnCount + column)) cells.push(renderCell(row, column));
    }
  }

  return (
    <View testID="omni-worksheet-grid" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      <View style={{ height: headingHeight, marginLeft: gutter, overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
        {columnLabels}
      </View>
      <View style={{ flex: 1, minHeight: 0, marginLeft: gutter }} onLayout={({ nativeEvent }) => {
        const { width, height } = nativeEvent.layout;
        setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
      }}>
        <ScrollView horizontal nestedScrollEnabled scrollEventThrottle={16}
          testID="omni-worksheet-horizontal" onScroll={({ nativeEvent }) => setLeft(Math.max(0, nativeEvent.contentOffset.x))}>
          <ScrollView nestedScrollEnabled scrollEventThrottle={16} style={{ width, height: viewport.height }}
            testID="omni-worksheet-vertical" onScroll={({ nativeEvent }) => setTop(Math.max(0, nativeEvent.contentOffset.y))}>
            <View style={{ width, height }}>{cells}</View>
          </ScrollView>
        </ScrollView>
      </View>
      <View pointerEvents="none" style={{ position: "absolute", top: headingHeight, bottom: 0, left: 0, width: gutter,
        overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
        {rowNumbers}
      </View>
      <View pointerEvents="none" style={{ ...header, top: 0, left: 0, width: gutter, height: headingHeight }} />
    </View>
  );
}

export function WorksheetPanel({ props, print }: { props: PluginFilePanelProps; print: ReactNode }) {
  const { file, host, workspaceId, theme, layout: { compact } } = props;
  const { t } = useTranslation(messages);
  const rpc = useRpc(readWorksheet);
  const generation = useFileGeneration(file);
  const [selected, setSelected] = useState(0);
  const [printMode, setPrintMode] = useState(false);
  const [scale, setScale] = useState(1);
  const result = useQuery({
    queryKey: ["omni-reader", "worksheet", host.id, workspaceId, file.path, file.modifiedAt, generation, selected],
    queryFn: () => rpc({ workspaceId, path: file.path, sheet: selected }),
    placeholderData: (previous) => previous,
    staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const sheet = result.isPlaceholderData ? undefined : result.data?.sheet;
  const names = result.data?.names ?? [];
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      {printMode ? print : (
        <>
          <Toolbar theme={theme}>
            <ZoomControls {...{ scale, theme, compact }} disabled={!sheet}
              stepZoom={(factor) => setScale((previous) => boundZoom(previous * factor))} setZoom={setScale} />
            <ExternalFileAction {...props} />
          </Toolbar>
          {sheet?.truncated && <Text style={{ padding: 8, color: theme.colors.foregroundMuted }}>{t("worksheetTruncated")}</Text>}
          {sheet?.rows.length && sheet.columns.length ? <WorksheetGrid key={selected} {...{ sheet, scale, theme }} />
            : result.isFetching ? <Loading />
            : result.isError ? <ReadError theme={theme} compact={compact} label={t("textError")} error={result.error}
                retry={t("retry")} onRetry={() => { void result.refetch(); }} />
            : <Text style={{ padding: 16, color: theme.colors.foregroundMuted }}>{t("empty")}</Text>}
        </>
      )}
      <View style={{ flexDirection: "row", borderTopWidth: 1, borderColor: theme.colors.border, alignItems: "center" }}>
        <Control title={t(printMode ? "worksheet" : "printLayout")} icon={printMode ? "Table2" : "Printer"}
          theme={theme} compact={compact} onPress={() => setPrintMode((previous) => !previous)} />
        {!printMode && (
          <ScrollView horizontal nestedScrollEnabled style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 2, gap: 4 }}>
            {names.map((name, index) => (
              <Control key={index} title={name || `${t("sheet")} ${index + 1}`} theme={theme} compact={compact}
                selected={index === selected} onPress={() => setSelected(index)} />
            ))}
          </ScrollView>
        )}
      </View>
    </View>
  );
}
