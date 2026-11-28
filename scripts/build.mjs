import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";

const resolve = createRequire(import.meta.url).resolve;
const directory = new URL("../server/generated/", import.meta.url);
await mkdir(directory, { recursive: true });
await Promise.all([import("./build-rust.mjs"), import("./build-office.mjs")]);

const fonts = dirname(resolve("@inkbar/fonts"));
await Promise.all([
  copyFile(join(fonts, "files", "NotoSansSC-Regular.otf"), new URL("NotoSansSC-Regular.otf", directory)),
  copyFile(join(fonts, "OFL.txt"), new URL("NotoSansSC-OFL.txt", directory)),
]);
await import("./prepare-office.mjs");

await Promise.all(["math", "document"].map(async (kind) => {
  const result = await build({
    entryPoints: ["server/worker-entry.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    define: { "import.meta.url": '""', __OMNI_MATH_WORKER__: String(kind === "math") },
    minify: true,
    legalComments: "inline",
    loader: { ".wasm": "binary" },
    write: false,
  });
  const output = new URL(`${kind}-worker.ts`, directory);
  const source = `export default ${JSON.stringify(result.outputFiles[0].text)};\n`;
  if ((await readFile(output, "utf8").catch(() => null)) !== source) {
    await writeFile(output, source);
  }
}));
