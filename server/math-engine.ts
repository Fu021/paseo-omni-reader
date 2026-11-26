import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import type { MmlNode } from "mathjax-full/js/core/MmlTree/MmlNode.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/boldsymbol/BoldsymbolConfiguration.js";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasm from "omni-resvg.wasm";
import type { Formula, FormulaImage, FormulaPlatform } from "../shared/contracts";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const vectorTags = new Set(["svg", "g", "path", "rect", "line", "polygon", "polyline", "circle", "ellipse"]);
let initialization: Promise<void> | undefined;
let mathDocument: ReturnType<typeof makeDocument> | undefined;
const cache = new Map<string, FormulaImage>();
let cacheBytes = 0;

function imageBytes(image: FormulaImage | undefined): number {
  return image?.uris.reduce((size, uri) => size + uri.length, 0) ?? 0;
}

function remember(key: string, image: FormulaImage) {
  cacheBytes -= imageBytes(cache.get(key));
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

function makeDocument() {
  const input = new TeX({
    packages: ["base", "ams", "boldsymbol"],
    maxBuffer: 3000,
    maxMacros: 200,
    formatError: () => { throw new Error("Invalid TeX."); },
  });
  input.postFilters.add(({ math }: { math: { display: boolean } }) => {
    if (math.display) return;
    input.parseOptions.root.walkTree((node) => {
      if (!node.isKind("mfrac")) return;
      const fraction = node as MmlNode;
      if (fraction.attributes.get("displaystyle") || fraction.attributes.get("scriptlevel") !== 0) return;
      for (const child of fraction.childNodes) {
        child.walkTree((descendant) => (descendant as MmlNode).attributes?.setInherited("scriptsizemultiplier", 0.92));
      }
    });
  });
  const document = mathjax.document("", {
    InputJax: input,
    OutputJax: new SVG({ fontCache: "none", internalSpeechTitles: false }),
  });
  return { input, document };
}

async function typeset({ tex, display }: Formula, color: string, platform: FormulaPlatform): Promise<FormulaImage | null> {
  if (/\\(?:require|autoload|input|include|href|url|style|class|cssId|html\w*|includegraphics|def|gdef|edef|xdef|newcommand|renewcommand|let|futurelet|global|label|ref|eqref|DeclareMathOperator|newenvironment|renewenvironment)\b/i.test(tex)) return null;
  const { input, document } = mathDocument ??= makeDocument();
  input.reset();
  const converted = document.convert(tex, { display, em: 16, ex: 8, containerWidth: 1000 });
  const svg = adaptor.tags(converted, "svg")[0];
  if (!svg || ["text", "image", "a"].some((tag) => adaptor.tags(svg, tag).length)) return null;
  const [left, top, width, height] = String(adaptor.getAttribute(svg, "viewBox")).split(/\s+/).map(Number);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const padding = display ? 100 : 80;
  const y = top - padding;
  const bottom = top + height + padding;
  const paddedWidth = width + 130;
  const paddedHeight = bottom - y;
  const scale = display ? 0.022 : 0.02;
  const pixelWidth = Math.ceil(paddedWidth * scale);
  const pixelHeight = Math.ceil(paddedHeight * scale);
  if (pixelWidth > 1150 || pixelHeight > 325 || pixelWidth * pixelHeight > 170_000) return null;
  const density = platform === "web" ? 1 : Math.min(3, Math.sqrt(650_000 / (pixelWidth * pixelHeight)));
  adaptor.setAttribute(svg, "width", Math.floor(pixelWidth * density));
  adaptor.setAttribute(svg, "height", Math.floor(pixelHeight * density));
  adaptor.removeAttribute(svg, "style");
  adaptor.setAttribute(svg, "viewBox", [left - 65, y, paddedWidth, paddedHeight].join(" "));
  const xml = adaptor.outerHTML(svg).replaceAll("currentColor", color);
  const vector = platform === "web" && xml.length <= 70_000 &&
    Array.from(xml.matchAll(/<([^\s/>]+)/g)).every(([, tag]) => vectorTags.has(tag)) &&
    !/\s(?:[\w-]+:)?(?:href|style|on[a-z]+)=/i.test(xml)
    ? `data:image/svg+xml;base64,${Buffer.from(xml).toString("base64")}` : null;
  const uri = vector ?? await (initialization ??= initWasm(wasm)).then(() => pngUri(xml));
  if (!uri) return null;
  return { uris: [uri], width: pixelWidth, height: pixelHeight, baseline: -y * pixelHeight / paddedHeight };
}

export async function rasterizeFormulas(formulas: Formula[], color: string, platform: FormulaPlatform) {
  if (platform !== "web") await (initialization ??= initWasm(wasm));
  return {
    images: await Promise.all(formulas.map(async (formula) => {
      const key = JSON.stringify([formula.tex, formula.display, color, platform === "web"]);
      const image = cache.get(key);
      if (image) {
        cache.delete(key);
        cache.set(key, image);
        return image;
      }
      try {
        const rendered = await typeset(formula, color, platform);
        return rendered ? remember(key, rendered) : null;
      } catch {
        return null;
      }
    })),
  };
}
