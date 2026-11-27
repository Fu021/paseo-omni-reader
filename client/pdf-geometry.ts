import type { PageRun } from "../shared/contracts";

export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Position extends Point { scale: number }
export interface Contact extends Point { id: number }

interface FittedRun extends Size {
  firstPage: number;
  top: number;
  step: number;
}

export interface ReaderLayout {
  viewport: Size;
  runs: FittedRun[];
  width: number;
  pageCount: number;
  lastTop: number;
  lastHeight: number;
}

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function fitPages(sizes: PageRun[], viewport: Size): ReaderLayout {
  let firstPage = 1;
  let top = 0;
  let widest = 0;
  const runs = sizes.map(({ count, width, height }) => {
    const fit = Math.min(viewport.width / width, viewport.height / height);
    const fitted = { width: width * fit, height: height * fit };
    const step = fitted.height + 12;
    const run = { ...fitted, firstPage, top, step };
    firstPage += count;
    top += count * step;
    widest = Math.max(widest, fitted.width);
    return run;
  });
  const last = runs[runs.length - 1];
  return { viewport, runs, width: widest, pageCount: firstPage - 1, lastTop: top - last.step, lastHeight: last.height };
}

function runAt(layout: ReaderLayout, target: number, field: "firstPage" | "top") {
  let start = 0;
  let end = layout.runs.length;
  while (start + 1 < end) {
    const middle = (start + end) >>> 1;
    if (layout.runs[middle][field] <= target) start = middle;
    else end = middle;
  }
  return layout.runs[start];
}

export function pageAt(layout: ReaderLayout, top: number) {
  const run = runAt(layout, top, "top");
  return clamp(run.firstPage + Math.floor((top - run.top + 0.0001) / run.step), 1, layout.pageCount);
}

export function pageBounds(layout: ReaderLayout, number: number) {
  const run = runAt(layout, number, "firstPage");
  return { width: run.width, height: run.height, top: run.top + (number - run.firstPage) * run.step };
}

export function constrain(position: Position, layout: ReaderLayout): Position {
  const { scale } = position;
  const width = layout.width * scale;
  const { viewport } = layout;
  const bottom = layout.lastTop * scale + Math.max(layout.lastHeight * scale, viewport.height);
  return {
    scale,
    x: width <= viewport.width ? (viewport.width - width) / 2 : clamp(position.x, viewport.width - width, 0),
    y: clamp(position.y, viewport.height - bottom, 0),
  };
}

export function jumpToPage(position: Position, number: number, layout: ReaderLayout) {
  return constrain({ ...position, y: -pageBounds(layout, number).top * position.scale }, layout);
}

export function zoomAt(position: Position, scale: number, anchor: Point, layout: ReaderLayout): Position {
  const ratio = scale / position.scale;
  return constrain({
    scale,
    x: anchor.x - (anchor.x - position.x) * ratio,
    y: anchor.y - (anchor.y - position.y) * ratio,
  }, layout);
}

export function boundZoom(scale: number, previous: number) {
  return clamp(scale, 0.25, Math.max(6, previous));
}

function midpoint(contacts: Contact[]): Point {
  const [first, second = first] = contacts;
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance([first, second]: Contact[]): number {
  return second ? Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)) : 1;
}

export function moveContacts(position: Position, previous: Contact[], next: Contact[], layout: ReaderLayout): Position {
  if (!previous.length || previous.length !== next.length || previous.some((value, index) => value.id !== next[index].id)) {
    return position;
  }
  const before = midpoint(previous);
  const after = midpoint(next);
  const scale = boundZoom(position.scale * distance(next) / distance(previous), position.scale);
  const ratio = scale / position.scale;
  return constrain({
    scale,
    x: after.x - (before.x - position.x) * ratio,
    y: after.y - (before.y - position.y) * ratio,
  }, layout);
}
