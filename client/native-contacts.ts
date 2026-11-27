import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import type { GestureResponderEvent, GestureResponderHandlers, View } from "react-native";
import type { Contact, Point } from "./viewport-geometry";

const flickWindow = 90;
const decelerationTime = 220;
const minFlingSpeed = 0.06;
const maxFlingSpeed = 3;

function readContacts({ nativeEvent }: GestureResponderEvent): Contact[] {
  return nativeEvent.touches.slice(0, 2)
    .map(({ identifier, pageX, pageY }) => ({ id: Number(identifier), x: pageX, y: pageY }))
    .sort((first, second) => first.id - second.id);
}

export function useNativeContacts(
  viewport: RefObject<View | null>,
  enabled: boolean,
  onMove: (previous: Contact[], next: Contact[]) => void,
  onGlide: (delta: Point) => boolean,
): { handlers: GestureResponderHandlers; stopInertia: () => void } {
  const move = useRef(onMove);
  const glide = useRef(onGlide);
  const origin = useRef<Point>({ x: 0, y: 0 });
  const previous = useRef<Contact[]>([]);
  const pending = useRef<Contact[]>([]);
  const frame = useRef<number | undefined>(undefined);
  const inertiaFrame = useRef<number | undefined>(undefined);
  const lastMove = useRef(0);
  const pendingTime = useRef(0);
  const velocity = useRef<Point>({ x: 0, y: 0 });

  const stopInertia = useCallback(() => {
    if (inertiaFrame.current !== undefined) cancelAnimationFrame(inertiaFrame.current);
    inertiaFrame.current = undefined;
  }, []);
  useLayoutEffect(() => {
    move.current = onMove;
    glide.current = onGlide;
  }, [onMove, onGlide]);
  useLayoutEffect(() => () => {
    stopInertia();
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    previous.current = [];
  }, [enabled, stopInertia]);

  if (!enabled) return { handlers: {}, stopInertia };

  function flush() {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    const before = previous.current;
    const next = pending.current;
    previous.current = next;
    const elapsed = pendingTime.current - lastMove.current;
    lastMove.current = pendingTime.current;
    if (before.length === 1 && next.length === 1 && before[0].id === next[0].id && elapsed > 0) {
      const weight = 1 - Math.exp(-elapsed / 35);
      velocity.current = {
        x: velocity.current.x * (1 - weight) + (next[0].x - before[0].x) / elapsed * weight,
        y: velocity.current.y * (1 - weight) + (next[0].y - before[0].y) / elapsed * weight,
      };
    } else {
      velocity.current = { x: 0, y: 0 };
    }
    const toViewport = (contact: Contact) => ({
      id: contact.id, x: contact.x - origin.current.x, y: contact.y - origin.current.y,
    });
    if (before.length && next.length) move.current(before.map(toViewport), next.map(toViewport));
  }

  function rebase(event: GestureResponderEvent) {
    if (frame.current !== undefined) flush();
    previous.current = readContacts(event);
    lastMove.current = performance.now();
    velocity.current = { x: 0, y: 0 };
  }

  function release() {
    if (frame.current !== undefined) flush();
    const now = performance.now();
    const speed = Math.hypot(velocity.current.x, velocity.current.y);
    const canGlide = previous.current.length === 1 && now - lastMove.current <= flickWindow && speed >= minFlingSpeed;
    previous.current = [];
    if (!canGlide) return;

    let lastFrameTime = now;
    let remaining = Math.min(speed, maxFlingSpeed);
    const direction = { x: velocity.current.x / speed, y: velocity.current.y / speed };
    function step() {
      inertiaFrame.current = undefined;
      const time = performance.now();
      const nextSpeed = remaining * Math.exp(-Math.min(time - lastFrameTime, 32) / decelerationTime);
      const distance = (remaining - nextSpeed) * decelerationTime;
      lastFrameTime = time;
      remaining = nextSpeed;
      if (remaining < minFlingSpeed || !glide.current({ x: direction.x * distance, y: direction.y * distance })) return;
      inertiaFrame.current = requestAnimationFrame(step);
    }
    inertiaFrame.current = requestAnimationFrame(step);
  }

  const handlers: GestureResponderHandlers = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderGrant(event) {
      stopInertia();
      const { pageX, pageY, locationX, locationY } = event.nativeEvent;
      origin.current = { x: pageX - locationX, y: pageY - locationY };
      viewport.current?.measure((_left, _top, _width, _height, x, y) => { origin.current = { x, y }; });
      rebase(event);
      return true;
    },
    onResponderStart: rebase,
    onResponderEnd(event) {
      if (event.nativeEvent.touches.length > 0) rebase(event);
    },
    onResponderMove(event) {
      pending.current = readContacts(event);
      pendingTime.current = performance.now();
      frame.current ??= requestAnimationFrame(flush);
    },
    onResponderRelease: release,
    onResponderTerminate() {
      stopInertia();
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = undefined;
      previous.current = [];
    },
    onResponderTerminationRequest: () => false,
  };
  return { handlers, stopInertia };
}
