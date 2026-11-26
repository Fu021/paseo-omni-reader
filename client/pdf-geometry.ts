export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface Position extends Point { scale: number }
export interface Contact extends Point { id: number }

export const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

export function widthScale(page: Size, viewport: Size): number {
  return viewport.width / page.width;
}

export function constrain(position: Position, page: Size, viewport: Size): Position {
  const width = page.width * position.scale;
  const height = page.height * position.scale;
  return {
    scale: position.scale,
    x: width <= viewport.width ? (viewport.width - width) / 2 : clamp(position.x, viewport.width - width, 0),
    y: height <= viewport.height ? Math.min(24, (viewport.height - height) / 2) : clamp(position.y, viewport.height - height, 0),
  };
}

export function zoomAt(position: Position, scale: number, anchor: Point, page: Size, viewport: Size): Position {
  const fit = widthScale(page, viewport);
  const nextScale = clamp(scale, Math.min(fit * 0.6, 1), Math.max(fit * 6, 4));
  const ratio = nextScale / position.scale;
  return constrain({
    scale: nextScale,
    x: anchor.x - (anchor.x - position.x) * ratio,
    y: anchor.y - (anchor.y - position.y) * ratio,
  }, page, viewport);
}

function midpoint(contacts: Contact[]): Point {
  const [first, second = first] = contacts;
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function distance([first, second]: Contact[]): number {
  return second ? Math.max(1, Math.hypot(first.x - second.x, first.y - second.y)) : 1;
}

export function moveContacts(
  position: Position, previous: Contact[], next: Contact[], page: Size, viewport: Size,
): Position {
  if (!previous.length || previous.length !== next.length || previous.some((value, index) => value.id !== next[index].id)) {
    return position;
  }
  const before = midpoint(previous);
  const after = midpoint(next);
  const fit = widthScale(page, viewport);
  const scale = clamp(position.scale * distance(next) / distance(previous), Math.min(fit * 0.6, 1), Math.max(fit * 6, 4));
  const ratio = scale / position.scale;
  return constrain({
    scale,
    x: after.x - (before.x - position.x) * ratio,
    y: after.y - (before.y - position.y) * ratio,
  }, page, viewport);
}
