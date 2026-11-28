import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const version = "0.11.1";
const packageName = `office2pdf-${version}`;
const cache = fileURLToPath(new URL("../rust/reader/target/office2pdf/", import.meta.url));
const destination = fileURLToPath(new URL("../vendor/office2pdf/", import.meta.url));
const profile = `${version};wasm;strip=symbols`;
const stamp = join(destination, ".build");
const assets = ["office2pdf.cjs", "office2pdf_bg.wasm", "LICENSE", "OFL-1.1.txt", "Selawik-LICENSE.txt", "DrawingML-LICENSE.txt"];

async function fetchPinned(filename, url, sha256) {
  const path = join(cache, filename);
  const matches = (buffer) => createHash("sha256").update(buffer).digest("hex") === sha256;
  const previous = await readFile(path).catch(() => null);
  if (previous && matches(previous)) return path;
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Could not fetch ${filename} (${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!matches(data)) throw new Error(`Unexpected checksum for ${filename}.`);
  await writeFile(path, data);
  return path;
}

const ready = await readFile(stamp, "utf8").catch(() => "");
if (ready !== profile || !(await Promise.all(assets.map((asset) =>
  access(join(destination, asset)).then(() => true, () => false)))).every(Boolean)) {
  await mkdir(cache, { recursive: true });
  await mkdir(destination, { recursive: true });
  const [archive, license] = await Promise.all([
    fetchPinned(`${packageName}.crate`, `https://static.crates.io/crates/office2pdf/${packageName}.crate`,
      "e6b030b788368809dd3bed86cf9f760d01e4531b26680e07911d45f88c8b7341"),
    fetchPinned("LICENSE", `https://raw.githubusercontent.com/developer0hye/office2pdf/v${version}/LICENSE`,
      "a69f60df4102c74db295b45bdeca8bb300ecaa954a319de94cbe4e8e337e98f9"),
  ]);
  const source = join(cache, packageName);
  const target = join(cache, "target");
  const command = { cwd: cache, stdio: "inherit" };
  execFileSync("tar", ["-xzf", archive], command);
  execFileSync("cargo", ["build", "--lib", "--locked", "--release", "--target", "wasm32-unknown-unknown",
    "--features", "wasm", "--config", 'profile.release.strip="symbols"',
    "--manifest-path", join(source, "Cargo.toml"), "--target-dir", target], command);
  execFileSync("wasm-bindgen", ["--target", "nodejs", "--no-typescript", "--out-dir", destination,
    join(target, "wasm32-unknown-unknown", "release", "office2pdf.wasm")], command);
  await rename(join(destination, "office2pdf.js"), join(destination, "office2pdf.cjs"));
  await Promise.all([
    copyFile(license, join(destination, "LICENSE")),
    copyFile(join(source, "fonts", "OFL-1.1.txt"), join(destination, "OFL-1.1.txt")),
    copyFile(join(source, "fonts", "Selawik-LICENSE.txt"), join(destination, "Selawik-LICENSE.txt")),
    copyFile(join(source, "src", "parser", "drawingml_presets", "LICENSE"), join(destination, "DrawingML-LICENSE.txt")),
  ]);
  await writeFile(stamp, profile);
}
