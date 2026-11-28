import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readerDirectory, rustReader } from "./rust-reader";
import type { Formula, FormulaImage, FormulaPlatform } from "../shared/contracts";

let fontReady: Promise<void> | undefined;
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

async function typeset({ tex, display }: Formula, color: string, vector: boolean): Promise<FormulaImage | null> {
  if (/\\(?:require|autoload|input|include|href|url|style|class|cssId|html\w*|includegraphics|def|gdef|edef|xdef|newcommand|renewcommand|let|futurelet|global|label|ref|eqref|DeclareMathOperator|newenvironment|renewenvironment)\b/i.test(tex)) return null;
  const reader = await rustReader();
  if (/[^\x00-\x7f]/.test(tex)) {
    await (fontReady ??= readerDirectory()
      .then((directory) => readFile(join(directory, "server", "generated", "NotoSansSC-Regular.otf")))
      .then((font) => reader.configureMathFont(font))
      .catch((error) => { fontReady = undefined; throw error; }));
  }
  const image = reader.renderFormula(tex, display, color, vector);
  if (!image) return null;
  const { width, height, baseline, vector: svg } = image;
  const bytes = Buffer.from(image.bytes()).toString("base64");
  return { uris: [`data:image/${svg ? "svg+xml" : "png"};base64,${bytes}`], width, height, baseline };
}

export async function rasterizeFormulas(formulas: Formula[], color: string, platform: FormulaPlatform) {
  const vector = platform === "web";
  return {
    images: await Promise.all(formulas.map(async (formula) => {
      const key = JSON.stringify([formula.tex, formula.display, color, vector]);
      const image = cache.get(key);
      if (image) {
        cache.delete(key);
        cache.set(key, image);
        return image;
      }
      try {
        const rendered = await typeset(formula, color, vector);
        return rendered ? remember(key, rendered) : null;
      } catch {
        return null;
      }
    })),
  };
}
