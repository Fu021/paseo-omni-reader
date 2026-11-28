import { access, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const generated = new URL("server/generated/", root);
const location = new URL("office-location.ts", generated);
const directory = dirname(dirname(fileURLToPath(import.meta.url)));
const source = `export default ${JSON.stringify(directory)};\n`;

await Promise.all([
  access(new URL("server/office-worker.cjs", root)),
  access(new URL("server/generated/rust-reader.cjs", root)),
  access(new URL("server/generated/rust-reader_bg.wasm", root)),
  access(new URL("server/generated/NotoSansSC-Regular.otf", root)),
  access(new URL("vendor/office2pdf/office2pdf.cjs", root)),
  access(new URL("vendor/office2pdf/office2pdf_bg.wasm", root)),
]);
if ((await readFile(location, "utf8").catch(() => null)) !== source) await writeFile(location, source);
