import type { ViewStyle } from "react-native";
import { formulaImageUri } from "../shared/contracts";
import { formulaTitlePattern, formulaTitlePrefix } from "../shared/markdown-math";
import { inlineMathReferenceFontSize } from "../shared/reading-blocks";
import type { Theme } from "./controls";
import type { Contact, Point } from "./viewport-geometry";

export const webReadingWidth = { maxWidth: "var(--content-max-width, 820px)" } as unknown as ViewStyle;

export const webTableStyles = {
  table: { display: "table", width: "max-content", borderSpacing: 0 },
  row: { display: "table-row" },
  cell: { display: "table-cell", verticalAlign: "middle", overflowWrap: "anywhere" },
} as unknown as Record<"table" | "row" | "cell", ViewStyle>;

type DesktopBridge = { invoke(command: "desktop_daemon_status"): Promise<unknown> };

export function getDesktopBridge() {
  if (typeof window !== "undefined") return (window as Window & { paseoDesktop?: DesktopBridge }).paseoDesktop;
}

export function downloadLocalFile(url: string, name: string) {
  if (!url.startsWith("blob:")) throw new Error("Unsupported file URL.");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export function setWebTitle(node: unknown, title: string) {
  if (!(node instanceof HTMLElement)) return;
  node.title = title;
  return () => node.removeAttribute("title");
}

export function bindMarkdownAnchors(node: unknown, onAnchor: (href: string) => boolean) {
  if (!(node instanceof HTMLElement)) return;
  const intercept = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const href = event.target.closest("a")?.getAttribute("href");
    if (!href?.startsWith("#") || !onAnchor(href)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  node.addEventListener("click", intercept, true);
  return () => node.removeEventListener("click", intercept, true);
}

export function bindReaderFind(node: unknown, testID: string, actions: {
  open: () => void; close: () => void; move: (step: number) => void; isOpen: () => boolean;
  focusReader?: () => void;
}) {
  if (!(node instanceof HTMLElement)) return;
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || event.altKey) return;
    const focus = document.activeElement;
    const inReader = node.contains(focus);
    const inFind = !!focus?.closest(`[data-testid="${testID}"]`) && inReader;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "f"
      && (inReader || node.matches(":hover"))) actions.open();
    else if (inReader && actions.isOpen() && event.key === "Escape" && !focus?.closest('[role="menu"]')) {
      actions.close();
      if (actions.focusReader) actions.focusReader();
      else node.focus({ preventScroll: true });
    }
    else if (inFind && event.key === "Enter" && focus instanceof HTMLInputElement) actions.move(event.shiftKey ? -1 : 1);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  window.addEventListener("keydown", keydown, true);
  return () => window.removeEventListener("keydown", keydown, true);
}

export function focusReaderFind(node: unknown, testID: string) {
  if (node instanceof HTMLElement) {
    const input = node.querySelector<HTMLInputElement>(`[data-testid="${testID}"] input`);
    input?.focus();
    input?.select();
  }
}

export function readerSelection(node: unknown) {
  if (!(node instanceof HTMLElement)) return "";
  const selection = window.getSelection();
  return selection && node.contains(selection.anchorNode) && node.contains(selection.focusNode)
    ? selection.toString() : "";
}

export function bindReaderCopy(node: unknown, copied: () => void) {
  if (!(node instanceof HTMLElement)) return;
  const onCopy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("input,textarea,[contenteditable=true]"))) return;
    if (readerSelection(node)) copied();
  };
  node.addEventListener("copy", onCopy);
  return () => node.removeEventListener("copy", onCopy);
}

export function focusWebReader(node: unknown) {
  if (node instanceof HTMLElement) node.focus({ preventScroll: true });
}

export function bindWorksheetGrid(node: unknown, open: (point: Point) => boolean) {
  if (!(node instanceof HTMLElement)) return;
  const contextMenu = (event: MouseEvent) => {
    const bounds = node.getBoundingClientRect();
    if (!open({ x: event.clientX - bounds.left, y: event.clientY - bounds.top })) return;
    event.preventDefault();
    event.stopPropagation();
  };
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey || event.metaKey || !(event.target instanceof Element) ||
      !event.target.closest('[data-testid^="omni-worksheet-frozen-"]')) return;
    const horizontal = node.querySelector<HTMLElement>('[data-testid="omni-worksheet-horizontal"]');
    const vertical = node.querySelector<HTMLElement>('[data-testid="omni-worksheet-vertical"]');
    if (!horizontal || !vertical) return;
    const before = { x: horizontal.scrollLeft, y: vertical.scrollTop };
    const shift = event.shiftKey && !event.deltaX;
    const stepX = event.deltaMode === 2 ? horizontal.clientWidth : event.deltaMode === 1 ? 16 : 1;
    const stepY = event.deltaMode === 2 ? vertical.clientHeight : event.deltaMode === 1 ? 16 : 1;
    horizontal.scrollLeft += (shift ? event.deltaY : event.deltaX) * stepX;
    if (!shift) vertical.scrollTop += event.deltaY * stepY;
    if (horizontal.scrollLeft !== before.x || vertical.scrollTop !== before.y) event.preventDefault();
  };
  node.addEventListener("contextmenu", contextMenu, true);
  node.addEventListener("wheel", wheel, { passive: false });
  return () => {
    node.removeEventListener("contextmenu", contextMenu, true);
    node.removeEventListener("wheel", wheel);
  };
}

export function bindWorksheetMenuDismiss(node: unknown, close: () => void) {
  if (!(node instanceof HTMLElement)) return;
  node.focus({ preventScroll: true });
  const outside = (event: Event) => {
    if (event.target instanceof Node && !node.contains(event.target)) close();
  };
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("wheel", outside, { capture: true, passive: true });
  node.addEventListener("keydown", escape);
  return () => {
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("wheel", outside, true);
    node.removeEventListener("keydown", escape);
  };
}

export function observeCodeFont(node: unknown, update: (size: number, family: string, digitWidth: number) => void) {
  if (!(node instanceof HTMLElement)) return;
  const canvas = node.ownerDocument.createElement("canvas").getContext("2d");
  let observedCode: Element | null = null;
  const measure = () => {
    const code = node.querySelector('[data-paseo-md-copy="code"]')
      ?? node.querySelector("pre code, pre, code, [data-pmono] [dir]");
    if (!code) return;
    if (code !== observedCode) {
      if (observedCode) observer.unobserve(observedCode);
      observedCode = code;
      observer.observe(code);
    }
    const style = getComputedStyle(code);
    const fontSize = style.fontSize;
    const family = style.getPropertyValue("--fontFamily-mono").trim() || style.fontFamily;
    const size = Number.parseFloat(fontSize);
    if (!(size > 0)) return;
    if (canvas) canvas.font = `${fontSize} ${family}`;
    update(size, family, canvas?.measureText("0").width ?? size * 0.62);
  };
  const observer = new ResizeObserver(measure);
  const appearance = new MutationObserver(measure);
  observer.observe(node);
  appearance.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"] });
  node.ownerDocument.fonts?.addEventListener("loadingdone", measure);
  measure();
  return () => {
    observer.disconnect();
    appearance.disconnect();
    node.ownerDocument.fonts?.removeEventListener("loadingdone", measure);
  };
}

export function revealMarkdownMatch(node: unknown) {
  if (!(node instanceof HTMLElement)) return;
  const match = node.querySelector('[data-active-match="true"]');
  if (!match) return;
  for (let scroller = match.parentElement; scroller && node.contains(scroller); scroller = scroller.parentElement) {
    if (scroller.scrollWidth <= scroller.clientWidth || !["auto", "scroll"].includes(getComputedStyle(scroller).overflowX)) continue;
    const viewport = scroller.getBoundingClientRect();
    const marker = match.getBoundingClientRect();
    const gutter = match.closest('[data-source-row="true"]')?.querySelector('[data-source-gutter="true"]')?.getBoundingClientRect();
    const left = Math.max(viewport.left, gutter?.right ?? viewport.left);
    if (marker.left < left || marker.right > viewport.right) scroller.scrollLeft += marker.left - left - 12;
    return;
  }
}

export function bindWebSliderKeys(node: unknown, change: (value: number) => void) {
  if (!(node instanceof HTMLElement)) return;
  const keydown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const value = Number(node.getAttribute("aria-valuenow"));
    switch (event.key) {
      case "ArrowDown": case "ArrowLeft": change(value - 5); break;
      case "ArrowUp": case "ArrowRight": change(value + 5); break;
      case "Home": change(Number(node.getAttribute("aria-valuemin"))); break;
      case "End": change(Number(node.getAttribute("aria-valuemax"))); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  node.addEventListener("keydown", keydown);
  return () => node.removeEventListener("keydown", keydown);
}

export function bindWebFormulas(node: unknown, actions: {
  copy: (tex: string) => void; colors: () => Pick<Theme["colors"], "foreground" | "surface2" | "border">;
}) {
  if (!(node instanceof HTMLElement)) return;
  const scope = node;
  const formulas = new WeakMap<HTMLImageElement, {
    title: string; tex: string; width: number; height: number; depth: number; appliedStyle?: string;
  }>();
  const update = (image: HTMLImageElement) => {
    let formula = formulas.get(image);
    const title = image.title || image.dataset.omniFormula;
    if (!title?.startsWith(formulaTitlePrefix) || !formulaImageUri.test(image.getAttribute("src") ?? "")) {
      formulas.delete(image);
      delete image.dataset.omniFormula;
      return;
    }
    if (!formula || formula.title !== title) {
      const metadata = formulaTitlePattern.exec(title);
      if (!metadata) return;
      const [, width, height, depth, encodedTex] = metadata;
      let tex: string;
      try {
        tex = decodeURIComponent(encodedTex);
      } catch {
        return;
      }
      formula = { title, tex, width: Number(width), height: Number(height), depth: Number(depth) };
      formulas.set(image, formula);
    }
    if (image.title) {
      image.dataset.omniFormula = title;
      image.removeAttribute("title");
    }
    if (formula.appliedStyle === image.style.cssText) return;
    image.style.cursor = "pointer";
    image.style.width = `${formula.width / inlineMathReferenceFontSize}em`;
    image.style.height = "auto";
    image.style.maxHeight = "none";
    image.style.aspectRatio = `${formula.width} / ${formula.height}`;
    image.style.verticalAlign = `${-formula.depth / inlineMathReferenceFontSize}em`;
    formula.appliedStyle = image.style.cssText;
  };
  const updateTree = (element: Node) => {
    if (element instanceof HTMLImageElement) update(element);
    else if (element instanceof HTMLElement) {
      element.querySelectorAll<HTMLImageElement>("img[title], img[data-omni-formula]").forEach(update);
    }
  };
  const activate = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || target.closest("a")) return;
    const tex = formulas.get(target)?.tex;
    if (!tex) return;
    event.preventDefault();
    event.stopPropagation();
    actions.copy(tex);
  };
  const keydown = (event: KeyboardEvent) => {
    if (!event.repeat && (event.key === "Enter" || event.key === " ")) activate(event);
  };
  const targetFormula = (target: EventTarget | null) => {
    if (!(target instanceof Element) || !scope.contains(target)) return null;
    if (target instanceof HTMLImageElement && formulas.has(target)) return target;
    return target.closest<HTMLElement>('[data-testid="omni-display-formula"]');
  };
  let hovered: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  let tooltip: HTMLDivElement | null = null;

  function hideTooltip() {
    if (!tooltip) return;
    tooltip.remove();
    tooltip = null;
    window.removeEventListener("scroll", placeTooltip, true);
    window.removeEventListener("resize", placeTooltip);
  }

  function placeTooltip() {
    const anchor = hovered ?? focused;
    if (!scope.contains(anchor)) return hideTooltip();
    if (!anchor || !tooltip) return;
    const bounds = anchor.getBoundingClientRect();
    if (bounds.bottom <= 0 || bounds.top >= window.innerHeight) return hideTooltip();
    const margin = 8;
    tooltip.style.maxWidth = `${Math.min(scope.getBoundingClientRect().width, window.innerWidth - margin * 2)}px`;
    const { width, height } = tooltip.getBoundingClientRect();
    const left = (bounds.left + bounds.right - width) / 2;
    const top = bounds.bottom + height > window.innerHeight - margin ? bounds.top - height : bounds.bottom;
    tooltip.style.left = `${Math.max(margin, Math.min(left, window.innerWidth - width - margin))}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  }

  function showTooltip() {
    const anchor = hovered ?? focused;
    const tex = anchor instanceof HTMLImageElement ? formulas.get(anchor)?.tex : anchor?.getAttribute("aria-label");
    if (!tex) return hideTooltip();
    const { foreground, surface2, border } = actions.colors();
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.dataset.testid = "omni-formula-tooltip";
      tooltip.setAttribute("aria-hidden", "true");
      Object.assign(tooltip.style, {
        position: "fixed", zIndex: "1000", pointerEvents: "none", boxSizing: "border-box", width: "max-content",
        padding: "8px", borderRadius: "6px", fontFamily: "monospace", fontSize: "13px",
        lineHeight: "normal", whiteSpace: "pre-wrap", overflowWrap: "anywhere",
      });
      document.body.append(tooltip);
      window.addEventListener("scroll", placeTooltip, true);
      window.addEventListener("resize", placeTooltip);
    }
    tooltip.style.color = foreground;
    tooltip.style.backgroundColor = surface2;
    tooltip.style.border = `1px solid ${border}`;
    tooltip.textContent = tex;
    placeTooltip();
  }
  const over = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const target = targetFormula(event.target);
    if (target === targetFormula(event.relatedTarget)) return;
    hovered = target;
    showTooltip();
  };
  const out = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    const target = targetFormula(event.relatedTarget);
    if (target === targetFormula(event.target)) return;
    hovered = target;
    showTooltip();
  };
  const keyboardFormula = (target: EventTarget | null) =>
    target instanceof Element && target.matches(":focus-visible") ? targetFormula(target) : null;
  const focusIn = (event: FocusEvent) => {
    focused = keyboardFormula(event.target);
    showTooltip();
  };
  const focusOut = (event: FocusEvent) => {
    focused = keyboardFormula(event.relatedTarget);
    showTooltip();
  };
  const click = (event: MouseEvent) => {
    if (event.detail > 0 && targetFormula(event.target)) {
      hovered = null;
      focused = null;
      hideTooltip();
    }
    activate(event);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "childList") record.addedNodes.forEach(updateTree);
      else if (record.target instanceof HTMLImageElement) update(record.target);
    }
    if (hovered && !scope.contains(hovered)) hovered = null;
    if (focused && !scope.contains(focused)) focused = null;
    if (tooltip) placeTooltip();
  });
  observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ["title", "style", "src"] });
  updateTree(node);
  node.addEventListener("click", click, true);
  node.addEventListener("keydown", keydown, true);
  node.addEventListener("pointerover", over);
  node.addEventListener("pointerout", out);
  node.addEventListener("focusin", focusIn);
  node.addEventListener("focusout", focusOut);
  return () => {
    observer.disconnect();
    hideTooltip();
    node.removeEventListener("click", click, true);
    node.removeEventListener("keydown", keydown, true);
    node.removeEventListener("pointerover", over);
    node.removeEventListener("pointerout", out);
    node.removeEventListener("focusin", focusIn);
    node.removeEventListener("focusout", focusOut);
  };
}

export function bindWebGestures(node: unknown, actions: {
  contacts: (contacts: Contact[], pointerType: string) => boolean | void;
  overText?: (point: Point) => boolean;
  selectedText?: () => string;
  onCopied?: () => void;
  scroll: (delta: Point) => void;
  zoom: (factor: number) => void;
  fit: () => void;
}) {
  if (!(node instanceof HTMLElement)) return;
  const surface = node;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const pointers = new Map<number, Contact>();
  const position = (event: { clientX: number; clientY: number }) => {
    const { left, top } = surface.getBoundingClientRect();
    return { x: event.clientX - left, y: event.clientY - top };
  };
  const changed = (event: PointerEvent) => {
    const selecting = actions.contacts([...pointers.values()].slice(0, 2), event.pointerType);
    surface.style.cursor = selecting || (!pointers.size && actions.overText?.(position(event))) ? "text"
      : pointers.size ? "grabbing" : "grab";
  };
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest("button, [role=button]")) return;
    event.preventDefault();
    surface.focus({ preventScroll: true });
    surface.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { id: event.pointerId, ...position(event) });
    changed(event);
  }, options);
  surface.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) {
      if (!pointers.size && actions.overText) surface.style.cursor = actions.overText(position(event)) ? "text" : "grab";
      return;
    }
    pointers.set(event.pointerId, { id: event.pointerId, ...position(event) });
    changed(event);
  }, options);
  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    changed(event);
  };
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    surface.addEventListener(name, up, options);
  }
  surface.addEventListener("wheel", (event) => {
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const units = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1;
    actions.scroll({ x: event.deltaX * units, y: event.deltaY * units });
  }, { ...options, passive: false });
  if (actions.selectedText) surface.addEventListener("copy", (event) => {
    const text = actions.selectedText?.();
    if (event.target !== surface || !text || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    actions.onCopied?.();
    event.preventDefault();
    event.stopPropagation();
  }, options);
  surface.addEventListener("keydown", (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.target !== surface) return;
    switch (event.key) {
      case "+": case "=": actions.zoom(1.25); break;
      case "-": actions.zoom(1 / 1.25); break;
      case "0": actions.fit(); break;
      case "ArrowUp": actions.scroll({ x: 0, y: -48 }); break;
      case "ArrowDown": actions.scroll({ x: 0, y: 48 }); break;
      case "PageUp": actions.scroll({ x: 0, y: -surface.clientHeight * 0.9 }); break;
      case "PageDown": actions.scroll({ x: 0, y: surface.clientHeight * 0.9 }); break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, options);
  surface.style.cursor = "grab";
  return () => {
    listeners.abort();
    surface.style.cursor = "";
    actions.contacts([], "");
  };
}
