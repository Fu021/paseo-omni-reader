import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const npm = process.env.npm_execpath;
assert.ok(npm, "Run the package check with npm run check:package.");
const [pack] = JSON.parse(execFileSync(process.execPath, [npm, "pack", "--dry-run", "--json", "--ignore-scripts"], {
  encoding: "utf8",
}));
const manifest = JSON.parse(readFileSync("paseo-plugin.json", "utf8"));
const files = new Set(pack.files.map(({ path }) => path));
const required = [
  "paseo-plugin.json",
  "index.client.tsx",
  "index.server.ts",
  "OVERVIEW.md",
  "OVERVIEW.zh-CN.md",
  "server/generated/math-worker.ts",
  "server/generated/document-worker.ts",
  manifest.icon,
  ...manifest.media,
];

for (const path of required) assert.ok(files.has(path), `Missing from the npm package: ${path}`);
for (const path of files) assert.ok(!path.startsWith("reader-test-fixtures/"), `Local fixture in the npm package: ${path}`);
console.log(`Checked ${files.size} package files for ${pack.name}@${pack.version}.`);
