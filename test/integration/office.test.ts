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
        const layout = await office.layout(folder, path);
        assert.equal(layout?.reduce((count, group) => count + group.count, 0), pages);
        const first = await office.page(folder, path, 1, 640);
        assert.ok(first);
        assert.equal(first.pages, pages);
        assert.match(first.uri, /^data:image\/jpeg;base64,/);
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
