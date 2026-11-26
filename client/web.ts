import type { Contact, Point } from "./pdf-geometry";

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
