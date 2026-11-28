import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formulasPerRequest } from "../../shared/contracts";
import { findFormulas } from "../../shared/markdown-math";
import { createEngine } from "../../server/engine";
import { loadMarkdownInfo } from "../../server/markdown-index";
import { createOfficePreview } from "../../server/office-preview";
import { makeLargePdf } from "../pdf-fixture";
import { officeFixtures } from "./office-fixtures";

test("uses the bundled engines for multilingual previews", { timeout: 150_000 }, async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "omni-office-test-"));
  const engine = createEngine();
  const office = createOfficePreview(engine);
  try {
    await context.test("Chinese Markdown and LaTeX", async () => {
      const path = "notes.md";
      const formulas = [
        { tex: String.raw`G\text{ 负定}\quad\Longleftrightarrow\quad-G\text{ 正定}.`, display: true },
        { tex: String.raw`T_{\text{实测}}^{\text{校准}}=23.4`, display: false },
        { tex: String.raw`x_{i_{\text{甲}}}^{y^{\text{乙}}}`, display: false },
        { tex: String.raw`\sqrt[\text{阶}]{\frac{\text{潮位}}{n_{\text{样本}}}}`, display: false },
        { tex: String.raw`\sum_{i\in\text{站点}}^{\text{上限}}\frac{a_i}{\text{样本数}}\quad A\xrightarrow[\text{回测}]{\text{修正}}B`, display: true },
        { tex: String.raw`\underbrace{x_1+x_2}_{\text{观测总量}}\quad\overbrace{\frac{a}{b}}^{\text{归一化}}`, display: true },
        { tex: String.raw`f(x)=\begin{cases}x^2 & \text{当 } x\ge 0,\\-x & \text{否则。}\end{cases}`, display: true },
        { tex: String.raw`A=\begin{bmatrix}\text{甲}&\text{乙}\\\text{丙}&\text{丁}\end{bmatrix}`, display: true },
        { tex: String.raw`T_{实测}^{校准}`, display: false },
      ];
      const markdown = "# 观测 *Report*\n\n" + formulas.map(({ tex, display }) =>
        display ? `\\[\n${tex}\n\\]` : `中文 \\(${tex}\\) English.`).join("\n\n");
      await writeFile(join(folder, path), markdown);
      assert.equal((await loadMarkdownInfo(folder, path)).headings[0]?.title, "观测 Report");
      assert.deepEqual(findFormulas(markdown).map(({ tex, display }) => ({ tex, display })), formulas);

      const characters = [...new Set(formulas.flatMap(({ tex }) => tex.match(/\p{Script=Han}/gu) ?? []))];
      const render = (platform: "web" | "ios" | "android", entries: typeof formulas) =>
        engine.dispatch({ kind: "math", platform, color: "#333333", formulas: entries });
      const paths = (uri: string) => {
        assert.match(uri, /^data:image\/svg\+xml;base64,/);
        const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
        return [...svg.matchAll(/<path[^>]+ d="([^"]+)"/g)].map((match) => match[1]);
      };
      const glyphs = new Map<string, string>();
      for (let offset = 0; offset < characters.length; offset += formulasPerRequest) {
        const batch = characters.slice(offset, offset + formulasPerRequest);
        const { images: references } = await render("web", batch.map((character) => ({
          tex: `\\text{${character}}`, display: false,
        })));
        for (const [index, image] of references.entries()) {
          const character = batch[index];
          assert.ok(image, character);
          const [outline] = paths(image.uris[0]);
          assert.ok(outline, character);
          glyphs.set(character, outline);
        }
      }
      assert.equal(new Set(glyphs.values()).size, characters.length, "Chinese glyphs must have distinct outlines");
      const { images: web } = await render("web", formulas);
      for (const [index, { tex }] of formulas.entries()) {
        const image = web[index];
        assert.ok(image?.width && image.baseline && image.baseline < image.height, tex);
        const outlines = paths(image.uris[0]);
        for (const character of new Set(tex.match(/\p{Script=Han}/gu))) {
          const outline = glyphs.get(character);
          assert.ok(outline && outlines.includes(outline), `Missing ${character} in ${tex}`);
        }
      }
      for (const platform of ["ios", "android"] as const) {
        const { images } = await render(platform, formulas);
        for (const [index, image] of images.entries()) {
          const reference = web[index];
          assert.ok(image && reference, `${platform}: ${formulas[index].tex}`);
          assert.deepEqual([image.width, image.height, image.baseline],
            [reference.width, reference.height, reference.baseline]);
          assert.match(image.uris[0], /^data:image\/png;base64,/);
          const png = Buffer.from(image.uris[0].split(",")[1], "base64");
          assert.equal(png.readUInt32BE(16), image.width * 3);
          assert.equal(png.readUInt32BE(20), image.height * 3);
        }
      }
    });
    await context.test("multilingual PDF", async () => {
      const path = "report.pdf";
      const file = { root: folder, path };
      await writeFile(join(folder, path), makeLargePdf());
      const page = await engine.dispatch({ kind: "pdf", ...file, page: 2, pixels: 640 });
      assert.equal(page.pages, 2);
      assert.match(page.uri, /^data:image\/jpeg;base64,\/9j\//);
      const text = await engine.dispatch({ kind: "pdf-text", ...file, page: 2 });
      assert.match(text.text, /Tidal observatory marker/);
      const offset = text.text.indexOf("潮汐");
      assert.ok(offset >= 0 && text.glyphs?.some(([start, , left, , right]) => start === offset && right > left));
      const search = await engine.dispatch({ kind: "pdf-search", ...file, query: "潮汐",
        options: { matchCase: true, wholeWord: false, regex: false } });
      assert.deepEqual(search.matches, [[2, offset, offset + 2]]);
    });
    for (const fixture of officeFixtures) {
      const { make, extension } = fixture;
      await context.test(extension, async () => {
        const path = join(folder, `report.${extension}`);
        await writeFile(path, make());
        if (extension === "xlsx") {
          const workbook = await engine.dispatch({ kind: "worksheet", root: folder, path, sheet: 0 });
          assert.deepEqual(workbook.names, ["季度 Report"]);
          assert.equal(workbook.sheet.truncated, false);
          assert.equal(workbook.sheet.columns.length, 3);
          assert.equal(workbook.sheet.columns[2], 0);
          assert.equal(workbook.sheet.rows.length, 4);
          assert.equal(workbook.sheet.rows[3], 0);
          assert.deepEqual(workbook.sheet.merges, [[0, 1, 0, 2]]);
          assert.deepEqual(workbook.sheet.styles[1], {
            bold: true, italic: false, color: "#184B68", fill: "#E7F3F8", fontSize: 16, align: "center", wrap: true,
          });
          assert.deepEqual(workbook.sheet.cells.map(([row, column, text, _style, numeric]) => [row, column, text, numeric]), [
            [0, 0, "季度 Quarter", false], [0, 1, "Sales", false], [1, 0, "Q1", false],
            [1, 1, "125", true], [2, 0, "Q2", false], [2, 1, "1,234.50", true], [3, 0, "隐藏 Hidden", false],
          ]);
          const search = (query: string, options: { matchCase?: boolean; wholeWord?: boolean; regex?: boolean } = {}) =>
            engine.dispatch({ kind: "worksheet-search", root: folder, path, sheet: 0, query,
              options: { matchCase: false, wholeWord: false, regex: false, ...options } });
          assert.deepEqual((await search("sales")).matches, [[0, 1, 0, 5]]);
          assert.deepEqual((await search("sales", { matchCase: true })).matches, []);
          assert.deepEqual((await search("ale", { wholeWord: true })).matches, []);
          assert.deepEqual((await search("季度")).matches, [[0, 0, 0, 2]]);
          assert.deepEqual((await search("隐藏")).matches, []);
          assert.deepEqual((await search("Q[12]", { regex: true })).matches, [[1, 0, 0, 2], [2, 0, 0, 2]]);
          assert.equal((await search("[", { regex: true })).invalidPattern, true);
          assert.equal(await office.layoutStatus(folder, path), null);
          assert.equal(await office.page(folder, path, 1, 640), null);
          return;
        }
        const { pages } = fixture;
        let layout = await office.layoutStatus(folder, path);
        while (layout === "loading") layout = await office.layoutStatus(folder, path);
        assert.equal(layout?.reduce((count, group) => count + group.count, 0), pages);
        const first = await office.page(folder, path, 1, 640);
        assert.ok(first);
        assert.equal(first.pages, pages);
        assert.match(first.uri, /^data:image\/jpeg;base64,/);
        const text = await office.text(folder, path, 1);
        assert.match(text?.text ?? "", /Omni Reader/i);
        const start = text?.text.indexOf("Omni Reader") ?? -1;
        const firstGlyph = text?.glyphs?.find(([offset]) => offset === start);
        assert.ok(firstGlyph);
        const [, , left, top, right, bottom] = firstGlyph;
        assert.ok(left >= 0 && right > left && right <= 1 && top >= 0 && bottom > top && bottom <= 1);
        const options = { matchCase: false, wholeWord: false, regex: false };
        const found = await office.search(folder, path, "omni reader", options);
        assert.deepEqual(found?.matches, [[1, start, start + "Omni Reader".length]]);
        assert.deepEqual((await office.search(folder, path, "omni reader", { ...options, matchCase: true }))?.matches, []);
        assert.deepEqual((await office.search(folder, path, "Omni R[a-z]+", { ...options, regex: true }))?.matches, found?.matches);
        assert.equal((await office.search(folder, path, "[", { ...options, regex: true }))?.invalidPattern, true);
        assert.deepEqual((await office.search(folder, path, "read", { ...options, wholeWord: true }))?.matches, []);
        if (extension === "docx") {
          const chinese = "中文排版验收";
          const offset = text?.text.indexOf(chinese) ?? -1;
          assert.ok(offset >= 0 && text?.glyphs?.some(([start, , left, , right]) => start === offset && right > left));
          assert.deepEqual((await office.search(folder, path, chinese, options))?.matches, [[1, offset, offset + chinese.length]]);
        }
        if (extension === "pptx") {
          const phrase = "中文图表";
          const slide = await office.text(folder, path, 2);
          const start = slide?.text.indexOf(phrase) ?? -1;
          assert.ok(start >= 0 && slide?.glyphs?.some(([offset]) => offset === start));
          assert.deepEqual((await office.search(folder, path, phrase, options))?.matches, [[2, start, start + phrase.length]]);
        }
        if (pages > 1) {
          const last = await office.page(folder, path, pages, 640);
          assert.equal(last?.page, pages);
          assert.notEqual(last?.uri, first.uri);
        }
      });
    }
  } finally {
    office.stop();
    engine.stop();
    await rm(folder, { recursive: true, force: true });
  }
});
