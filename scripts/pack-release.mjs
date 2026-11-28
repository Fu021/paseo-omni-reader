import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const { values: { check, paseo } } = parseArgs({
  options: { check: { type: "boolean" }, paseo: { type: "boolean" } },
});
assert.ok(!paseo || check, "--paseo requires --check.");
const npm = process.env.npm_execpath;
assert.ok(npm, "Run npm run pack:release.");
const root = process.cwd();
const resolve = createRequire(import.meta.url).resolve;
const workerBuildDependencies = ["@hyzyla/pdfium", "@inkbar/fonts", "esbuild"];
const officePreparation = "scripts/prepare-office.mjs";

function pack(directory, ...options) {
  const [result] = JSON.parse(execFileSync(process.execPath, [
    npm, "pack", "--json", "--ignore-scripts", ...options,
  ], { cwd: directory, encoding: "utf8" }));
  return result;
}

function checkPaseoInstallation(home, installed, id) {
  mkdirSync(home);
  writeFileSync(join(home, "config.json"), JSON.stringify({
    version: 1, daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
    pluginsEnabled: true, plugins: {},
  }));
  const invoke = (args) => execFileSync("paseo", ["--home", home, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], timeout: 90_000,
  });
  invoke(["daemon", "start", "--timeout", "30"]);
  try {
    invoke(["plugin", "install", installed, "--json"]);
    const [plugin] = JSON.parse(invoke(["plugin", "ls", id, "--json"]));
    assert.equal(plugin?.status, "running", JSON.stringify(plugin));
    console.log(`${id} is running in an isolated Paseo daemon.`);
  } finally {
    invoke(["daemon", "stop"]);
  }
}

const source = pack(root, "--dry-run");
const files = new Set(source.files.map(({ path }) => path));
const manifest = JSON.parse(readFileSync("paseo-plugin.json", "utf8"));
const metadata = JSON.parse(readFileSync("package.json", "utf8"));
for (const path of [
  "paseo-plugin.json", "index.client.tsx", "index.server.ts", "OVERVIEW.md", "OVERVIEW.zh-CN.md",
  "server/generated/math-worker.ts", "server/generated/document-worker.ts", "server/office-worker.cjs",
  "server/generated/rust-reader.cjs", "server/generated/rust-reader_bg.wasm",
  ...["APACHE", "IJG", "MIT"].map((name) => `server/generated/jpeg-encoder-LICENSE-${name}.txt`),
  "server/generated/KaTeX-OFL.txt", "server/generated/KaTeX-FONT_NOTICE.txt",
  "server/generated/markdown-rs-LICENSE.txt",
  "server/licenses/RaTeX.txt",
  "server/generated/resvg-LICENSE-APACHE.txt", "server/generated/resvg-LICENSE-MIT.txt",
  "server/generated/NotoSansSC-Regular.otf", "server/generated/NotoSansSC-OFL.txt",
  "vendor/office2pdf/office2pdf.cjs", "vendor/office2pdf/office2pdf_bg.wasm", "vendor/office2pdf/LICENSE",
  "vendor/office2pdf/OFL-1.1.txt", "vendor/office2pdf/Selawik-LICENSE.txt", "vendor/office2pdf/DrawingML-LICENSE.txt",
  officePreparation, manifest.icon, ...manifest.media,
]) {
  assert.ok(files.has(path), `Missing from the npm package: ${path}`);
}
for (const path of files) {
  assert.ok(!path.startsWith("reader-test-fixtures/"), `Local fixture in the npm package: ${path}`);
}
files.delete("server/generated/office-location.ts");

const temporary = mkdtempSync(join(tmpdir(), "omni-reader-npm-"));
try {
  const staged = join(temporary, "package");
  for (const path of files) {
    const target = join(staged, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  manifest.build = [["node", officePreparation]];
  writeFileSync(join(staged, "paseo-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  delete metadata.scripts;
  delete metadata.devDependencies;
  for (const name of workerBuildDependencies) delete metadata.dependencies[name];
  metadata.bundleDependencies = Object.keys(metadata.dependencies);
  metadata.files.push("npm-shrinkwrap.json");
  writeFileSync(join(staged, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const stagedLockPath = join(staged, "package-lock.json");
  copyFileSync("package-lock.json", stagedLockPath);
  execFileSync(process.execPath, [
    npm, "install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--workspaces=false",
  ], { cwd: staged, stdio: "inherit" });
  const sourceLock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const stagedLock = JSON.parse(readFileSync(stagedLockPath, "utf8"));
  assert.deepEqual(stagedLock.packages[""].dependencies, metadata.dependencies);
  for (const [path, entry] of Object.entries(stagedLock.packages)) {
    if (!path) continue;
    const original = sourceLock.packages[path];
    for (const field of ["version", "resolved", "integrity"]) {
      assert.ok(entry[field] && entry[field] === original?.[field], `Lock changed for ${path}: ${field}`);
    }
  }
  renameSync(stagedLockPath, join(staged, "npm-shrinkwrap.json"));
  execFileSync(process.execPath, [
      npm, "ci", "--omit=dev", "--omit=optional", "--ignore-scripts", "--prefer-offline", "--no-audit", "--no-fund",
  ], { cwd: staged, stdio: "inherit" });

  const release = pack(staged, "--pack-destination", temporary);
  assert.equal(release.id, source.id);
  files.add("npm-shrinkwrap.json");
  const releaseFiles = new Set(release.files.map(({ path }) => path));
  assert.deepEqual(new Set([...releaseFiles].filter((path) => !path.startsWith("node_modules/"))), files);
  for (const name of metadata.bundleDependencies) {
    assert.ok(releaseFiles.has(`node_modules/${name}/package.json`), `Missing bundled dependency: ${name}`);
  }
  assert.ok(![...releaseFiles].some((path) => path.startsWith("node_modules/@matbee/libreoffice-converter/")),
    "LibreOffice is no longer needed by the bundled readers.");
  assert.ok(![...releaseFiles].some((path) => path.endsWith(".node")), "Platform-specific addons in the npm package.");
  const archive = join(temporary, release.filename);
  console.log(`Archive: ${(release.size / 1024 ** 2).toFixed(1)} MiB; installed files: ${(release.unpackedSize / 1024 ** 2).toFixed(1)} MiB.`);

  if (check) {
    const managed = join(temporary, "plugins");
    const installation = join(managed, ".staging", "package");
    const emptyBin = join(temporary, "empty-bin");
    const home = join(temporary, "empty-home");
    for (const directory of [installation, emptyBin, home]) mkdirSync(directory, { recursive: true });
    const environment = {
      PATH: emptyBin, HOME: home, USERPROFILE: home, TMPDIR: temporary, TEMP: temporary,
      npm_config_cache: join(temporary, "empty-npm-cache"),
    };
    execFileSync(process.execPath, [
      npm, "install", archive, "--offline", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
      "--package-lock=true", "--lockfile-version=3", "--omit=dev", "--workspaces=false",
    ], { cwd: installation, env: environment, stdio: "inherit" });
    const lock = JSON.parse(readFileSync(join(installation, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[`node_modules/${release.name}`].integrity, release.integrity);
    for (const path of Object.keys(lock.packages)) {
      assert.ok(!workerBuildDependencies.some((name) => path.endsWith(`/node_modules/${name}`) ||
        path === `node_modules/${name}`), `Worker build dependency installed: ${path}`);
    }
    const packagePath = join("node_modules", release.name);
    execFileSync(process.execPath, [officePreparation], { cwd: join(installation, packagePath), env: environment, stdio: "inherit" });
    const placed = join(managed, manifest.id, "installed");
    mkdirSync(dirname(placed));
    renameSync(installation, placed);
    const installed = join(placed, packagePath);
    const tests = join(temporary, "office.test.cjs");
    await build({
      absWorkingDir: root, entryPoints: ["test/integration/office.test.ts"], outfile: tests,
      bundle: true, platform: "node", format: "cjs", target: "node22",
      plugins: [{
        name: "installed-reader",
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/\.\.\/server\// }, ({ path }) => ({
            path: join(installed, path.slice("../../".length) + ".ts"),
          }));
          builder.onResolve({ filter: /^@getpaseo\/plugin$/ }, ({ path }) => ({ path: resolve(path) }));
        },
      }],
    });
    execFileSync(process.execPath, [tests], { cwd: home, env: environment, stdio: "inherit", timeout: 150_000 });
    console.log(`Installed ${release.id} offline and verified the bundled readers.`);
    if (paseo) checkPaseoInstallation(join(temporary, "daemon"), installed, manifest.id);
  } else {
    copyFileSync(archive, join(root, release.filename));
    console.log(release.filename);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
