import type { ViewStyle } from "react-native";
import { formulaImageUri } from "../shared/contracts";
import { formulaTitlePattern, formulaTitlePrefix } from "../shared/markdown-math";
import { inlineMathReferenceFontSize } from "../shared/reading-blocks";
import type { Theme } from "./controls";
import type { Contact, Point } from "./pdf-geometry";

export const webTableStyles = {
  table: { display: "table", width: "max-content", borderSpacing: 0 },
  row: { display: "table-row" },
  cell: { display: "table-cell", verticalAlign: "middle", overflowWrap: "anywhere" },
} as unknown as Record<"table" | "row" | "cell", ViewStyle>;

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
  contacts: (contacts: Contact[]) => void;
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
  const changed = () => actions.contacts([...pointers.values()].slice(0, 2));
  surface.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target instanceof Element && event.target.closest("button, [role=button]")) return;
    event.preventDefault();
    surface.focus({ preventScroll: true });
    surface.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { id: event.pointerId, ...position(event) });
    surface.style.cursor = "grabbing";
    changed();
  }, options);
  surface.addEventListener("pointermove", (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { id: event.pointerId, ...position(event) });
    changed();
  }, options);
  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId)) return;
    if (!pointers.size) surface.style.cursor = "grab";
    changed();
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
    actions.contacts([]);
  };
}
