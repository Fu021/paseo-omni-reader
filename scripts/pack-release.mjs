import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const { values: { check } } = parseArgs({ options: { check: { type: "boolean" } } });
const npm = process.env.npm_execpath;
assert.ok(npm, "Run npm run pack:release.");
const root = process.cwd();
const workerBuildDependencies = ["@hyzyla/pdfium", "@resvg/resvg-wasm", "esbuild", "jpeg-js", "mathjax-full"];

function pack(directory, ...options) {
  const [result] = JSON.parse(execFileSync(process.execPath, [
    npm, "pack", "--json", "--ignore-scripts", ...options,
  ], { cwd: directory, encoding: "utf8" }));
  return result;
}

const source = pack(root, "--dry-run");
const files = new Set(source.files.map(({ path }) => path));
const manifest = JSON.parse(readFileSync("paseo-plugin.json", "utf8"));
const metadata = JSON.parse(readFileSync("package.json", "utf8"));
for (const path of [
  "paseo-plugin.json", "index.client.tsx", "index.server.ts", "OVERVIEW.md", "OVERVIEW.zh-CN.md",
  "server/generated/math-worker.ts", "server/generated/document-worker.ts", manifest.icon, ...manifest.media,
]) {
  assert.ok(files.has(path), `Missing from the npm package: ${path}`);
}
for (const path of files) {
  assert.ok(!path.startsWith("reader-test-fixtures/"), `Local fixture in the npm package: ${path}`);
}

const temporary = mkdtempSync(join(tmpdir(), "omni-reader-npm-"));
try {
  const staged = join(temporary, "package");
  for (const path of files) {
    const target = join(staged, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  delete manifest.build;
  writeFileSync(join(staged, "paseo-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  delete metadata.scripts;
  delete metadata.devDependencies;
  for (const name of workerBuildDependencies) delete metadata.dependencies[name];
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

  const release = pack(staged, "--pack-destination", temporary);
  assert.equal(release.id, source.id);
  files.add("npm-shrinkwrap.json");
  assert.deepEqual(new Set(release.files.map(({ path }) => path)), files);
  const archive = join(temporary, release.filename);

  if (check) {
    const installation = join(temporary, "installation");
    mkdirSync(installation);
    execFileSync(process.execPath, [
      npm, "install", archive, "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund",
      "--package-lock=true", "--lockfile-version=3", "--omit=dev", "--workspaces=false",
    ], { cwd: installation, stdio: "inherit" });
    const installed = join(installation, "node_modules", release.name);
    const lock = JSON.parse(readFileSync(join(installation, "package-lock.json"), "utf8"));
    assert.equal(lock.packages[`node_modules/${release.name}`].integrity, release.integrity);
    for (const path of Object.keys(lock.packages)) {
      assert.ok(!workerBuildDependencies.some((name) => path.endsWith(`/node_modules/${name}`) ||
        path === `node_modules/${name}`), `Worker build dependency installed: ${path}`);
    }
    assert.equal(JSON.parse(readFileSync(join(installed, "paseo-plugin.json"), "utf8")).build, undefined);
    console.log(`Packed and installed ${release.id} with ${release.files.length} files.`);
  } else {
    copyFileSync(archive, join(root, release.filename));
    console.log(release.filename);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
