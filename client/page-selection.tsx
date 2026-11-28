import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import type { PageGlyph } from "../shared/contracts";
import type { Contact, Point, Size } from "./viewport-geometry";

export interface TextPage extends Size {
  number: number;
  left: number;
  top: number;
  text: string;
  glyphs: PageGlyph[];
}

interface Selection {
  page: number;
  start: number;
  end: number;
}

interface Drag {
  contact: Contact;
  page?: number;
  anchor?: number;
  tap?: boolean;
  waiting?: ReturnType<typeof setTimeout>;
}

function nearestGlyph(page: TextPage, point: Point, tolerance = Infinity) {
  const x = point.x - page.left;
  const y = point.y - page.top;
  let nearest = -1;
  let best = Infinity;
  for (const [index, [, , left, top, right, bottom]] of page.glyphs.entries()) {
    const horizontal = Math.max(left * page.width - x, x - right * page.width, 0);
    const vertical = Math.max(top * page.height - y, y - bottom * page.height, 0);
    if (horizontal > tolerance || vertical > tolerance) continue;
    const distance = horizontal + vertical * 3;
    if (distance >= best) continue;
    nearest = index;
    best = distance;
    if (distance === 0) break;
  }
  return nearest;
}

const wordPart = /^[\p{L}\p{M}\p{N}_]+$/u;
const ideograph = /\p{Script=Han}/u;

function wordBounds(page: TextPage, index: number) {
  const at = (offset: number) => {
    const [first, last] = page.glyphs[offset];
    return page.text.slice(first, last);
  };
  const includes = (value: string) => wordPart.test(value) && !ideograph.test(value);
  let start = index;
  let end = index;
  if (includes(at(index))) {
    while (start > 0 && page.glyphs[start - 1][1] === page.glyphs[start][0] && includes(at(start - 1))) start--;
    while (end < page.glyphs.length - 1 && page.glyphs[end][1] === page.glyphs[end + 1][0] && includes(at(end + 1))) end++;
  }
  return { page: page.number, start, end };
}

function handlePoint(glyph: PageGlyph, size: Size, end: boolean) {
  return { x: glyph[end ? 4 : 2] * size.width, y: glyph[5] * size.height };
}

export function usePageSelection(findPage: (point: Point, number?: number) => TextPage | undefined, version: string) {
  const [selection, setSelection] = useState<Selection>();
  const selected = useRef<Selection>(undefined);
  const drag = useRef<Drag>(undefined);

  useEffect(() => {
    selected.current = undefined;
    setSelection(undefined);
    return () => clearTimeout(drag.current?.waiting);
  }, [version]);

  function show(next?: Selection) {
    const previous = selected.current;
    if (previous?.page === next?.page && previous?.start === next?.start && previous?.end === next?.end) return;
    selected.current = next;
    setSelection(next);
  }

  function track(contacts: Contact[], pointer: string) {
    const previous = drag.current;
    if (contacts.length !== 1) {
      clearTimeout(previous?.waiting);
      drag.current = undefined;
      if (!contacts.length && previous?.tap && previous.anchor === undefined) show();
      return !contacts.length && previous?.anchor !== undefined;
    }
    const [point] = contacts;
    const touch = pointer === "touch";
    if (previous?.contact.id !== point.id) {
      clearTimeout(previous?.waiting);
      const gesture: Drag = { contact: point, tap: touch };
      drag.current = gesture;
      const current = selected.current;
      if (touch && current) {
        const page = findPage(point, current.page);
        if (page) {
          const distance = (index: number, end: boolean) => {
            const handle = handlePoint(page.glyphs[index], page, end);
            return Math.hypot(point.x - page.left - handle.x, point.y - page.top - handle.y - 5);
          };
          const start = distance(current.start, false);
          const end = distance(current.end, true);
          if (Math.min(start, end) <= 19) {
            gesture.page = current.page;
            gesture.anchor = start <= end ? current.end : current.start;
            return true;
          }
        }
      }
      const page = findPage(point);
      const index = page ? nearestGlyph(page, point, touch ? 7 : 2) : -1;
      if (!page || index < 0) {
        if (!touch) show();
        return false;
      }
      gesture.page = page.number;
      if (touch) {
        gesture.waiting = setTimeout(() => {
          gesture.waiting = undefined;
          const word = wordBounds(page, index);
          gesture.anchor = word.start;
          show(word);
        }, 450);
        return false;
      }
      gesture.anchor = index;
      show({ page: page.number, start: index, end: index });
      return true;
    }
    const distance = Math.hypot(point.x - previous.contact.x, point.y - previous.contact.y);
    if (previous.anchor === undefined) {
      if (distance > 7) {
        previous.tap = false;
        clearTimeout(previous.waiting);
        previous.waiting = undefined;
      }
      return false;
    }
    if (distance < 1) return true;
    const page = findPage(point, previous.page);
    const index = page ? nearestGlyph(page, point) : -1;
    if (page && index >= 0) {
      show({ page: page.number, start: Math.min(previous.anchor, index), end: Math.max(previous.anchor, index) });
    }
    return true;
  }

  function text() {
    const range = selected.current;
    if (!range) return "";
    const page = findPage({ x: 0, y: 0 }, range.page);
    if (!page) return "";
    return page.text.slice(page.glyphs[range.start][0], page.glyphs[range.end][1]);
  }

  return { selection, track, text, overText: (point: Point) => {
    const page = findPage(point);
    return !!page && nearestGlyph(page, point, 2) >= 0;
  } };
}

export function glyphBands<Mark>(glyphs: PageGlyph[], classify: (glyph: PageGlyph) => Mark | undefined) {
  const bands: { left: number; top: number; right: number; bottom: number; mark: Mark }[] = [];
  for (const glyph of glyphs) {
    const mark = classify(glyph);
    if (mark === undefined) continue;
    const [, , left, top, right, bottom] = glyph;
    const last = bands.at(-1);
    if (last && last.mark === mark && top < last.bottom && bottom > last.top && Math.abs(top - last.top) < 0.012 &&
      left >= last.left && left <= last.right + 0.005) {
      last.right = Math.max(last.right, right);
      last.top = Math.min(last.top, top);
      last.bottom = Math.max(last.bottom, bottom);
    } else bands.push({ left, top, right, bottom, mark });
  }
  return bands;
}

export function PageSelectionOverlay({ width, height, glyphs, range, handles, accent, scale }: Size & {
  glyphs: PageGlyph[]; range: Selection; handles: boolean; accent: string; scale: number;
}) {
  const bands = glyphBands(glyphs.slice(range.start, range.end + 1), () => true);
  const radius = 5 / scale;
  return (
    <View pointerEvents="none" importantForAccessibility="no" testID="omni-page-selection"
      style={{ position: "absolute", left: 0, top: 0, width, height }}>
      {bands.map(({ left, top, right, bottom }, index) => (
        <View key={index} style={{ position: "absolute", left: left * width, top: top * height,
          width: (right - left) * width, height: (bottom - top) * height, backgroundColor: accent, opacity: 0.35 }} />
      ))}
      {handles && [false, true].map((end) => {
        const point = handlePoint(glyphs[end ? range.end : range.start], { width, height }, end);
        return <View key={String(end)} style={{ position: "absolute", left: point.x - radius, top: point.y,
          width: radius * 2, height: radius * 2, borderRadius: radius, backgroundColor: accent }} />;
      })}
    </View>
  );
}
