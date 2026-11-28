const previewSelector = '[data-testid="omni-markdown-preview-scroll"]';
const sourceSelector = '[data-testid="omni-markdown-source-scroll"]';

function anchors(scroller: HTMLElement) {
  const origin = scroller.getBoundingClientRect().top - scroller.scrollTop + 12;
  return Array.from(scroller.querySelectorAll<HTMLElement>("[data-preview-index]"), (node) => {
    const bounds = node.getBoundingClientRect();
    return {
      index: Number(node.dataset.previewIndex), first: Number(node.dataset.sourceFirst),
      end: Number(node.dataset.sourceLast) + 1, top: bounds.top - origin, bottom: bounds.bottom - origin,
    };
  }).filter(({ top, bottom }) => bottom > top);
}

function interpolate(position: number, start: number, end: number, from: number, to: number) {
  if (end <= start) return from;
  const fraction = Math.max(0, Math.min(1, (position - start) / (end - start)));
  return from + (to - from) * fraction;
}

function previewLine(scroller: HTMLElement, start: number) {
  const offset = scroller.scrollTop;
  if (offset <= 1) return start;
  const blocks = anchors(scroller);
  const later = blocks.findIndex((block) => block.top > offset);
  const index = (later < 0 ? blocks.length : later) - 1;
  const block = blocks[index];
  const next = blocks[index + 1];
  if (!block) return next?.index === 0 ? next.first : undefined;
  if (offset <= block.bottom) return interpolate(offset, block.top, block.bottom, block.first, block.end);
  if (next?.index === block.index + 1) {
    return interpolate(offset, block.bottom, next.top, block.end, next.first);
  }
  return offset - block.bottom <= 12 ? block.end : undefined;
}

function previewOffset(scroller: HTMLElement, line: number, start: number) {
  if (line < start) return;
  const blocks = anchors(scroller);
  const later = blocks.findIndex((block) => block.first > line);
  const index = (later < 0 ? blocks.length : later) - 1;
  const block = blocks[index];
  const next = blocks[index + 1];
  if (!block) return next?.index === 0 ? 0 : undefined;
  if (line <= block.end) return interpolate(line, block.first, block.end, block.top, block.bottom);
  if (next?.index === block.index + 1) {
    return interpolate(line, block.end, next.first, block.bottom, next.top);
  }
}

export function bindMarkdownScroll(node: unknown, actions: {
  previewStart: () => number;
  preview: (line: number | undefined) => void;
  source: (offset: number, atEnd: boolean) => void;
  previewInteraction: () => void;
}) {
  if (!(node instanceof HTMLElement)) return;
  const written = new WeakMap<HTMLElement, number>();
  const observed = new WeakMap<HTMLElement, number>();
  let frame: number | undefined;
  const move = (scroller: HTMLElement, offset: number) => {
    if (Math.abs(scroller.scrollTop - offset) < 0.75) return;
    scroller.scrollTop = offset;
    written.set(scroller, scroller.scrollTop);
  };
  const onScroll = ({ target }: Event) => {
    if (!(target instanceof HTMLElement) || !target.matches(`${previewSelector}, ${sourceSelector}`)) return;
    const offset = target.scrollTop;
    const expected = written.get(target);
    const previous = observed.get(target);
    written.delete(target);
    observed.set(target, offset);
    if (offset === expected || offset === previous) return;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (!node.contains(target)) return;
      if (target.matches(previewSelector)) actions.preview(previewLine(target, actions.previewStart()));
      else actions.source(target.scrollTop, target.scrollTop > 0 && target.scrollTop + target.clientHeight >= target.scrollHeight - 1);
    });
  };
  const onPreviewInteraction = ({ target }: Event) => {
    if (target instanceof Element && target.closest(previewSelector)) actions.previewInteraction();
  };
  node.addEventListener("scroll", onScroll, true);
  node.addEventListener("wheel", onPreviewInteraction, { capture: true, passive: true });
  node.addEventListener("pointerdown", onPreviewInteraction, true);
  node.addEventListener("keydown", onPreviewInteraction, true);
  return {
    sourceViewport: () => {
      const scroller = node.querySelector<HTMLElement>(sourceSelector);
      if (scroller) return { top: scroller.scrollTop, height: scroller.clientHeight };
    },
    scrollSource: (offset: number) => {
      const scroller = node.querySelector<HTMLElement>(sourceSelector);
      if (!scroller) return false;
      move(scroller, offset);
      return true;
    },
    scrollPreview: (line: number, finding = false) => {
      const scroller = node.querySelector<HTMLElement>(previewSelector);
      if (!scroller) return false;
      const offset = previewOffset(scroller, line, actions.previewStart());
      if (offset === undefined) return false;
      const findBar = finding && node.querySelector<HTMLElement>('[data-testid="omni-markdown-find"]');
      const inset = findBar ? findBar.offsetHeight + 8 : 0;
      move(scroller, Math.max(0, offset - inset));
      return true;
    },
    scrollPreviewToEnd: () => {
      const scroller = node.querySelector<HTMLElement>(previewSelector);
      if (scroller) move(scroller, scroller.scrollHeight - scroller.clientHeight);
    },
    dispose: () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      node.removeEventListener("scroll", onScroll, true);
      node.removeEventListener("wheel", onPreviewInteraction, true);
      node.removeEventListener("pointerdown", onPreviewInteraction, true);
      node.removeEventListener("keydown", onPreviewInteraction, true);
    },
  };
}
