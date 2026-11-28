import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findFormulas, formulaKey, markdownParser } from "../shared/markdown-math";
import { assistantReplacement, shouldReplaceAssistant } from "../client/assistant-turn";
import { messageSchema } from "../shared/contracts";
import { readerSettings } from "../shared/reader-settings";
import { inlineMathMarker, readingBlocks, type InlineMath } from "../shared/reading-blocks";
import { shareAndroidFile } from "../client/android-file-share";
import { createPageRenderQueue } from "../client/page-render-queue";
import { constrain, fitPagePosition, fitPages, jumpToPage, pageAt, pageBounds, visiblePages, zoomAt } from "../client/pdf-geometry";
import { constrainGrid, panAndPinch, zoomAround, type Contact, type Position } from "../client/viewport-geometry";
import { createEngine } from "../server/engine";
import { openWithDefaultApp } from "../server/external-file";
import { inspectPdf, inspectPdfPages, rasterizePdf, rasterizePdfPage } from "../server/pdf-engine";
import { loadMarkdownPage, markdownPageBytes } from "../server/markdown-page";
import { makeLargePdf } from "./pdf-fixture";

test("claims assistant messages only when Omni Reader can enhance them", () => {
  assert.equal(shouldReplaceAssistant("Read [the PDF](./report.pdf)."), false);
  assert.equal(shouldReplaceAssistant("Price: $20 and $30."), false);
  assert.equal(shouldReplaceAssistant(String.raw`中文 \(\frac{a+b`), false);
  assert.equal(shouldReplaceAssistant(String.raw`中文 \(\frac{a+b}{2}\) English`), true);
  assert.equal(shouldReplaceAssistant("```ui\n$x^2$\n```"), false);
  assert.equal(shouldReplaceAssistant("| A | B |\n| --- | --- |\n| C | D |"), true);
  assert.equal(shouldReplaceAssistant("```ts\nconst price = '$a$';\n```"), true);
});

test("keeps one projected reply with the original text throughout streaming", () => {
  const item = { type: "assistant_message", text: "$a+b$", messageId: "math" } as const;
  for (const phase of ["streaming", "complete"] as const) {
    const projected = assistantReplacement({ item, phase });
    assert.equal(projected.items.length, 1);
    assert.deepEqual(messageSchema.parse(projected.items[0].data), { text: item.text, phase, messageId: item.messageId });
  }
});

test("keeps independent whole percentages for both formula sizes", () => {
  const defaults = { inlineFormulaSize: "100", displayFormulaSize: "100" };
  assert.deepEqual(readerSettings.schema.parse({}), defaults);
  for (const field of ["inlineFormulaSize", "displayFormulaSize"]) {
    for (const size of ["50", "101", "200"]) {
      assert.deepEqual(readerSettings.schema.parse({ [field]: size }), { ...defaults, [field]: size });
    }
    for (const size of ["", "49", "50.5", "100%", "201"]) {
      assert.equal(readerSettings.schema.safeParse({ [field]: size }).success, false);
    }
  }
});

test("scales inline formula geometry without changing the rendered asset or display formulas", () => {
  const text = "Inline $a+b$.\n\n$$\na+b\n$$";
  const spans = findFormulas(text);
  const image = { uris: ["data:image/png;base64,aGVsbG8="], width: 40, height: 30, baseline: 20 };
  const images = new Map(spans.map((span) => [formulaKey(span), image]));
  const nativeMath: InlineMath[] = [];
  const native = readingBlocks(text, spans, images, false, nativeMath, 1.5);
  assert.deepEqual(nativeMath, [{ tex: "a+b", image: { ...image, width: 60, height: 45, baseline: 30 } }]);
  assert.ok(native.some((block) => block.kind === "formula" && block.image === image));
  const web = readingBlocks(text, spans, images, true, undefined, 1.5);
  assert.ok(web.some((block) => block.kind === "markdown" && block.text.includes("omni-latex:60:45:15:a%2Bb")));
  assert.ok(web.some((block) => block.kind === "formula" && block.image === image));
});

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
  assert.match(result, /中文 !\[E=mc\^2\]\(data:image\/png;base64,aGVsbG8= "omni-latex:30:12:2:E%3Dmc%5E2"\) English/);
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

test("workspace preview and external opening reject paths and symlinks outside the selected root", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-path-"));
  const outside = await mkdtemp(join(tmpdir(), "omni-outside-"));
  try {
    const secret = join(outside, "outside.pdf");
    await writeFile(secret, "outside");
    await symlink(secret, join(folder, "alias.pdf"), "file");
    for (const path of [secret, "alias.pdf"]) {
      await assert.rejects(rasterizePdf(folder, path, 1, 640), /outside the workspace/);
      await assert.rejects(openWithDefaultApp(folder, path), /outside the workspace/);
    }
  } finally {
    await Promise.all([folder, outside].map((path) => rm(path, { recursive: true, force: true })));
  }
});

test("passes the original path to the system opener without Electron daemon flags",
  { skip: process.platform !== "linux" }, async () => {
    const folder = await mkdtemp(join(tmpdir(), "omni-opener-"));
    const originalEnv = process.env;
    try {
      const filename = "中文 [rep] $1.pdf";
      const target = join(folder, filename);
      const trace = join(folder, "opened");
      await writeFile(target, "%PDF-1.7");
      await writeFile(join(folder, "gio"), [
        "#!/bin/sh",
        '[ -z "$ELECTRON_RUN_AS_NODE" ] && [ -z "$PASEO_DESKTOP_MANAGED" ] && [ "$1" = open ] || exit 1',
        'printf "%s" "$2" > "$OMNI_TEST_OPENER_TRACE"',
      ].join("\n"), { mode: 0o700 });
      process.env = {
        ...originalEnv, PATH: folder, ELECTRON_RUN_AS_NODE: "1", PASEO_DESKTOP_MANAGED: "1", OMNI_TEST_OPENER_TRACE: trace,
      };
      await openWithDefaultApp(folder, filename);
      assert.equal(await readFile(trace, "utf8"), target);
    } finally {
      process.env = originalEnv;
      await rm(folder, { recursive: true, force: true });
    }
  });

test("continues between portrait and landscape pages that each fit entirely at 100%", () => {
  const viewport = { width: 600, height: 500 };
  const layout = fitPages([{ count: 1, width: 750, height: 1_000 }, { count: 2, width: 1_200, height: 600 }], viewport);
  assert.deepEqual(pageBounds(layout, 1), { width: 375, height: 500, top: 0 });
  assert.deepEqual(pageBounds(layout, 2), { width: 600, height: 300, top: 512 });
  assert.deepEqual(pageBounds(layout, 3), { width: 600, height: 300, top: 824 });
  assert.equal(pageAt(layout, 511), 1);
  assert.equal(pageAt(layout, 512), 2);
  assert.equal(pageAt(layout, 824), 3);
  const fitted = constrain({ x: 0, y: 0, scale: 1 }, layout);
  assert.deepEqual(visiblePages(layout, fitted), { first: 1, last: 1 });
  assert.deepEqual(visiblePages(layout, { ...fitted, y: -12 }), { first: 1, last: 1 });
  assert.deepEqual(visiblePages(layout, { ...fitted, y: -13 }), { first: 1, last: 2 });
  assert.deepEqual(visiblePages(layout, { ...fitted, y: -500 }), { first: 2, last: 3 });
  assert.deepEqual(jumpToPage(fitted, 3, layout), { x: 0, y: -824, scale: 1 });
  const zoomed = zoomAt(fitted, 2, { x: 300, y: 80 }, layout);
  assert.deepEqual(zoomed, { x: -300, y: -80, scale: 2 });
  assert.deepEqual(visiblePages(layout, zoomed), { first: 1, last: 1 });
});

test("fills the reader width or fits the whole page according to the selected mode", () => {
  const pages = [{ count: 2, width: 612, height: 792 }];
  const phone = fitPages(pages, { width: 390, height: 700 });
  assert.deepEqual(fitPagePosition(phone, 2, "width"), fitPagePosition(phone, 2, "page"));
  const desktop = fitPages(pages, { width: 800, height: 500 });
  const fit = fitPagePosition(desktop, 2, "width");
  const page = pageBounds(desktop, 2);
  assert.ok(Math.abs(page.width * fit.scale - 800) < 0.001);
  assert.ok(Math.abs(page.top * fit.scale + fit.y) < 0.001);
  assert.equal(fitPagePosition(desktop, 2, "page").scale, 1);
  assert.ok(page.height * fit.scale > 500);
});

test("skips obsolete PDF and Office page requests before they reach the renderer", async () => {
  const enqueue = createPageRenderQueue();
  const active = new AbortController();
  const obsolete = new AbortController();
  const calls: number[] = [];
  let resolveFirstPage!: (page: number) => void;
  const firstPage = new Promise<number>((resolve) => { resolveFirstPage = resolve; });
  const running = enqueue(active.signal, () => {
    calls.push(1);
    return firstPage;
  });
  const oldPage = enqueue(obsolete.signal, async () => {
    calls.push(2);
    return 2;
  });
  const newPage = enqueue(active.signal, async () => {
    calls.push(8);
    return 8;
  });
  await Promise.resolve();
  assert.deepEqual(calls, [1]);
  obsolete.abort();
  resolveFirstPage(1);
  assert.equal(await running, 1);
  await assert.rejects(oldPage, /cancelled/);
  assert.equal(await newPage, 8);
  assert.deepEqual(calls, [1, 8]);
});

test("mouse drag and touch pinch/pan work at the upper edge of a zoomed PDF page", () => {
  const layout = fitPages([{ count: 2, width: 600, height: 800 }], { width: 360, height: 400 });
  const moveContacts = (position: Position, previous: Contact[], next: Contact[]) =>
    constrain(panAndPinch(position, previous, next), layout);
  const fitted = constrain({ x: 0, y: 0, scale: 1 }, layout);
  const mouse = [{ id: 1, x: 320, y: 35 }];
  const zoomed = constrain({ x: 0, y: 0, scale: 2 }, layout);
  const dragged = moveContacts(zoomed, mouse, [{ id: 1, x: 70, y: 35 }]);
  assert.deepEqual(dragged, { x: -240, y: 0, scale: 2 });
  const fingers = [{ id: 1, x: 130, y: 35 }, { id: 2, x: 230, y: 35 }];
  const pinched = moveContacts(fitted, fingers, [{ ...fingers[0], x: 60 }, { ...fingers[1], x: 300 }]);
  assert.equal(pinched.scale, 2.4);
  assert.equal(moveContacts(fitted, fingers, [{ ...fingers[0], x: -900 }, fingers[1]]).scale, 4);
  const panned = moveContacts(pinched, mouse, [{ id: 1, x: 30, y: 35 }]);
  assert.ok(panned.x < pinched.x);
  assert.equal(panned.y, pinched.y);
});

test("keeps the Excel gesture midpoint over the same cell and pans both axes after lifting a finger", () => {
  const viewport = { width: 300, height: 500 };
  const content = { width: 1_200, height: 4_000 };
  const before = { x: -80, y: -140, scale: 1 };
  const previous = [{ id: 1, x: 70, y: 80 }, { id: 2, x: 170, y: 80 }];
  const next = [{ id: 1, x: 30, y: 100 }, { id: 2, x: 230, y: 100 }];
  const pinched = constrainGrid(panAndPinch(before, previous, next), viewport, content);
  assert.deepEqual(pinched, { x: -270, y: -340, scale: 2 });
  assert.equal((130 - pinched.x) / pinched.scale, 120 - before.x);
  assert.equal((100 - pinched.y) / pinched.scale, 80 - before.y);
  assert.strictEqual(panAndPinch(pinched, next, next.slice(1)), pinched);
  const panned = panAndPinch(pinched, next.slice(1), [{ id: 2, x: 160, y: 50 }]);
  assert.deepEqual(panned, { x: -340, y: -390, scale: 2 });
  const reset = zoomAround(panned, 1, { x: 150, y: 250 });
  assert.deepEqual(reset, { x: -95, y: -70, scale: 1 });
  assert.deepEqual(constrainGrid({ x: -999, y: -999, scale: 0.25 }, viewport, content),
    { x: 0, y: -500, scale: 0.25 });
});

test("reads Markdown larger than 1 MiB in sections without splitting formulas or changing source links", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-markdown-"));
  try {
    const directory = join(folder, "notes");
    await mkdir(directory);
    const path = join(directory, "test.md");
    const tex = String.raw`\frac{a+b}{2}`;
    const source = "a".repeat(markdownPageBytes - 7) + ` $${tex}$ [PDF](../report.pdf)\n\n` +
      "中文 and English.\n\n".repeat(70_000);
    assert.ok(Buffer.byteLength(source) > 1024 * 1024);
    await writeFile(path, source);
    let page = await loadMarkdownPage(folder, path, 0);
    assert.ok(page.nextOffset);
    assert.match(page.markdown, /\[PDF\]\(\.\/report\.pdf\)/);
    assert.equal(findFormulas(page.markdown)[0]?.tex, tex);
    const chunks = [page.source];
    while (page.nextOffset !== null) {
      page = await loadMarkdownPage(folder, path, page.nextOffset, page.revision, page.fence);
      chunks.push(page.source);
    }
    assert.equal(chunks.join(""), source);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("continues a long Markdown table without changing its source or the blocks after it", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-markdown-table-"));
  const path = join(folder, "table.md");
  const header = "| Station | Reading |\n| --- | --- |\n";
  const rows = Array.from({ length: 1700 }, (_, index) => `| Station ${index} | 水位 $x^2$ ${"observed ".repeat(7)}|\n`);
  const source = "Introduction.\n\n" + header + rows.join("") + "\n### End of table\n\n" + "Another paragraph.\n\n".repeat(1800);
  try {
    await writeFile(path, source);
    let page = await loadMarkdownPage(folder, path, 0);
    const chunks = [page.source];
    assert.ok(page.table);
    let continuedPages = 0;
    let rowCount = 0;
    let foundHeading = false;
    while (true) {
      const tokens = markdownParser.parse(page.markdown, {});
      rowCount += tokens.filter(({ type, level }) => type === "tr_open" && level === 2).length -
        tokens.filter(({ type }) => type === "table_open").length;
      foundHeading ||= tokens.some(({ type, content }) => type === "inline" && content === "End of table");
      if (page.nextOffset === null) break;
      const previous = page;
      page = await loadMarkdownPage(folder, path, previous.nextOffset!, previous.revision, previous.fence, previous.table);
      if (previous.table) {
        assert.ok(page.markdown.startsWith(header));
        assert.ok(!page.source.includes(header));
        assert.equal(markdownParser.parse(page.markdown, {})[0]?.type, "table_open");
        continuedPages++;
      }
      chunks.push(page.source);
    }
    assert.ok(continuedPages > 1);
    assert.ok(foundHeading);
    assert.equal(rowCount, rows.length);
    assert.equal(chunks.join(""), source);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("renders formula pixels and selects pages in a PDF larger than 1 MiB using the packaged worker", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-render-"));
  const engine = createEngine();
  try {
    const pdf = makeLargePdf();
    assert.ok(pdf.byteLength > 1024 * 1024);
    await writeFile(join(folder, "report.pdf"), pdf);
    assert.deepEqual(await engine.dispatch({ kind: "pdf-layout", root: folder, path: "report.pdf" }),
      [{ count: 2, width: 600, height: 800 }]);
    const math = await engine.dispatch({
      kind: "math", color: "#dddddd", platform: "web",
      formulas: [
        { tex: "E=mc^2", display: false }, { tex: "\\frac{a+b}{2}", display: true },
        { tex: "\\frac{a+b}{2}", display: false },
        { tex: "\\unknowncommand{x}", display: false },
        { tex: String.raw`G\text{ 负定}\quad\Longleftrightarrow\quad-G\text{ 正定}.`, display: true },
      ],
    });
    const [equation, display, fraction, invalid, chinese] = math.images;
    for (const image of [equation, display, fraction, chinese]) {
      assert.match(image?.uris[0] ?? "", /^data:image\/svg\+xml;base64,/);
    }
    const svg = (uri: string) => Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    const glyphs = (uri: string) => svg(uri).match(/<path [^>]+>/g);
    assert.ok(display && fraction && chinese);
    assert.equal(glyphs(fraction.uris[0])?.length, 4);
    assert.match(svg(fraction.uris[0]), /<line /);
    assert.ok(fraction.width >= display.width * 1.3 && fraction.height >= display.height * 1.3);
    assert.deepEqual(glyphs(fraction.uris[0]), glyphs(display.uris[0]));
    const chineseGlyphs = glyphs(chinese.uris[0]);
    assert.ok(chineseGlyphs && chineseGlyphs.length >= 8);
    const repeatedGlyph = chineseGlyphs[2]?.match(/ d="([^"]+)"/)?.[1];
    assert.ok(repeatedGlyph && chineseGlyphs.filter((glyph) => glyph.includes(repeatedGlyph)).length === 2);
    assert.doesNotMatch(svg(chinese.uris[0]), /<(?:text|image)\b/);
    assert.equal(invalid, null);
    for (const platform of ["ios", "android"] as const) {
      const { images: [formula, mixed] } = await engine.dispatch({
        kind: "math", color: "#dddddd", platform,
        formulas: [
          { tex: "\\frac{a+b}{2}", display: false },
          { tex: String.raw`G\text{ 负定}\quad\Longleftrightarrow\quad-G\text{ 正定}.`, display: true },
        ],
      });
      assert.ok(formula && formula.uris.length === 1);
      assert.equal(formula.width, fraction.width);
      assert.equal(formula.height, fraction.height);
      assert.ok(formula.baseline && formula.baseline > 40 && formula.height - formula.baseline > 20);
      const png = Buffer.from(formula.uris[0].split(",")[1], "base64");
      assert.equal(png.readUInt32BE(16), formula.width * 3);
      assert.equal(png.readUInt32BE(20), formula.height * 3);
      assert.ok(mixed && mixed.width === chinese.width && mixed.baseline === chinese.baseline);
      assert.match(mixed.uris[0], /^data:image\/png;base64,/);
    }
    const first = await engine.dispatch({ kind: "pdf", root: folder, path: "report.pdf", page: 1, pixels: 640 });
    const second = await engine.dispatch({ kind: "pdf", root: folder, path: "report.pdf", page: 2, pixels: 640 });
    assert.deepEqual([first.page, second.page, second.pages, second.width, second.height], [1, 2, 2, 600, 800]);
    assert.match(second.uri, /^data:image\/jpeg;base64,\/9j\//);
    assert.notEqual(first.uri, second.uri);
    assert.equal((await engine.dispatch({ kind: "pdf-text", root: folder, path: "report.pdf", page: 1 })).text, "");
    const pageText = await engine.dispatch({ kind: "pdf-text", root: folder, path: "report.pdf", page: 2 });
    assert.match(pageText.text, /Tidal observatory marker/);
    const query = "OBSERVATORY marker";
    const start = pageText.text.toLowerCase().indexOf(query.toLowerCase());
    assert.ok(pageText.glyphs?.some(([offset]) => offset === start));
    assert.deepEqual(await engine.dispatch({ kind: "pdf-search", root: folder, path: "report.pdf", query,
      options: { matchCase: false, wholeWord: true, regex: false } }),
    { matches: [[2, start, start + query.length]], limited: false, invalidPattern: false });
    const tide = pageText.text.indexOf("潮汐");
    assert.ok(tide >= 0 && pageText.glyphs?.some(([offset, , left, , right]) => offset === tide && right > left));
    assert.deepEqual((await engine.dispatch({ kind: "pdf-search", root: folder, path: "report.pdf", query: "潮汐",
      options: { matchCase: true, wholeWord: false, regex: false } })).matches, [[2, tide, tide + 2]]);
  } finally {
    engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
});

test("reuses page layouts and rendered pages across documents and refreshes edited files", async () => {
  const folder = await mkdtemp(join(tmpdir(), "omni-page-cache-"));
  const document = makeLargePdf();
  const path = join(folder, "report.pdf");
  try {
    const original = async () => document;
    const key = `${folder}:office-original`;
    const originalLayout = await inspectPdfPages(key, original);
    const first = await rasterizePdfPage(key, original, 2, 256);
    await inspectPdfPages(`${folder}:other-document`, original);
    const noReload = async () => { throw new Error("A cached document was loaded again."); };
    assert.deepEqual(await inspectPdfPages(key, noReload), originalLayout);
    assert.deepEqual(await rasterizePdfPage(key, noReload, 2, 256), first);
    const larger = await rasterizePdfPage(key, original, 2, 512);
    assert.notEqual(larger.uri, first.uri);

    await writeFile(path, document);
    assert.deepEqual(await inspectPdf(folder, path), originalLayout);
    const before = await rasterizePdf(folder, path, 2, 256);
    const edited = document.toString().replaceAll("[0 0 600 800]", "[0 0 800 600]")
      .replace("0 0.8 0.4 rg", "1 0.2 0.1 rg");
    await writeFile(path, `${edited}\n`);
    assert.deepEqual(await inspectPdf(folder, path), [{ count: 2, width: 800, height: 600 }]);
    const after = await rasterizePdf(folder, path, 2, 256);
    assert.notEqual(after.uri, before.uri);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
