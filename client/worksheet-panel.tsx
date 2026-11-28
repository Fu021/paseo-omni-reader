import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View, type ScrollView as ScrollViewInstance, type TextStyle, type ViewStyle } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { useRpc, useTranslation, type PluginFilePanelProps } from "@getpaseo/plugin/client";
import { copyText, Icon, Loading, ScrollView } from "@getpaseo/plugin/client/ui";
import { findWorksheetText, readWorksheet, type Worksheet, type WorksheetMatch } from "../shared/contracts";
import { Control, ReadError, Toolbar, useFileGeneration, type Theme } from "./controls";
import { ExternalFileAction } from "./external-file";
import { messages } from "./messages";
import { useNativeContacts } from "./native-contacts";
import { ReaderFindBar, useFindResults, useReaderFindShortcuts, useReaderFindVisibility } from "./reader-find";
import { useReaderNotice } from "./reader-notice";
import { boundZoom, clamp, constrainGrid, panAndPinch, zoomAround, zoomGridScroll, type Contact, type Point, type Position, type Size } from "./viewport-geometry";
import { bindWorksheetGrid, bindWorksheetMenuDismiss, focusReaderFind, readerSelection, setWebTitle } from "./web";
import { ZoomControls } from "./zoom-controls";

const gutter = 48;
const headingHeight = 26;
const findId = "omni-worksheet-find";
const webCellText = { overflowWrap: "anywhere", whiteSpace: "pre-wrap" } as TextStyle;
type CellAddress = { row: number; column: number };
type FrozenAxes = Partial<CellAddress>;
type CellMenu = { address: CellAddress; point: Point };
type CellPress = { contact: Contact; timer: ReturnType<typeof setTimeout>; held: boolean };
type WorksheetHit = WorksheetMatch | [row: number, column: number];
const noPins: FrozenAxes = {};

function offsets(values: number[], scale: number) {
  let position = 0;
  return [0, ...values.map((value) => position += value * scale)];
}

function withoutTrack(values: number[], track?: number) {
  if (track === undefined) return values;
  const size = values[track + 1] - values[track];
  return values.map((offset, index) => index === track + 1 ? values[track] : index > track ? offset - size : offset);
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

function cellAddress(text: string): CellAddress | undefined {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/.exec(text.trim().toUpperCase());
  if (!match) return;
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  return { row: Number(match[2]) - 1, column: column - 1 };
}

function WorksheetGrid({ sheet, scale, theme, onZoom, focus, pinned, onPin, matches, active, compact, findOpen, dragMode, tabActive }: {
  sheet: Worksheet; scale: number; theme: Theme; onZoom: (scale: number) => void; compact: boolean;
  focus?: CellAddress; pinned: FrozenAxes; onPin: (axis: keyof CellAddress, index: number) => void; findOpen: boolean;
  matches: ReadonlyMap<string, WorksheetMatch[]>; active?: WorksheetMatch; dragMode: boolean; tabActive: boolean;
}) {
  const { t } = useTranslation(messages);
  const notify = useReaderNotice();
  const web = Platform.OS === "web";
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [left, setLeft] = useState(0);
  const [top, setTop] = useState(0);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0, scale });
  const current = useRef(position);
  const beforeFind = useRef<Position>(undefined);
  const gridViewport = useRef<View>(null);
  const horizontal = useRef<ScrollViewInstance>(null);
  const vertical = useRef<ScrollViewInstance>(null);
  const webZoom = useRef<Position>(undefined);
  const [picked, setPicked] = useState<Worksheet["cells"][number]>();
  const [menu, setMenu] = useState<CellMenu>();
  const closeMenu = useCallback(() => setMenu(undefined), []);
  const press = useRef<CellPress | null>(undefined);
  const cellScale = web ? scale : 1;
  const fullColumns = useMemo(() => offsets(sheet.columns, cellScale), [sheet.columns, cellScale]);
  const fullRows = useMemo(() => offsets(sheet.rows, cellScale), [sheet.rows, cellScale]);
  const frozenRow = pinned.row !== undefined && sheet.rows[pinned.row] ? pinned.row : undefined;
  const frozenColumn = pinned.column !== undefined && sheet.columns[pinned.column] ? pinned.column : undefined;
  const rows = useMemo(() => withoutTrack(fullRows, frozenRow), [fullRows, frozenRow]);
  const columns = useMemo(() => withoutTrack(fullColumns, frozenColumn), [fullColumns, frozenColumn]);
  const frozenRowSize = frozenRow === undefined ? 0 : fullRows[frozenRow + 1] - fullRows[frozenRow];
  const frozenColumnSize = frozenColumn === undefined ? 0 : fullColumns[frozenColumn + 1] - fullColumns[frozenColumn];
  const width = columns[columns.length - 1];
  const height = rows[rows.length - 1];
  const content = useMemo(() => ({ width, height }), [width, height]);
  const zoom = web ? 1 : position.scale;
  const { x: frozenWidth, y: frozenHeight } = frozenInsets(zoom);
  const scrollLeft = web ? left : -position.x;
  const scrollTop = web ? top : -position.y;
  const { first: firstColumn, end: endColumn } = visibleRange(columns, scrollLeft / zoom, (viewport.width - frozenWidth) / zoom);
  const { first: firstRow, end: endRow } = visibleRange(rows, scrollTop / zoom, (viewport.height - frozenHeight) / zoom);
  function frozenInsets(scale: number) {
    return { x: Math.min(frozenColumnSize * scale, viewport.width / 3), y: Math.min(frozenRowSize * scale, viewport.height / 3) };
  }
  function viewportPosition(position: Position) {
    const inset = frozenInsets(position.scale);
    return { ...position, x: position.x + inset.x, y: position.y + inset.y };
  }
  function constrainInViewport(position: Position) {
    const inset = frozenInsets(position.scale);
    return constrainGrid({ ...position, x: position.x - inset.x, y: position.y - inset.y },
      { width: viewport.width - inset.x, height: viewport.height - inset.y }, content);
  }
  function update(next: Position) {
    if (next.x === current.current.x && next.y === current.current.y && next.scale === current.current.scale) return false;
    current.current = next;
    setPosition(next);
    return true;
  }
  const { handlers: nativeGestures, stopInertia } = useNativeContacts(gridViewport, !web && viewport.width > 0, (previous, next) => {
    const before = current.current;
    const after = constrainInViewport(panAndPinch(viewportPosition(before), previous, next));
    update(after);
    if (after.scale !== before.scale) onZoom(after.scale);
  }, ({ x, y }) => {
    const position = viewportPosition(current.current);
    return update(constrainInViewport({ ...position, x: position.x + x, y: position.y + y }));
  }, trackTouch);
  useLayoutEffect(() => {
    if (web) return;
    stopInertia();
    if (findOpen) beforeFind.current ??= current.current;
    const saved = findOpen ? undefined : beforeFind.current;
    beforeFind.current = findOpen ? beforeFind.current : undefined;
    const anchor = { x: viewport.width / 2, y: viewport.height / 2 };
    update(constrainInViewport(zoomAround(viewportPosition(saved ?? current.current), scale, anchor)));
  }, [web, viewport, content, scale, stopInertia, frozenRowSize, frozenColumnSize, findOpen]);
  useLayoutEffect(() => {
    const pending = webZoom.current;
    webZoom.current = undefined;
    if (!pending || pending.scale !== scale) return;
    horizontal.current?.scrollTo({ x: pending.x, animated: false });
    vertical.current?.scrollTo({ y: pending.y, animated: false });
  }, [scale]);
  function zoomWeb(factor: number | undefined, anchor: Point, scroll: Point) {
    const previous = webZoom.current ?? { ...scroll, scale };
    const next = factor === undefined ? 1 : boundZoom(previous.scale * factor);
    if (next === previous.scale) return;
    webZoom.current = zoomGridScroll(previous, next, anchor, viewport,
      { width: width / scale, height: height / scale },
      { width: frozenColumnSize / scale, height: frozenRowSize / scale });
    onZoom(next);
  }
  const focusGeometry = useRef({ columns, rows, frozenWidth, frozenHeight, frozenRow, frozenColumn, scrollLeft, scrollTop });
  focusGeometry.current = { columns, rows, frozenWidth, frozenHeight, frozenRow, frozenColumn, scrollLeft, scrollTop };
  useLayoutEffect(() => {
    if (!focus || !viewport.width || !viewport.height || focus.row >= sheet.rows.length || focus.column >= sheet.columns.length) return;
    const { columns, rows, frozenWidth, frozenHeight, frozenRow, frozenColumn, scrollLeft, scrollTop } = focusGeometry.current;
    stopInertia();
    const atScale = web ? 1 : current.current.scale;
    const x = focus.column === frozenColumn ? scrollLeft : columns[focus.column] * atScale;
    const y = focus.row === frozenRow ? scrollTop
      : Math.max(0, rows[focus.row] * atScale - (viewport.height - frozenHeight) * 0.35);
    if (web) {
      horizontal.current?.scrollTo({ x, animated: false });
      vertical.current?.scrollTo({ y, animated: false });
    } else {
      update(constrainGrid({ ...current.current, x: -x, y: -y },
        { width: viewport.width - frozenWidth, height: viewport.height - frozenHeight }, content));
    }
  }, [focus, viewport, web, sheet, stopInertia]);
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
  useLayoutEffect(() => {
    setPicked(undefined);
    closeMenu();
    return () => { clearTimeout(press.current?.timer); press.current = undefined; };
  }, [sheet, closeMenu]);
  const gridActions = useRef({ open: openCellMenu, dragMode, zoom: zoomWeb });
  gridActions.current = { open: openCellMenu, dragMode, zoom: zoomWeb };
  useLayoutEffect(() => {
    if (web && tabActive) return bindWorksheetGrid(gridViewport.current, {
      open: (point) => gridActions.current.open(point),
      dragMode: () => gridActions.current.dragMode,
      zoom: (...args) => gridActions.current.zoom(...args),
    });
  }, [tabActive, web]);
  function addressAt({ x, y }: Point): CellAddress | undefined {
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return;
    const column = frozenColumn !== undefined && x < frozenWidth ? frozenColumn
      : upperOffset(columns, (x - frozenWidth + scrollLeft) / zoom) - 1;
    const row = frozenRow !== undefined && y < frozenHeight ? frozenRow
      : upperOffset(rows, (y - frozenHeight + scrollTop) / zoom) - 1;
    if (sheet.rows[row] && sheet.columns[column]) return { row, column };
  }
  function openCellMenu(point: Point) {
    const address = addressAt(point);
    if (!address) return false;
    setMenu({ address, point });
    return true;
  }
  function pickCell(point: Point) {
    const address = addressAt(point);
    if (!address) return setPicked(undefined);
    const { row, column } = address;
    const merge = sheet.merges.find(([firstRow, firstColumn, lastRow, lastColumn]) =>
      row >= firstRow && row <= lastRow && column >= firstColumn && column <= lastColumn);
    const cell = cellIndex.get(merge?.[0] ?? row)?.get(merge?.[1] ?? column);
    setPicked(cell?.[2] ? cell : undefined);
  }
  function measureContact(contact: Contact, action: (point: Point) => void) {
    gridViewport.current?.measure((_left, _top, _width, _height, x, y) => action({ x: contact.x - x, y: contact.y - y }));
  }
  function trackTouch(_visible: Contact[], contacts: Contact[]) {
    const [point] = contacts;
    const start = press.current;
    if (!point) {
      clearTimeout(start?.timer);
      press.current = undefined;
      if (start?.held) return true;
      if (!start) return false;
      measureContact(start.contact, pickCell);
      return true;
    }
    if (start?.held) return true;
    if (contacts.length > 1 || start && (point.id !== start.contact.id || Math.hypot(point.x - start.contact.x, point.y - start.contact.y) > 7)) {
      clearTimeout(start?.timer);
      press.current = null;
    } else if (start === undefined) {
      const timer = setTimeout(() => {
        if (!press.current) return;
        press.current.held = true;
        measureContact(point, (target) => gridActions.current.open(target));
      }, 500);
      press.current = { contact: point, timer, held: false };
    }
    return false;
  }
  const copyPicked = async (value: string) => {
    try {
      await copyText(value);
      notify?.(t("copied"));
    } catch {
      notify?.(t("textCopyError"), true);
    }
  };
  const selected = useMemo(() => picked && { row: picked[0], column: picked[1] }, [picked]);
  const decoration = useMemo(() => ({ focus, selected, matches, active }), [focus, selected, matches, active]);
  const gridColor = theme.colors.border;
  const header = {
    position: "absolute", justifyContent: "center", alignItems: "center",
    backgroundColor: theme.colors.surface1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: gridColor,
  } as const;
  const headerText = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const rowNumbers = [];
  const columnLabels = [];
  const cells = useMemo(() => renderCells(
    sheet, cellIndex, rows, columns, { firstRow, endRow, firstColumn, endColumn }, cellScale, theme, decoration,
  ), [sheet, cellIndex, rows, columns, firstRow, endRow, firstColumn, endColumn, cellScale, theme, decoration]);
  const pinnedCells = useMemo(() => {
    const render = (rows: number[], columns: number[], firstRow: number, endRow: number, firstColumn: number, endColumn: number) =>
      renderCells(sheet, cellIndex, rows, columns, { firstRow, endRow, firstColumn, endColumn }, cellScale, theme, decoration);
    return {
      row: frozenRow === undefined ? null : render(fullRows, columns, frozenRow, frozenRow + 1, firstColumn, endColumn),
      column: frozenColumn === undefined ? null : render(rows, fullColumns, firstRow, endRow, frozenColumn, frozenColumn + 1),
      corner: frozenRow === undefined || frozenColumn === undefined ? null
        : render(fullRows, fullColumns, frozenRow, frozenRow + 1, frozenColumn, frozenColumn + 1),
    };
  }, [frozenRow, frozenColumn, firstRow, endRow, firstColumn, endColumn, sheet, cellIndex,
    rows, columns, fullRows, fullColumns, cellScale, theme, decoration]);
  for (let column = firstColumn; column < endColumn; column++) {
    const size = (columns[column + 1] - columns[column]) * zoom;
    if (size <= 0) continue;
    columnLabels.push(
      <View key={column} style={{ ...header, left: frozenWidth + columns[column] * zoom - scrollLeft, width: size, height: headingHeight }}>
        <Text style={headerText}>{columnName(column)}</Text>
      </View>,
    );
  }
  for (let row = firstRow; row < endRow; row++) {
    const size = (rows[row + 1] - rows[row]) * zoom;
    if (size <= 0) continue;
    rowNumbers.push(
      <View key={row} style={{ ...header, top: frozenHeight + rows[row] * zoom - scrollTop, width: gutter, height: size }}>
        <Text style={headerText}>{row + 1}</Text>
      </View>,
    );
  }

  return (
    <View testID="omni-worksheet-grid" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
      <View style={{ height: headingHeight, marginLeft: gutter, overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
        {columnLabels}
        {frozenColumn !== undefined && frozenWidth > 0 && (
          <View style={{ ...header, left: 0, top: 0, width: frozenWidth, height: headingHeight, borderColor: theme.colors.accent }}>
            <Text style={headerText}>{columnName(frozenColumn)}</Text>
          </View>
        )}
      </View>
      <View
        ref={gridViewport}
        testID="omni-worksheet-viewport"
        collapsable={web}
        tabIndex={web && tabActive ? 0 : undefined}
        {...nativeGestures}
        style={[
          { flex: 1, minHeight: 0, marginLeft: gutter, overflow: "hidden" },
          web && dragMode && ({ cursor: "grab" } as unknown as ViewStyle),
        ]}
        onLayout={({ nativeEvent }) => {
          const { width, height } = nativeEvent.layout;
          setViewport((previous) => previous.width === width && previous.height === height ? previous : { width, height });
        }}
      >
        {web ? (
          <ScrollView ref={horizontal} horizontal nestedScrollEnabled scrollEventThrottle={16}
            testID="omni-worksheet-horizontal" onScroll={({ nativeEvent }) => setLeft(Math.max(0, nativeEvent.contentOffset.x))}>
            <ScrollView ref={vertical} nestedScrollEnabled scrollEventThrottle={16}
              style={{ width: Math.max(viewport.width, width + frozenWidth), height: viewport.height }}
              testID="omni-worksheet-vertical" onScroll={({ nativeEvent }) => setTop(Math.max(0, nativeEvent.contentOffset.y))}>
              <View style={{ width: width + frozenWidth, height: height + frozenHeight }}>
                <View style={{ position: "absolute", left: frozenWidth, top: frozenHeight, width, height }}>{cells}</View>
              </View>
            </ScrollView>
          </ScrollView>
        ) : (
          <View testID="omni-worksheet-touch" style={{
            position: "absolute", left: frozenWidth, top: frozenHeight, width, height, transformOrigin: [0, 0, 0],
            transform: [{ translateX: position.x }, { translateY: position.y }, { scale: zoom }],
          }}>{cells}</View>
        )}
        {frozenRow !== undefined && frozenHeight > 0 && <View testID="omni-worksheet-frozen-row" pointerEvents={web ? "auto" : "none"}
          style={{ position: "absolute", top: 0, left: frozenWidth, right: 0,
            height: frozenHeight, overflow: "hidden", backgroundColor: theme.colors.surface0, borderBottomWidth: 1, borderColor: theme.colors.accent }}>
          <View style={{ position: "absolute", width, height: fullRows.at(-1), transformOrigin: [0, 0, 0],
            transform: [{ translateX: -scrollLeft }, { translateY: -fullRows[frozenRow] * zoom }, { scale: zoom }] }}>{pinnedCells.row}</View>
        </View>}
        {frozenColumn !== undefined && frozenWidth > 0 && <View testID="omni-worksheet-frozen-column" pointerEvents={web ? "auto" : "none"}
          style={{ position: "absolute", top: frozenHeight, bottom: 0,
            left: 0, width: frozenWidth, overflow: "hidden", backgroundColor: theme.colors.surface0, borderRightWidth: 1, borderColor: theme.colors.accent }}>
          <View style={{ position: "absolute", width: fullColumns.at(-1), height, transformOrigin: [0, 0, 0],
            transform: [{ translateX: -fullColumns[frozenColumn] * zoom }, { translateY: -scrollTop }, { scale: zoom }] }}>{pinnedCells.column}</View>
        </View>}
        {frozenRow !== undefined && frozenColumn !== undefined && frozenHeight > 0 && frozenWidth > 0 && (
          <View testID="omni-worksheet-frozen-corner" pointerEvents={web ? "auto" : "none"}
            style={{ position: "absolute", top: 0, left: 0, width: frozenWidth, height: frozenHeight, overflow: "hidden",
              backgroundColor: theme.colors.surface0, borderBottomWidth: 1, borderRightWidth: 1, borderColor: theme.colors.accent }}>
            <View style={{ position: "absolute", width: fullColumns.at(-1), height: fullRows.at(-1), transformOrigin: [0, 0, 0],
              transform: [{ translateX: -fullColumns[frozenColumn] * zoom }, { translateY: -fullRows[frozenRow] * zoom }, { scale: zoom }] }}>{pinnedCells.corner}</View>
          </View>
        )}
      </View>
      <View pointerEvents="none" style={{ position: "absolute", top: headingHeight, bottom: 0, left: 0, width: gutter,
        overflow: "hidden", backgroundColor: theme.colors.surface1 }}>
        {rowNumbers}
        {frozenRow !== undefined && frozenHeight > 0 && (
          <View style={{ ...header, top: 0, width: gutter, height: frozenHeight, borderColor: theme.colors.accent }}>
            <Text style={headerText}>{frozenRow + 1}</Text>
          </View>
        )}
      </View>
      <View pointerEvents="none" style={{ ...header, top: 0, left: 0, width: gutter, height: headingHeight }} />
      {!!picked?.[2] && <View style={[{ position: "absolute", right: 8,
        borderWidth: 1, borderRadius: 7, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 },
        findOpen ? { bottom: 8 } : { top: headingHeight + 8 }]}>
        <Control title={t("copyCell")} icon="Copy" theme={theme} compact={compact} onPress={() => { void copyPicked(picked[2]); }} />
      </View>}
      {menu && <WorksheetCellMenu {...{ menu, pinned, viewport, theme, onPin }} close={closeMenu} />}
    </View>
  );
}

function WorksheetCellMenu({ menu, pinned, viewport, theme, onPin, close }: {
  menu: CellMenu; pinned: FrozenAxes; viewport: Size; theme: Theme;
  onPin: (axis: keyof CellAddress, index: number) => void; close: () => void;
}) {
  const { t } = useTranslation(messages);
  const web = Platform.OS === "web";
  const ref = useRef<View>(null);
  const [height, setHeight] = useState(120);
  useLayoutEffect(() => {
    if (web) return bindWorksheetMenuDismiss(ref.current, close);
  }, [web, close]);
  const { address: { row, column }, point } = menu;
  const width = Math.min(220, viewport.width - 8);
  const columnLabel = columnName(column);
  const actions = [
    { axis: "row", index: row, label: t(pinned.row === row ? "unfreezeRow" : "freezeRow", { row: row + 1 }) },
    { axis: "column", index: column, label: t(pinned.column === column ? "unfreezeColumn" : "freezeColumn", { column: columnLabel }) },
  ] as const;
  return (
    <View pointerEvents="box-none" style={{ position: "absolute", inset: 0, zIndex: 3 }}>
      {!web && <Pressable accessible={false} onPress={close} style={{ position: "absolute", inset: 0 }} />}
      <View ref={ref} testID="omni-worksheet-cell-menu" accessibilityRole="menu" accessibilityLabel={t("cellActions")}
        tabIndex={web ? -1 : undefined} onAccessibilityEscape={close}
        onLayout={({ nativeEvent }) => setHeight(nativeEvent.layout.height)} style={{
          position: "absolute", left: gutter + clamp(point.x, 4, viewport.width - width - 4),
          top: headingHeight + clamp(point.y, 4, viewport.height - height - 4),
          width, padding: 4, borderRadius: 8, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1,
        }}>
        <Text style={{ color: theme.colors.foregroundMuted, paddingHorizontal: 8, paddingVertical: 4, fontSize: 12 }}>
          {columnLabel}{row + 1}
        </Text>
        {actions.map(({ axis, index, label }) => (
          <Pressable key={axis} accessibilityRole="menuitem" onPress={() => { onPin(axis, index); close(); }}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
              minHeight: web ? 32 : 40, paddingHorizontal: 8, paddingVertical: 4,
              borderRadius: 4, flexDirection: "row", alignItems: "center", gap: 8,
              backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
            })}>
            <Icon name={pinned[axis] === index ? "PinOff" : "Pin"} size={15} color={theme.colors.foregroundMuted} />
            <Text style={{ flexShrink: 1, color: theme.colors.foreground, fontSize: 13 }}>{label}</Text>
          </Pressable>
        ))}
      </View>
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
  { focus, selected, matches, active }: {
    focus?: CellAddress; selected?: CellAddress; matches: ReadonlyMap<string, WorksheetMatch[]>; active?: WorksheetMatch;
  },
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
    const contains = (address?: CellAddress) =>
      address && address.row >= row && address.row <= lastRow && address.column >= column && address.column <= lastColumn;
    const focused = contains(focus);
    const highlighted = focused || contains(selected);
    const hits = matches.get(`${row}:${column}`);
    if (cellWidth <= 0 || cellHeight <= 0) return null;
    return (
      <View key={`${row}:${column}`} testID={focused && !active ? "omni-worksheet-address-match" : undefined} style={{
        position: "absolute", left: columns[column], top: rows[row], width: cellWidth, height: cellHeight,
        justifyContent: "center", paddingHorizontal: 4 * scale, overflow: "hidden",
        backgroundColor: style?.fill ?? theme.colors.surface0,
        borderRightWidth: 1, borderBottomWidth: 1, borderColor: theme.colors.border,
        ...(highlighted ? { borderWidth: 2, borderColor: theme.colors.accent } : {}),
      }}>
        {cell?.[2] ? (
          <Text selectable {...(Platform.OS === "web" ? { dataSet: { worksheetCellText: "" } } : {})}
            ref={Platform.OS === "web" ? (node) => setWebTitle(node, cell[2]) : undefined}
            style={[{
              color: style?.color ?? (style?.fill ? "#181818" : theme.colors.foreground),
              textAlign: style?.align ?? (cell[4] ? "right" : "left"),
              fontSize, lineHeight: fontSize * 1.22,
              fontWeight: style?.bold ? "700" : "400", fontStyle: style?.italic ? "italic" : "normal",
              fontVariant: ["tabular-nums"],
            }, Platform.OS === "web" && webCellText]}>
            {hits ? <CellMatches value={cell[2]} hits={hits} active={active} theme={theme} /> : cell[2]}
          </Text>
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

function CellMatches({ value, hits, active, theme }: {
  value: string; hits: WorksheetMatch[]; active?: WorksheetMatch; theme: Theme;
}) {
  let offset = 0;
  return <>{hits.map((hit) => {
    const [, , start, end] = hit;
    const before = value.slice(offset, start);
    offset = end;
    const selected = hit === active;
    return <Text key={start}>{before}
      <Text testID={selected ? "omni-worksheet-find-active" : undefined} style={{
        backgroundColor: selected ? theme.colors.accent : theme.colors.surface2,
        color: selected ? theme.colors.accentForeground : theme.colors.foreground,
      }}>{value.slice(start, end)}</Text>
    </Text>;
  })}{value.slice(offset)}</>;
}

export function WorksheetPanel(props: PluginFilePanelProps) {
  const { file, host, workspaceId, theme, layout: { compact } } = props;
  const { t } = useTranslation(messages);
  const rpc = useRpc(readWorksheet);
  const searchText = useRpc(findWorksheetText);
  const generation = useFileGeneration(file);
  const panel = useRef<View>(null);
  const web = Platform.OS === "web";
  const tabActive = (props.tab as typeof props.tab & { active?: boolean }).active !== false;
  const [selected, setSelected] = useState(0);
  const [scale, setScale] = useState(1);
  const [dragMode, setDragMode] = useState(false);
  const { findOpen, showFind, hideFind } = useReaderFindVisibility();
  const [addressOnly, setAddressOnly] = useState(false);
  const [pinnedSheets, setPinnedSheets] = useState<Partial<Record<number, FrozenAxes>>>({});
  const pinned = pinnedSheets[selected] ?? noPins;
  const onPin = (axis: keyof CellAddress, index: number) => setPinnedSheets((sheets) => {
    const existing = sheets[selected];
    return { ...sheets, [selected]: { ...existing, [axis]: existing?.[axis] === index ? undefined : index } };
  });
  const fileKey = ["omni-reader", "worksheet", host.id, workspaceId, file.path, file.modifiedAt, generation, selected] as const;
  const result = useQuery({
    queryKey: fileKey,
    queryFn: () => rpc({ workspaceId, path: file.path, sheet: selected }),
    placeholderData: (previous) => previous,
    staleTime: Infinity, gcTime: 30_000, retry: false,
  });
  const sheet = result.isPlaceholderData ? undefined : result.data?.sheet;
  const names = result.data?.names ?? [];
  const find = useFindResults<WorksheetHit>([...fileKey, addressOnly], !!sheet && tabActive && findOpen,
    async (criteria) => {
      const address = cellAddress(criteria.query);
      const targets: WorksheetHit[] = address && sheet?.rows[address.row] && sheet.columns[address.column]
        ? [[address.row, address.column]] : [];
      if (addressOnly) return { matches: targets, limited: false, invalidPattern: false };
      const text = await searchText({ workspaceId, path: file.path, sheet: selected, ...criteria });
      return targets.length ? { ...text, matches: [...targets, ...text.matches] } : text;
    });
  const matches = useMemo(() => {
    const grouped = new Map<string, WorksheetMatch[]>();
    for (const hit of find.matches) {
      if (hit.length !== 4) continue;
      const key = `${hit[0]}:${hit[1]}`;
      const cell = grouped.get(key);
      if (cell) cell.push(hit);
      else grouped.set(key, [hit]);
    }
    return grouped;
  }, [find.matches]);
  const searchFocus = useMemo(() => find.active && { row: find.active[0], column: find.active[1] }, [find.active]);
  const openFind = () => {
    if (findOpen) return focusReaderFind(panel.current, findId);
    const selected = web ? readerSelection(panel.current) : "";
    if (selected && !selected.includes("\n")) find.changeQuery(selected.slice(0, 256));
    showFind();
  };
  useReaderFindShortcuts(panel, findId, web && tabActive && !!sheet,
    { open: openFind, close: hideFind, move: find.move, isOpen: () => findOpen });
  const zoomControls = <ZoomControls {...{ scale, theme, compact }} disabled={!sheet}
    stepZoom={(factor) => setScale((previous) => boundZoom(previous * factor))} setZoom={setScale} />;
  return (
    <View ref={panel} tabIndex={web ? 0 : undefined} style={{ flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 }}>
      <Toolbar theme={theme} filePanel={props} nativePrimary={!web && zoomControls}>
        {web && zoomControls}
        {web && <Control title={t("dragWorksheet")} icon="Hand" selected={dragMode} disabled={!sheet}
          theme={theme} compact={compact} onPress={() => setDragMode((enabled) => !enabled)} />}
        <Control title={t("find")} icon="Search" selected={findOpen} disabled={!sheet}
          theme={theme} compact={compact} onPress={findOpen ? hideFind : openFind} />
        <ExternalFileAction {...props} />
      </Toolbar>
      {sheet?.truncated && <Text style={{ padding: 8, color: theme.colors.foregroundMuted }}>{t("worksheetTruncated")}</Text>}
      <View style={{ flex: 1, minHeight: 0 }}>
        {sheet?.rows.length && sheet.columns.length ? <WorksheetGrid key={selected}
          {...{ sheet, scale, theme, pinned, onPin, matches, compact, findOpen, dragMode, tabActive }} focus={searchFocus}
          active={find.active?.length === 4 ? find.active : undefined} onZoom={setScale} />
          : result.isFetching ? <Loading />
          : result.isError ? <ReadError theme={theme} compact={compact} label={t("textError")} error={result.error}
              retry={t("retry")} onRetry={() => { void result.refetch(); }} />
          : <Text style={{ padding: 16, color: theme.colors.foregroundMuted }}>{t("empty")}</Text>}
        {findOpen && <ReaderFindBar testID={findId} find={find} theme={theme} compact={compact} close={hideFind}
          textOptions={!addressOnly} placeholder={t(addressOnly ? "addressSearch" : "worksheetSearch")}
          option={<Control title={t("addressesOnly")} icon="MapPin" theme={theme} compact={compact} small
            selected={addressOnly} onPress={() => { find.reset(); setAddressOnly((only) => !only); }} />} />}
      </View>
      {!!names.length && (
        <ScrollView horizontal nestedScrollEnabled
          style={{ flexGrow: 0, borderTopWidth: 1, borderColor: theme.colors.border }}
          contentContainerStyle={{ paddingHorizontal: 4, paddingVertical: 2, gap: 4 }}>
          {names.map((name, index) => (
            <Control key={index} title={name || `${t("sheet")} ${index + 1}`} theme={theme} compact={compact}
              selected={index === selected} onPress={() => {
                if (index === selected) return;
                setSelected(index);
                find.reset();
              }} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
