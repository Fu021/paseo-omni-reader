import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "omni-resvg.wasm";
import type { Formula, FormulaImage, FormulaPlatform } from "../shared/contracts";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
let initialization: Promise<void> | undefined;
const cache = new Map<string, FormulaImage | null>();
let cacheBytes = 0;

function imageBytes(image: FormulaImage | null | undefined): number {
  return image?.uris.reduce((size, uri) => size + uri.length, 0) ?? 0;
}

function remember(key: string, image: FormulaImage | null) {
  cache.set(key, image);
  cacheBytes += imageBytes(image);
  while (cache.size > 256 || cacheBytes > 4_000_000) {
    const first = cache.keys().next().value;
    if (!first) break;
    cacheBytes -= imageBytes(cache.get(first));
    cache.delete(first);
  }
  return image;
}

function pngUri(xml: string): string | null {
  if (xml.length > 400_000) return null;
  const raster = new Resvg(xml, { font: { loadSystemFonts: false } });
  try {
    const image = raster.render();
    try {
      const png = image.asPng();
      return png.length <= 70_000 ? `data:image/png;base64,${Buffer.from(png).toString("base64")}` : null;
    } finally {
      image.free();
    }
  } finally {
    raster.free();
  }
}

function typeset({ tex, display }: Formula, color: string, platform: FormulaPlatform): FormulaImage | null {
  if (/\\(?:require|autoload|input|include|href|url|style|class|cssId|html\w*|includegraphics|def|gdef|edef|xdef|newcommand|renewcommand|let)\b/i.test(tex)) return null;
  const document = mathjax.document("", {
    InputJax: new TeX({
      packages: ["base", "ams", "boldsymbol"],
      maxBuffer: 3000,
      maxMacros: 200,
      formatError: () => { throw new Error("Invalid TeX."); },
    }),
    OutputJax: new SVG({ fontCache: "none", internalSpeechTitles: false }),
  });
  const converted = document.convert(tex, { display, em: 16, ex: 8, containerWidth: 1000 });
  const svg = adaptor.tags(converted, "svg")[0];
  if (!svg || ["text", "image", "a"].some((tag) => adaptor.tags(svg, tag).length)) return null;
  const [left, top, width, height] = String(adaptor.getAttribute(svg, "viewBox")).split(/\s+/).map(Number);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const baselineY = { web: 960, ios: 1075, android: 1130 }[platform];
  const y = display ? top - 100 : Math.min(top - 30, -baselineY);
  const bottom = display ? top + height + 100 : Math.max(top + height + 30, 1380 - baselineY);
  const paddedWidth = width + 130;
  const paddedHeight = bottom - y;
  const scale = display ? 0.022 : 0.042;
  const squareAttachments = !display && platform !== "web";
  const columns = squareAttachments ? Math.ceil(paddedWidth / paddedHeight) : 1;
  const panelWidth = squareAttachments ? paddedHeight : paddedWidth;
  const pixelWidth = Math.ceil(panelWidth * scale);
  const pixelHeight = Math.ceil(paddedHeight * scale);
  if (columns > 14 || pixelWidth * columns > 2300 || pixelHeight > 650 || pixelWidth * pixelHeight * columns > 650_000) return null;
  adaptor.setAttribute(svg, "width", pixelWidth);
  adaptor.setAttribute(svg, "height", pixelHeight);
  adaptor.removeAttribute(svg, "style");
  const uris: string[] = [];
  let uriBytes = 0;
  for (let column = 0; column < columns; column++) {
    const extraSpace = columns === 1 ? (panelWidth - paddedWidth) / 2 : 0;
    const edge = left - 65 - extraSpace + column * panelWidth;
    adaptor.setAttribute(svg, "viewBox", [edge, y, panelWidth, paddedHeight].join(" "));
    const uri = pngUri(adaptor.outerHTML(svg).replaceAll("currentColor", color));
    if (!uri) return null;
    uriBytes += uri.length;
    if (uriBytes > 95_000) return null;
    uris.push(uri);
  }
  return { uris, width: pixelWidth * columns, height: pixelHeight };
}

export async function rasterizeFormulas(formulas: Formula[], color: string, platform: FormulaPlatform) {
  await (initialization ??= initWasm(wasm));
  return {
    images: formulas.map((formula) => {
      const key = JSON.stringify([formula.tex, formula.display, color, platform]);
      if (cache.has(key)) {
        const image = cache.get(key) ?? null;
        cache.delete(key);
        cache.set(key, image);
        return image;
      }
      try {
        return remember(key, typeset(formula, color, platform));
      } catch {
        return remember(key, null);
      }
    }),
  };
}
