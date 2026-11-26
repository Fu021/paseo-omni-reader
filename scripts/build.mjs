import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const resolve = createRequire(import.meta.url).resolve;
const resvgWasm = join(dirname(resolve("@resvg/resvg-wasm")), "index_bg.wasm");
const result = await build({
  entryPoints: ["server/worker-entry.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { "import.meta.url": '""' },
  minify: true,
  legalComments: "inline",
  loader: { ".wasm": "binary" },
  alias: { "omni-resvg.wasm": resvgWasm },
  write: false,
});

const directory = new URL("../server/generated/", import.meta.url);
const output = new URL("worker.ts", directory);
const source = `export default ${JSON.stringify(result.outputFiles[0].text)};\n`;
await mkdir(directory, { recursive: true });
if ((await readFile(output, "utf8").catch(() => null)) !== source) {
  await writeFile(output, source);
}
