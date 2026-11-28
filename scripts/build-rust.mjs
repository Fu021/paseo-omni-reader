import { execFile, execFileSync } from "node:child_process";
import { copyFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = new URL("../", import.meta.url);
const manifest = new URL("rust/reader/Cargo.toml", root);
const target = new URL("rust/reader/target/", root);
const directory = new URL("server/generated/", root);
const wasm = new URL("wasm32-unknown-unknown/release/omni_reader.wasm", target);
const command = { cwd: root, stdio: "inherit" };

execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-unknown-unknown",
  "--manifest-path", fileURLToPath(manifest), "--target-dir", fileURLToPath(target)], command);
execFileSync("wasm-bindgen", ["--target", "nodejs", "--no-typescript", "--out-name", "rust-reader",
  "--out-dir", fileURLToPath(directory), fileURLToPath(wasm)], command);
await rename(new URL("rust-reader.js", directory), new URL("rust-reader.cjs", directory));

const { stdout } = await promisify(execFile)("cargo", ["metadata", "--locked", "--format-version", "1",
  "--manifest-path", fileURLToPath(manifest)], { cwd: root, encoding: "utf8" });
const metadata = JSON.parse(stdout);
const crate = (id) => dirname(metadata.packages.find(({ name }) => name === id).manifest_path);
await Promise.all([
  ...["APACHE", "IJG", "MIT"].map((name) =>
    copyFile(join(crate("jpeg-encoder"), `LICENSE-${name}`), new URL(`jpeg-encoder-LICENSE-${name}.txt`, directory))),
  ...["OFL", "FONT_NOTICE"].map((name) =>
    copyFile(join(crate("ratex-katex-fonts"), "fonts", `${name}.txt`), new URL(`KaTeX-${name}.txt`, directory))),
  copyFile(join(crate("markdown"), "license"), new URL("markdown-rs-LICENSE.txt", directory)),
  ...["APACHE", "MIT"].map((name) =>
    copyFile(join(crate("resvg"), `LICENSE-${name}`), new URL(`resvg-LICENSE-${name}.txt`, directory))),
]);
