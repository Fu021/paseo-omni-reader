import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createEngine } from "../../server/engine";
import { createOfficePreview } from "../../server/office-preview";

const execute = promisify(execFile);
const presentation = `<?xml version="1.0" encoding="UTF-8"?>
<office:document
  xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
  xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"
  xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
  xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"
  office:mimetype="application/vnd.oasis.opendocument.presentation" office:version="1.2">
  <office:body><office:presentation>
    ${["Omni Reader", "Second slide"].map((title) => `
      <draw:page draw:name="${title}">
        <draw:frame svg:x="2cm" svg:y="2cm" svg:width="12cm" svg:height="4cm">
          <draw:text-box><text:p>${title}</text:p></draw:text-box>
        </draw:frame>
      </draw:page>`).join("")}
  </office:presentation></office:body>
</office:document>`;

const documents = [
  { source: "report.html", content: "<html><body><h1>Omni Reader</h1><p>Document preview</p></body></html>",
    format: "docx:Office Open XML Text", extension: "docx", pages: 1 },
  { source: "report.csv", content: "Quarter,Sales\nQ1,125\nQ2,350\n",
    format: "xlsx:Calc MS Excel 2007 XML", extension: "xlsx", pages: 1 },
  { source: "report.fodp", content: presentation,
    format: "pptx:Impress MS PowerPoint 2007 XML", extension: "pptx", pages: 2 },
];

test("renders formatted Word, Excel and PowerPoint previews", { timeout: 120_000 }, async (context) => {
  const folder = await mkdtemp(join(tmpdir(), "omni-office-test-"));
  const engine = createEngine();
  const office = createOfficePreview(engine);
  try {
    const profile = `-env:UserInstallation=${pathToFileURL(join(folder, "profile")).href}`;
    for (const { source, content, format, extension, pages } of documents) {
      await context.test(extension, async () => {
        const input = join(folder, source);
        await writeFile(input, content);
        await execute(process.env.OMNI_READER_SOFFICE || "soffice", [
          profile, "--headless", "--convert-to", format, "--outdir", folder, input,
        ], { timeout: 25_000 });
        const path = join(folder, `report.${extension}`);
        if (extension === "xlsx") {
          const workbook = await engine.dispatch({ kind: "worksheet", root: folder, path, sheet: 0 });
          assert.equal(workbook.names.length, 1);
          assert.equal(workbook.sheet.truncated, false);
          assert.equal(workbook.sheet.columns.length, 2);
          assert.equal(workbook.sheet.rows.length, 3);
          assert.deepEqual(workbook.sheet.cells.map(([row, column, text, _style, numeric]) => [row, column, text, numeric]), [
            [0, 0, "Quarter", false], [0, 1, "Sales", false], [1, 0, "Q1", false],
            [1, 1, "125", true], [2, 0, "Q2", false], [2, 1, "350", true],
          ]);
          const search = (query: string, options: { matchCase?: boolean; wholeWord?: boolean; regex?: boolean } = {}) =>
            engine.dispatch({ kind: "worksheet-search", root: folder, path, sheet: 0, query,
              options: { matchCase: false, wholeWord: false, regex: false, ...options } });
          assert.deepEqual((await search("sales")).matches, [[0, 1, 0, 5]]);
          assert.deepEqual((await search("sales", { matchCase: true })).matches, []);
          assert.deepEqual((await search("ale", { wholeWord: true })).matches, []);
          assert.deepEqual((await search("Q[12]", { regex: true })).matches, [[1, 0, 0, 2], [2, 0, 0, 2]]);
          assert.equal((await search("[", { regex: true })).invalidPattern, true);
        }
        const layout = await office.layout(folder, path);
        assert.equal(layout?.reduce((count, group) => count + group.count, 0), pages);
        const first = await office.page(folder, path, 1, 640);
        assert.ok(first);
        assert.equal(first.pages, pages);
        assert.match(first.uri, /^data:image\/jpeg;base64,/);
        if (extension !== "xlsx") {
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
          if (extension === "pptx") {
            const phrase = "Second slide";
            const slide = await office.text(folder, path, 2);
            const start = slide?.text.indexOf(phrase) ?? -1;
            assert.ok(start >= 0 && slide?.glyphs?.some(([offset]) => offset === start));
            assert.deepEqual((await office.search(folder, path, phrase, options))?.matches, [[2, start, start + phrase.length]]);
          }
        } else {
          const text = await office.text(folder, path, 1);
          const start = text?.text.indexOf("Sales") ?? -1;
          assert.ok(start >= 0 && text?.glyphs?.some(([offset]) => offset === start));
          assert.deepEqual((await office.search(folder, path, "Sales", { matchCase: false, wholeWord: true, regex: false }))?.matches,
            [[1, start, start + "Sales".length]]);
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
