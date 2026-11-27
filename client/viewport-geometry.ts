export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Position extends Point { scale: number }
export interface Contact extends Point { id: number }

export const minZoomPercent = 25;
export const maxZoomPercent = 400;

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function boundZoom(scale: number) {
  return clamp(scale, minZoomPercent / 100, maxZoomPercent / 100);
}

export function constrainGrid(position: Position, viewport: Size, content: Size): Position {
  return {
    scale: position.scale,
    x: clamp(position.x, Math.min(0, viewport.width - content.width * position.scale), 0),
    y: clamp(position.y, Math.min(0, viewport.height - content.height * position.scale), 0),
  };
}

export function zoomAround(position: Position, scale: number, anchor: Point, target = anchor): Position {
  const ratio = scale / position.scale;
  return {
    scale,
    x: target.x - (anchor.x - position.x) * ratio,
    y: target.y - (anchor.y - position.y) * ratio,
  };
}

function midpoint([first, second = first]: Contact[]): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance([first, second]: Contact[]): number {
  return second ? Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)) : 1;
}

export function panAndPinch(position: Position, previous: Contact[], next: Contact[]): Position {
  if (!previous.length || previous.length !== next.length || previous.some((value, index) => value.id !== next[index].id)) {
    return position;
  }
  const scale = boundZoom(position.scale * distance(next) / distance(previous));
  return zoomAround(position, scale, midpoint(previous), midpoint(next));
}
