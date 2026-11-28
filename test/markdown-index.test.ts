import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarkdownInfo, loadMarkdownSource, findMarkdownLines } from "../server/markdown-index";
import { loadMarkdownPage } from "../server/markdown-page";
import { inlineReferenceLinks } from "../shared/markdown-references";
import { readingBlocks } from "../shared/reading-blocks";
import { markdownSearchPageSize } from "../shared/contracts";

const literal = { matchCase: false, wholeWord: false, regex: false };

test("indexes authored UTF-8 lines, front matter, headings, and cross-page Markdown references", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omni-index-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "notes"));
  const path = "notes/report.md";
  const filler = Array.from({ length: 6000 }, (_, index) => `第 ${index + 1} 行 ${"estuary ".repeat(28)}`);
  const source = ["---", "status: ready", "tags: [tide, 潮汐]", "---", "# 潮汐 Log", "",
    "[large PDF][atlas] and ![photo][asset]", "", "```md", "# Hidden heading", "```", "",
    "潮汐 Log", "-------", "", ...filler, "", "## Deep water", "", "Deep-water beacon and $x^2$", "",
    "[atlas]: ../large.pdf \"Atlas\"", "[asset]: ../image.png", ""];
  await writeFile(join(root, path), "\uFEFF" + source.join("\r\n"));
  const deep = source.indexOf("## Deep water") + 1;
  const info = await loadMarkdownInfo(root, path);
  assert.equal(info.lineCount, source.length);
  assert.deepEqual(info.frontMatter, [{ key: "status", value: "ready" }, { key: "tags", value: "tide, 潮汐" }]);
  assert.equal(info.frontMatterEnd, 4);
  assert.deepEqual(info.headings.map(({ line, anchor }) => [line, anchor]), [[5, "潮汐-log"], [13, "潮汐-log-1"], [deep, "deep-water"]]);
  const page = await loadMarkdownPage(root, path, 0);
  assert.ok(page.nextOffset !== null);
  assert.match(inlineReferenceLinks(page.markdown, info.references),
    /\[large PDF\]\(<\.\/large\.pdf> "Atlas"\) and !\[photo\]\(<\.\/image\.png>\)/);
  assert.match(inlineReferenceLinks("```md\n[keep][atlas]\n```\n\n[visible][atlas]", info.references),
    /```md\n\[keep\]\[atlas\]\n```\n\n\[visible\]\(<\.\/large\.pdf> "Atlas"\)/);
  const jump = await loadMarkdownPage(root, path, 0, undefined, undefined, undefined, 1, deep);
  assert.equal(jump.firstLine, deep);
  assert.match(jump.source, /^## Deep water/);
  assert.equal((await loadMarkdownSource(root, path, 1, 1)).lines[0].text, "---");
  const lines = await loadMarkdownSource(root, path, deep, deep + 2);
  assert.equal(lines.firstLine, deep);
  assert.deepEqual(lines.lines.map(({ text, ending }) => [text, ending]), source.slice(deep - 1, deep + 2).map((line) => [line, "\r\n"]));
  assert.deepEqual((await findMarkdownLines(root, path, "deep-water BEACON", literal, 0)).hits,
    [{ line: deep + 2, column: 0, length: "Deep-water beacon".length }]);
  const many = await findMarkdownLines(root, path, "estuary", literal, markdownSearchPageSize);
  assert.equal(many.total, 6000 * 28);
  assert.equal(many.hits.length, markdownSearchPageSize);
  assert.deepEqual(many.hits[0], { line: 16 + 18, column: "第 19 行 ".length + 8 * 8, length: 7 });
});

test("finds distinct source columns with case, Unicode word boundaries and regular expressions", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omni-find-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = "search.md";
  await writeFile(join(root, path), "🌊 Tide tide tidepool\n潮汐 潮汐表 （潮汐）\nX-123 X-456\n");
  const run = (query: string, options = literal) => findMarkdownLines(root, path, query, options, 0);
  assert.deepEqual((await run("tide")).hits.map(({ column }) => column), [3, 8, 13]);
  assert.equal((await run("tide", { ...literal, matchCase: true })).total, 2);
  assert.deepEqual((await run("潮汐", { ...literal, wholeWord: true })).hits.map(({ column }) => column), [0, 8]);
  const regex = { ...literal, regex: true };
  assert.deepEqual((await run("X-\\d+", regex)).hits.map(({ column, length }) => [column, length]), [[0, 5], [6, 5]]);
  assert.equal((await run("^", regex)).total, 4);
  assert.equal((await run("[", regex)).invalidPattern, true);
  assert.equal((await run(".")).total, 0);
});

test("keeps CRLF crossing an index buffer and handles empty files and unterminated lines", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omni-line-endings-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = "notes.md";
  await writeFile(join(root, path), "");
  assert.equal((await loadMarkdownInfo(root, path)).lineCount, 1);
  const giant = "潮".repeat(21_845);
  await writeFile(join(root, path), `${giant}\r\n第二行\rthird`);
  const result = await loadMarkdownSource(root, path, 1);
  assert.deepEqual(result.lines.map(({ text, ending }) => [text, ending]), [[giant, "\r\n"], ["第二行", "\r"], ["third", ""]]);
  assert.equal((await loadMarkdownInfo(root, path)).lineCount, 3);
});

test("keeps left, center and right Markdown column alignment in enhanced previews", () => {
  const blocks = readingBlocks("| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |", [], new Map());
  assert.deepEqual(blocks, [{ kind: "table", rows: [["A", "B", "C"], ["1", "2", "3"]], alignment: ["left", "center", "right"] }]);
});

test("jumps into a deep Markdown table or code fence while retaining its preview structure", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "omni-index-blocks-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = "blocks.md";
  const names = Array.from({ length: 450 }, (_, index) => `| Station ${index} | ${"measurement ".repeat(18)} |`);
  const code = Array.from({ length: 450 }, (_, index) => `const station${index} = ${index};`);
  await writeFile(join(root, path), ["# Block varieties", "", "| Station | Reading |", "| --- | ---: |",
    ...names, "", "```ts", ...code, "```", ""].join("\n"));
  const table = await loadMarkdownPage(root, path, 0, undefined, undefined, undefined, 1, 410);
  assert.equal(table.prefixLines, 2);
  assert.match(table.markdown, /^\| Station \| Reading \|/);
  assert.match(table.markdown, /Station 405/);
  const fence = await loadMarkdownPage(root, path, 0, undefined, undefined, undefined, 1, 850);
  assert.equal(fence.prefixLines, 1);
  assert.match(fence.markdown, /^```ts\n/);
  assert.match(fence.markdown, /const station393 = 393;/);
});
