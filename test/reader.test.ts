import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findFormulas, formulaKey } from "../shared/markdown-math";
import { inlineMathMarker, readingBlocks, type InlineMath } from "../shared/reading-blocks";
import { shareAndroidFile } from "../client/android-file-share";
import { constrain, moveContacts } from "../client/pdf-geometry";
import { createEngine } from "../server/engine";
import { loadTextPage, textPageBytes } from "../server/text-page";
import { makeLargePdf } from "./pdf-fixture";

test("opens the Android share sheet with the file panel's local URI and MIME type", async (context) => {
  const originalExpo = Object.getOwnPropertyDescriptor(globalThis, "expo");
  const shareAsync = context.mock.fn(async (_url: string, _options: { dialogTitle: string; mimeType?: string }) => {});
  const file = { url: context.mock.fn(async () => "file:///cache/preview.pdf"), mimeType: "application/pdf" };
  const setExpo = (value: unknown) => Object.defineProperty(globalThis, "expo", { configurable: true, value });
  try {
    setExpo(undefined);
    assert.equal(await shareAndroidFile(file, "Report.pdf"), false);
    assert.equal(file.url.mock.callCount(), 0);

    setExpo({ modules: { ExpoSharing: { shareAsync } } });
    assert.equal(await shareAndroidFile(file, "Report.pdf"), true);
    assert.deepEqual(shareAsync.mock.calls[0].arguments, [
      "file:///cache/preview.pdf", { dialogTitle: "Report.pdf", mimeType: "application/pdf" },
    ]);
    assert.equal(await shareAndroidFile({ ...file, url: async () => "https://example.test/report.pdf" }, "Report.pdf"), false);
    assert.equal(shareAsync.mock.callCount(), 1);
  } finally {
    if (originalExpo) Object.defineProperty(globalThis, "expo", originalExpo);
    else Reflect.deleteProperty(globalThis, "expo");
  }
});

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
  const blocks = readingBlocks(text, spans, new Map(spans.map((span) => [formulaKey(span), image])), true);
  const result = blocks.flatMap((block) => block.kind === "markdown" || block.kind === "code" ? [block.text] : []).join("\n");
  assert.match(result, /中文 !\[E=mc\^2\]\(data:image\/png;base64,aGVsbG8= "omni-latex:12:E%3Dmc%5E2"\) English/);
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

test("recognizes each completed formula in a streamed reply and keeps its source while the image loads", () => {
  const first = String.raw`中文 \(\frac{a+b}{2}\) English`;
  assert.equal(findFormulas(String.raw`中文 \(\frac{a+b`).length, 0);
  assert.deepEqual(findFormulas(first + " and $x^").map(formulaKey), [String.raw`inline:\frac{a+b}{2}`]);
  const next = first + " and $x^2$.\n\n" + String.raw`\(y=3\)` + "\n\n````math\nz=4\n```";
  const spans = findFormulas(next);
  assert.deepEqual(spans.map(formulaKey), [String.raw`inline:\frac{a+b}{2}`, "inline:x^2", "display:y=3"]);
  const blocks = readingBlocks(next, spans, new Map());
  assert.match(blocks[0].kind === "markdown" ? blocks[0].text : "", /\\\\\(\\\\frac/);
  assert.deepEqual(blocks[1], { kind: "formula", image: undefined, tex: "y=3", source: String.raw`\(y=3\)` });
  assert.equal(findFormulas(next + "\n````").at(-1)?.tex, "z=4\n```");
});

test("renders formulas while the document queue is full", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-worker-"));
  const engine = createEngine();
  try {
    const pdf = { kind: "pdf", root: folder, path: "missing.pdf", page: 1, pixels: 256 } as const;
    const documents = Promise.allSettled(Array.from({ length: 24 }, () => engine.dispatch(pdf)));
    const { images } = await engine.dispatch({
      kind: "math", platform: "web", color: "#16181a",
      formulas: [{ tex: String.raw`\frac{a+b}{2}`, display: false }],
    });
    assert.match(images[0]?.uris[0] ?? "", /^data:image\/svg\+xml;base64,/);
    assert.equal((await documents).filter(({ status }) => status === "rejected").length, 24);
  } finally {
    engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("keeps native math as individual attachments and retains chat links", () => {
  const text = String.raw`中文 $\frac{a+b}{2}$ English [PDF](./report.pdf) [TS](./example.ts#L31).`;
  const spans = findFormulas(text);
  const image = { uris: ["data:image/png;base64,aGVsbG8="], width: 55, height: 29, baseline: 20 };
  const attachments: InlineMath[] = [];
  const [block] = readingBlocks(text, spans, new Map([[formulaKey(spans[0]), image]]), false, attachments);
  assert.equal(block.kind, "markdown");
  assert.match(block.text, inlineMathMarker);
  assert.match(block.text, /\[PDF\]\(\.\/report\.pdf\) \[TS\]\(\.\/example\.ts#L31\)/);
  assert.doesNotMatch(block.text, /data:image/);
  assert.deepEqual(attachments, [{ image, tex: String.raw`\frac{a+b}{2}` }]);
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
      formulas: [
        { tex: "E=mc^2", display: false }, { tex: "\\frac{1}{2}", display: true },
        { tex: "\\frac{a+b}{2}", display: false },
        { tex: "\\unknowncommand{x}", display: false },
      ],
    });
    const [equation, display, fraction, invalid] = math.images;
    for (const image of [equation, display, fraction]) {
      assert.match(image?.uris[0] ?? "", /^data:image\/svg\+xml;base64,/);
    }
    const fractionSvg = Buffer.from(fraction?.uris[0].split(",")[1] ?? "", "base64").toString("utf8");
    assert.match(fractionSvg, /scale\(0\.92\)/);
    assert.equal(invalid, null);
    for (const platform of ["ios", "android"] as const) {
      const { images: [formula] } = await engine.dispatch({
        kind: "math", color: "#dddddd", platform,
        formulas: [{ tex: "\\frac{a+b}{2}", display: false }],
      });
      assert.ok(formula && formula.uris.length === 1);
      assert.ok(formula.baseline && formula.baseline > 12 && formula.height - formula.baseline > 4);
      const png = Buffer.from(formula.uris[0].split(",")[1], "base64");
      assert.equal(png.readUInt32BE(16), formula.width * 3);
      assert.equal(png.readUInt32BE(20), formula.height * 3);
    }
    const first = await engine.dispatch({ kind: "pdf", root: folder, path: "report.pdf", page: 1, pixels: 640 });
    const second = await engine.dispatch({ kind: "pdf", root: folder, path: "report.pdf", page: 2, pixels: 640 });
    assert.deepEqual([first.page, second.page, second.pages, second.width, second.height], [1, 2, 2, 600, 800]);
    assert.match(second.uri, /^data:image\/jpeg;base64,\/9j\//);
    assert.notEqual(first.uri, second.uri);
    await writeFile(join(folder, "sample.csv"), '指标,说明\r\n平均值,"分子, 分母"\r\n"quoted\nlabel",4\r\n');
    const csv = await engine.dispatch({ kind: "document", root: folder, path: "sample.csv" });
    assert.deepEqual(csv.sections[0].blocks[0], {
      kind: "table", rows: [["指标", "说明"], ["平均值", "分子, 分母"], ["quoted\nlabel", "4"]], header: true,
    });
  } finally {
    engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
});
