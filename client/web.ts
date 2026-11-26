import { formulaImageUri } from "../shared/contracts";
import { formulaTitlePrefix } from "../shared/markdown-math";
import type { Contact, Point } from "./pdf-geometry";

export function downloadLocalFile(url: string, name: string) {
  if (!url.startsWith("blob:")) throw new Error("Unsupported file URL.");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function bindWebInlineFormulas(node: unknown, copy: (tex: string) => void) {
  if (!(node instanceof HTMLElement)) return;
  const sources = new WeakMap<Element, string>();
  const update = () => {
    for (const image of Array.from(node.querySelectorAll<HTMLImageElement>(`img[title^="${formulaTitlePrefix}"]`))) {
      if (sources.get(image) === image.title || !formulaImageUri.test(image.getAttribute("src") ?? "")) continue;
      const metadata = /^(\d+):(?:(-?\d+):)?(.+)$/.exec(image.title.slice(formulaTitlePrefix.length));
      if (!metadata) continue;
      const [, height, depth, encodedTex] = metadata;
      let tex: string;
      try {
        tex = decodeURIComponent(encodedTex);
      } catch {
        continue;
      }
      sources.set(image, tex);
      image.title = tex;
      if (!image.closest("a")) image.style.cursor = "copy";
      image.style.height = `${Number(height)}px`;
      image.style.maxHeight = "none";
      image.style.verticalAlign = depth ? `${-Number(depth)}px` : "-0.25em";
    }
  };
  const activate = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || target.closest("a")) return;
    const tex = sources.get(target);
    if (!tex) return;
    event.preventDefault();
    event.stopPropagation();
    copy(tex);
  };
  const keydown = (event: KeyboardEvent) => {
    if (!event.repeat && (event.key === "Enter" || event.key === " ")) activate(event);
  };
  const observer = new MutationObserver(update);
  observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ["title"] });
  update();
  node.addEventListener("click", activate, true);
  node.addEventListener("keydown", keydown, true);
  return () => {
    observer.disconnect();
    node.removeEventListener("click", activate, true);
    node.removeEventListener("keydown", keydown, true);
  };
}

interface PointerEventLike {
  pointerId: number;
  button: number;
  clientX: number;
  clientY: number;
  preventDefault(): void;
}

interface WheelEventLike {
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  preventDefault(): void;
}

interface Surface {
  addEventListener(name: string, handler: (event: never) => void, options?: { passive: boolean }): void;
  removeEventListener(name: string, handler: (event: never) => void): void;
  getBoundingClientRect(): { left: number; top: number; height: number };
  setPointerCapture(id: number): void;
  style: { cursor: string };
}

export function bindWebGestures(node: unknown, actions: {
  contacts: (contacts: Contact[]) => void;
  scroll: (delta: Point) => void;
  zoom: (factor: number, anchor: Point) => void;
}) {
  const surface = node as Surface | null;
  if (!surface?.setPointerCapture) return;
  const pointers = new Map<number, Contact>();
  const position = (event: { clientX: number; clientY: number }) => {
    const { left, top } = surface.getBoundingClientRect();
    return { x: event.clientX - left, y: event.clientY - top };
  };
  const changed = () => actions.contacts([...pointers.values()].slice(0, 2));
  const down = (event: PointerEventLike) => {
    if (event.button !== 0) return;
    event.preventDefault();
    surface.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { id: event.pointerId, ...position(event) });
    surface.style.cursor = "grabbing";
    changed();
  };
  const move = (event: PointerEventLike) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { id: event.pointerId, ...position(event) });
    changed();
  };
  const up = (event: PointerEventLike) => {
    if (!pointers.delete(event.pointerId)) return;
    if (!pointers.size) surface.style.cursor = "grab";
    changed();
  };
  const wheel = (event: WheelEventLike) => {
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.getBoundingClientRect().height : 1;
    if (event.ctrlKey) {
      actions.zoom(Math.exp(-event.deltaY * units * 0.004), position(event));
    } else {
      const horizontal = event.shiftKey && !event.deltaX;
      actions.scroll({ x: -(horizontal ? event.deltaY : event.deltaX) * units, y: horizontal ? 0 : -event.deltaY * units });
    }
  };
  const events = {
    pointerdown: down, pointermove: move, pointerup: up, pointercancel: up,
    lostpointercapture: up, wheel,
  };
  surface.style.cursor = "grab";
  for (const [name, handler] of Object.entries(events)) surface.addEventListener(name, handler, { passive: false });
  return () => {
    for (const [name, handler] of Object.entries(events)) surface.removeEventListener(name, handler);
    surface.style.cursor = "";
    actions.contacts([]);
  };
}
