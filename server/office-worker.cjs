const { readFile } = require("node:fs/promises");
const { join } = require("node:path");

const fontName = "NotoSansSC-Regular.otf";

async function readInput(size) {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid Office input size.");
  const content = Buffer.allocUnsafe(size);
  let offset = 0;
  for await (const chunk of process.stdin) {
    if (offset + chunk.byteLength > size) throw new Error("Invalid Office input size.");
    offset += chunk.copy(content, offset);
  }
  if (offset !== size) throw new Error("Incomplete Office input.");
  return content;
}

async function renderOffice() {
  const [, , extension, size] = process.argv;
  const content = await readInput(Number(size));
  const { Office2PdfConverter } = require("../vendor/office2pdf/office2pdf.cjs");
  const converter = new Office2PdfConverter();
  const font = await readFile(join(__dirname, "generated", fontName));
  converter.registerFont(font);
  converter.setLastResortFontFamily("Noto Sans SC");
  const result = converter.convertToPdf(content, extension);
  try {
    process.stdout.write(result.pdf);
  } finally {
    result.free();
  }
}

renderOffice().catch(() => {
  process.exitCode = 1;
});
