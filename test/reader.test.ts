import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findFormulas, formulaKey } from "../shared/markdown-math";
import { assistantReplacement, shouldReplaceAssistant } from "../client/assistant-turn";
import { messageSchema } from "../shared/contracts";
import { readerSettings } from "../shared/reader-settings";
import { inlineMathMarker, readingBlocks, type InlineMath } from "../shared/reading-blocks";
import { shareAndroidFile } from "../client/android-file-share";
import { constrain, fitPages, jumpToPage, moveContacts, pageAt, pageBounds, zoomAt } from "../client/pdf-geometry";
import { createEngine } from "../server/engine";
import { openWithDefaultApp } from "../server/external-file";
import { rasterizePdf } from "../server/pdf-engine";
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

test("keeps one projected reply with the same original text in both rendering modes", () => {
  const item = { type: "assistant_message", text: "$a+b$", messageId: "math" } as const;
  const phase = "complete";
  const enhanced = assistantReplacement({ item, phase }, false);
  const original = assistantReplacement({ item, phase }, true);
  assert.equal(enhanced.items.length, 1);
  assert.equal(original.items.length, 1);
  assert.deepEqual(messageSchema.parse(enhanced.items[0].data), { text: item.text, phase, messageId: item.messageId });
  assert.deepEqual(messageSchema.parse(original.items[0].data), { ...enhanced.items[0].data, plain: true });
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
  assert.deepEqual(jumpToPage(fitted, 3, layout), { x: 0, y: -824, scale: 1 });
  assert.deepEqual(zoomAt(fitted, 2, { x: 300, y: 80 }, layout), { x: -300, y: -80, scale: 2 });
});

test("mouse drag and touch pinch/pan work at the upper edge of a zoomed PDF page", () => {
  const layout = fitPages([{ count: 2, width: 600, height: 800 }], { width: 360, height: 400 });
  const fitted = constrain({ x: 0, y: 0, scale: 1 }, layout);
  const mouse = [{ id: 1, x: 320, y: 35 }];
  const zoomed = constrain({ x: 0, y: 0, scale: 2 }, layout);
  const dragged = moveContacts(zoomed, mouse, [{ id: 1, x: 70, y: 35 }], layout);
  assert.deepEqual(dragged, { x: -240, y: 0, scale: 2 });
  const fingers = [{ id: 1, x: 130, y: 35 }, { id: 2, x: 230, y: 35 }];
  const pinched = moveContacts(fitted, fingers, [{ ...fingers[0], x: 60 }, { ...fingers[1], x: 300 }], layout);
  assert.equal(pinched.scale, 2.4);
  assert.equal(moveContacts(fitted, fingers, [{ ...fingers[0], x: -900 }, fingers[1]], layout).scale, 4);
  const panned = moveContacts(pinched, mouse, [{ id: 1, x: 30, y: 35 }], layout);
  assert.ok(panned.x < pinched.x);
  assert.equal(panned.y, pinched.y);
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
      ],
    });
    const [equation, display, fraction, invalid] = math.images;
    for (const image of [equation, display, fraction]) {
      assert.match(image?.uris[0] ?? "", /^data:image\/svg\+xml;base64,/);
    }
    const glyphs = (uri: string) => Buffer.from(uri.split(",")[1], "base64").toString("utf8").match(/<g data-mml-node="mfrac">.*<\/g><\/g><\/svg>/)?.[0];
    assert.ok(display && fraction && glyphs(fraction.uris[0]));
    assert.ok(fraction.width >= display.width * 1.3 && fraction.height >= display.height * 1.3);
    assert.equal(glyphs(fraction.uris[0]), glyphs(display.uris[0]));
    assert.equal(invalid, null);
    for (const platform of ["ios", "android"] as const) {
      const { images: [formula] } = await engine.dispatch({
        kind: "math", color: "#dddddd", platform,
        formulas: [{ tex: "\\frac{a+b}{2}", display: false }],
      });
      assert.ok(formula && formula.uris.length === 1);
      assert.equal(formula.width, fraction.width);
      assert.equal(formula.height, fraction.height);
      assert.ok(formula.baseline && formula.baseline > 40 && formula.height - formula.baseline > 20);
      const png = Buffer.from(formula.uris[0].split(",")[1], "base64");
      assert.equal(png.readUInt32BE(16), formula.width * 3);
      assert.equal(png.readUInt32BE(20), formula.height * 3);
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
