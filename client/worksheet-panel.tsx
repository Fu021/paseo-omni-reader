import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Platform, Text, View, type TextStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { Loading } from "@getpaseo/plugin/client/ui";
import { readWorksheet, type Worksheet } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, type Theme } from "./controls";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import { useNativeContacts } from "./native-contacts";
import { ReaderScrollView as ScrollView } from "./reader-scroll";
import { boundZoom, constrainGrid, panAndPinch, zoomAround, type Position } from "./viewport-geometry";
import { setWebTitle } from "./web";
import { ZoomControls } from "./zoom-controls";

const gutter = 48;
const headingHeight = 26;
const webCellText = { overflowWrap: "anywhere", whiteSpace: "pre-wrap" } as TextStyle;

function offsets(values: number[], scale: number) {
  let position = 0;
  return [0, ...values.map((value) => position += value * scale)];
}

function upperOffset(values: number[], target: number) {
  let first = 0;
  let end = values.length;
  while (first < end) {
    const middle = Math.floor((first + end) / 2);
    if (values[middle] <= target) first = middle + 1;
    else end = middle;
  }
  return first;
}

function visibleRange(values: number[], start: number, length: number) {
  const last = values.length - 1;
  return {
    first: Math.min(last, Math.max(0, upperOffset(values, start - 80) - 1)),
    end: Math.min(last, upperOffset(values, start + length + 80)),
  };
}

function columnName(column: number) {
  let name = "";
  for (let value = column + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    name = String.fromCharCode(65 + (value - 1) % 26) + name;
  }
  return name;
}

function WorksheetGrid({ sheet, scale, theme, onZoom }: {
  sheet: Worksheet; scale: number; theme: Theme; onZoom: (scale: number) => void;
}) {
  const web = Platform.OS === "web";
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [left, setLeft] = useState(0);
  const [top, setTop] = useState(0);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0, scale });
  const current = useRef(position);
  const gridViewport = useRef<View>(null);
  const cellScale = web ? scale : 1;
  const columns = useMemo(() => offsets(sheet.columns, cellScale), [sheet.columns, cellScale]);
  const rows = useMemo(() => offsets(sheet.rows, cellScale), [sheet.rows, cellScale]);
  const width = columns[columns.length - 1];
  const height = rows[rows.length - 1];
  const content = useMemo(() => ({ width, height }), [width, height]);
  const zoom = web ? 1 : position.scale;
  const scrollLeft = web ? left : -position.x;
  const scrollTop = web ? top : -position.y;
  const { first: firstColumn, end: endColumn } = visibleRange(columns, scrollLeft / zoom, viewport.width / zoom);
  const { first: firstRow, end: endRow } = visibleRange(rows, scrollTop / zoom, viewport.height / zoom);
  function update(next: Position) {
    if (next.x === current.current.x && next.y === current.current.y && next.scale === current.current.scale) return false;
    current.current = next;
    setPosition(next);
    return true;
  }
  const { handlers: nativeGestures, stopInertia } = useNativeContacts(gridViewport, !web && viewport.width > 0, (previous, next) => {
    const before = current.current;
    const after = constrainGrid(panAndPinch(before, previous, next), viewport, content);
    update(after);
    if (after.scale !== before.scale) onZoom(after.scale);
  }, ({ x, y }) => {
    const position = current.current;
    return update(constrainGrid({ ...position, x: position.x + x, y: position.y + y }, viewport, content));
  });
  useLayoutEffect(() => {
    if (web) return;
    stopInertia();
    const anchor = { x: viewport.width / 2, y: viewport.height / 2 };
    update(constrainGrid(zoomAround(current.current, scale, anchor), viewport, content));
  }, [web, viewport, content, scale, stopInertia]);
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
  const cells = useMemo(() => renderCells(
    sheet, cellIndex, rows, columns, { firstRow, endRow, firstColumn, endColumn }, cellScale, theme,
  ), [sheet, cellIndex, rows, columns, firstRow, endRow, firstColumn, endColumn, cellScale, theme]);
  for (let column = firstColumn; column < endColumn; column++) {
    const size = (columns[column + 1] - columns[column]) * zoom;
    if (size <= 0) continue;
    columnLabels.push(
      <View key={column} style={{ ...header, left: columns[column] * zoom - scrollLeft, width: size, height: headingHeight }}>
        <Text style={headerText}>{columnName(column)}</Text>
      </View>,
    );
  }
  for (let row = firstRow; row < endRow; row++) {
    const size = (rows[row + 1] - rows[row]) * zoom;
    if (size <= 0) continue;
    rowNumbers.push(
      <View key={row} style={{ ...header, top: rows[row] * zoom - scrollTop, width: gutter, height: size }}>
        <Text style={headerText}>{row + 1}</Text>
      </View>,
    );
  }

  return (
    <View testID="omni-worksheet-grid" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      <View style={{ height: headingHeight, marginLeft: gutter, overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
        {columnLabels}
      </View>
      <View
        ref={gridViewport}
        collapsable={web}
        {...nativeGestures}
        style={{ flex: 1, minHeight: 0, marginLeft: gutter, overflow: "hidden" }}
        onLayout={({ nativeEvent }) => {
          const { width, height } = nativeEvent.layout;
          setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
        }}
      >
        {web ? (
          <ScrollView horizontal nestedScrollEnabled scrollEventThrottle={16}
            testID="omni-worksheet-horizontal" onScroll={({ nativeEvent }) => setLeft(Math.max(0, nativeEvent.contentOffset.x))}>
            <ScrollView nestedScrollEnabled scrollEventThrottle={16} style={{ width, height: viewport.height }}
              testID="omni-worksheet-vertical" onScroll={({ nativeEvent }) => setTop(Math.max(0, nativeEvent.contentOffset.y))}>
              <View style={{ width, height }}>{cells}</View>
            </ScrollView>
          </ScrollView>
        ) : (
          <View testID="omni-worksheet-touch" style={{
            position: "absolute", left: 0, top: 0, width, height, transformOrigin: [0, 0, 0],
            transform: [{ translateX: position.x }, { translateY: position.y }, { scale: zoom }],
          }}>{cells}</View>
        )}
      </View>
      <View pointerEvents="none" style={{ position: "absolute", top: headingHeight, bottom: 0, left: 0, width: gutter,
        overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
        {rowNumbers}
      </View>
      <View pointerEvents="none" style={{ ...header, top: 0, left: 0, width: gutter, height: headingHeight }} />
    </View>
  );
}

function renderCells(
  sheet: Worksheet,
  cellIndex: Map<number, Map<number, Worksheet["cells"][number]>>,
  rows: number[],
  columns: number[],
  { firstRow, endRow, firstColumn, endColumn }: { firstRow: number; endRow: number; firstColumn: number; endColumn: number },
  scale: number,
  theme: Theme,
) {
  const cells = [];
  const covered = new Set<number>();
  const columnCount = sheet.columns.length;
  const renderCell = (row: number, column: number, lastRow = row, lastColumn = column) => {
    const cell = cellIndex.get(row)?.get(column);
    const style = cell ? sheet.styles[cell[3]] : undefined;
    const fontSize = (style?.fontSize ?? 14) * scale;
    const cellWidth = columns[lastColumn + 1] - columns[column];
    const cellHeight = rows[lastRow + 1] - rows[row];
    if (cellWidth <= 0 || cellHeight <= 0) return null;
    return (
      <View key={`${row}:${column}`} style={{
        position: "absolute", left: columns[column], top: rows[row], width: cellWidth, height: cellHeight,
        justifyContent: "center", paddingHorizontal: 4 * scale, overflow: "hidden",
        backgroundColor: style?.fill ?? theme.colors.surface0,
        borderRightWidth: 1, borderBottomWidth: 1, borderColor: theme.colors.border,
      }}>
        {cell?.[2] ? (
          <Text selectable ref={Platform.OS === "web" ? (node) => setWebTitle(node, cell[2]) : undefined}
            style={[{
              color: style?.color ?? (style?.fill ? "#181818" : theme.colors.foreground),
              textAlign: style?.align ?? (cell[4] ? "right" : "left"),
              fontSize, lineHeight: fontSize * 1.22,
              fontWeight: style?.bold ? "700" : "400", fontStyle: style?.italic ? "italic" : "normal",
              fontVariant: ["tabular-nums"],
            }, Platform.OS === "web" && webCellText]}>{cell[2]}</Text>
        ) : null}
      </View>
    );
  };
  for (const [row, column, lastRow, lastColumn] of sheet.merges) {
    if (lastRow < firstRow || row >= endRow || lastColumn < firstColumn || column >= endColumn) continue;
    cells.push(renderCell(row, column, lastRow, lastColumn));
    for (let rowIndex = Math.max(row, firstRow); rowIndex <= Math.min(lastRow, endRow - 1); rowIndex++) {
      for (let colIndex = Math.max(column, firstColumn); colIndex <= Math.min(lastColumn, endColumn - 1); colIndex++) {
        covered.add(rowIndex * columnCount + colIndex);
      }
    }
  }
  for (let row = firstRow; row < endRow; row++) {
    if (rows[row] === rows[row + 1]) continue;
    for (let column = firstColumn; column < endColumn; column++) {
      if (!covered.has(row * columnCount + column)) cells.push(renderCell(row, column));
    }
  }
  return cells;
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
          {sheet?.rows.length && sheet.columns.length ? <WorksheetGrid key={selected} {...{ sheet, scale, theme }} onZoom={setScale} />
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
