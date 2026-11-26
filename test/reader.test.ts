import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findFormulas, formulaKey } from "../shared/markdown-math";
import { readingBlocks } from "../shared/reading-blocks";
import { constrain, moveContacts } from "../client/pdf-geometry";
import { createEngine } from "../server/engine";
import { loadTextPage, textPageBytes } from "../server/text-page";
import { makeLargePdf } from "./pdf-fixture";

test("preserves workspace links and replaces only genuine LaTeX, including a table cell", () => {
  const text = [
    String.raw`中文 \(E=mc^2\) English $a+b$，打开 [PDF](./大文件.pdf) 和 [代码](./src/math.ts#L31)。`,
    "",
    "| 项目 | Formula |",
    "| --- | --- |",
    String.raw`| norm | $\left|x\right|$ |`,
    "",
    String.raw`\[`,
    String.raw`\int_0^1 x^2\,dx=\frac13`,
    String.raw`\]`,
    "",
    "Cost $20 and $30, `echo \"$HOME\"`, and [Markdown](./file-$cash$.md).",
    String.raw`\$escaped$`,
    "",
    "```sh", "echo $unused$", "```", "",
    "    $literal$", "",
    "```math", "q^2", "```",
  ].join("\n");
  const spans = findFormulas(text);
  assert.deepEqual(spans.map((span) => span.tex), [
    "E=mc^2", "a+b", String.raw`\left|x\right|`, String.raw`\int_0^1 x^2\,dx=\frac13`, "q^2",
  ]);
  const image = { uris: ["data:image/png;base64,aGVsbG8="], width: 30, height: 12 };
  const blocks = readingBlocks(text, spans, new Map(spans.map((span) => [formulaKey(span), image])));
  const result = blocks.flatMap((block) => block.kind === "markdown" || block.kind === "code" ? [block.text] : []).join("\n");
  assert.match(result, /中文 !\[E=mc\^2\]\(data:image\/png;base64,aGVsbG8=\) English/);
  assert.ok(result.includes("[PDF](./大文件.pdf)"));
  assert.ok(result.includes("[代码](./src/math.ts#L31)"));
  assert.ok(result.includes("[Markdown](./file-$cash$.md)"));
  assert.ok(result.includes("echo $unused$"));
  assert.ok(result.includes(String.raw`\$escaped$`));
  const table = blocks.find((block) => block.kind === "table");
  assert.equal(table?.rows[1].length, 2);
  assert.match(table?.rows[1][1] ?? "", /data:image\/png/);
  assert.equal(blocks.filter(({ kind }) => kind === "formula").length, 2);
});

test("reads a UTF-8 Markdown document beyond 1 MiB by byte offset and retains code fences", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-text-"));
  try {
    const source = "# 文档\r\n\r\n```text\r\n" + "中英 Reader 🎉 long fenced code\r\n".repeat(36_000) + "```\r\n\r\nEnd";
    await writeFile(join(folder, "large.md"), source);
    const first = await loadTextPage(folder, "large.md", 0);
    assert.ok(first.size > 1024 * 1024);
    assert.ok(first.source.startsWith("# 文档"));
    assert.ok(first.nextOffset && first.nextOffset <= textPageBytes);
    assert.equal(first.fence?.marker, "```");
    assert.match(first.markdown, /```\n$/);
    let page = first;
    const recovered = [page.source];
    while (page.nextOffset !== null) {
      page = await loadTextPage(folder, "large.md", page.nextOffset, first.revision, page.fence);
      assert.ok(page.markdown.startsWith("```text\n"));
      recovered.push(page.source);
    }
    assert.equal(recovered.join(""), source);
    await writeFile(join(folder, "large.md"), "replacement");
    await assert.rejects(loadTextPage(folder, "large.md", first.nextOffset, first.revision), /File changed/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("workspace readers reject paths and symlinks outside the selected root", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-path-"));
  const outside = await mkdtemp(join(tmpdir(), "omni-outside-"));
  try {
    const secret = join(outside, "outside.md");
    await writeFile(secret, "outside");
    await symlink(secret, join(folder, "alias.md"), "file");
    await assert.rejects(loadTextPage(folder, secret, 0), /outside the workspace/);
    await assert.rejects(loadTextPage(folder, "alias.md", 0), /outside the workspace/);
  } finally {
    await Promise.all([folder, outside].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("mouse drag and touch pinch/pan work at the upper edge of a zoomed PDF page", () => {
  const page = { width: 600, height: 800 };
  const viewport = { width: 360, height: 400 };
  const fitted = constrain({ x: 0, y: 0, scale: 0.6 }, page, viewport);
  const mouse = [{ id: 1, x: 320, y: 35 }];
  const zoomed = constrain({ x: 0, y: 0, scale: 1.5 }, page, viewport);
  const dragged = moveContacts(zoomed, mouse, [{ id: 1, x: 70, y: 35 }], page, viewport);
  assert.deepEqual(dragged, { x: -250, y: 0, scale: 1.5 });
  const fingers = [{ id: 1, x: 130, y: 35 }, { id: 2, x: 230, y: 35 }];
  const pinched = moveContacts(fitted, fingers, [{ ...fingers[0], x: 60 }, { ...fingers[1], x: 300 }], page, viewport);
  assert.ok(pinched.scale > 1.4);
  const panned = moveContacts(pinched, mouse, [{ id: 1, x: 30, y: 35 }], page, viewport);
  assert.ok(panned.x < pinched.x);
  assert.equal(panned.y, pinched.y);
});

test("renders formula pixels and selects pages in a PDF larger than 1 MiB using the packaged worker", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-render-"));
  const engine = createEngine();
  try {
    const pdf = makeLargePdf();
    assert.ok(pdf.byteLength > 1024 * 1024);
    await writeFile(join(folder, "report.pdf"), pdf);
    const math = await engine.dispatch({
      kind: "math", color: "#dddddd", platform: "web",
      formulas: [{ tex: "E=mc^2", display: false }, { tex: "\\frac{1}{2}", display: true }],
    });
    for (const png of math.images) assert.match(png?.uris[0] ?? "", /^data:image\/png;base64,iVBORw0KGgo/);
    for (const platform of ["ios", "android"] as const) {
      const { images: [formula] } = await engine.dispatch({
        kind: "math", color: "#dddddd", platform,
        formulas: [{ tex: "E=mc^2", display: false }],
      });
      assert.ok(formula && formula.uris.length > 1);
      for (const uri of formula.uris) {
        const png = Buffer.from(uri.split(",")[1], "base64");
        assert.equal(png.readUInt32BE(16), png.readUInt32BE(20));
      }
    }
    const first = await engine.dispatch({ kind: "pdf", root: folder, path: "report.pdf", page: 1, pixels: 640 });
    const second = await engine.dispatch({ kind: "pdf", root: folder, path: "report.pdf", page: 2, pixels: 640 });
    assert.deepEqual([first.page, second.page, second.pages, second.width, second.height], [1, 2, 2, 600, 800]);
    assert.match(second.uri, /^data:image\/jpeg;base64,\/9j\//);
    assert.notEqual(first.uri, second.uri);
  } finally {
    engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
});
