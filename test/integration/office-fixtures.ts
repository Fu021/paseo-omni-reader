import { strToU8, zipSync } from "fflate";

const office = "http://schemas.openxmlformats.org";
const relation = `${office}/officeDocument/2006/relationships`;
const drawing = `${office}/drawingml/2006`;

function relationships(entries: [string, string, string][]) {
  return `<Relationships xmlns="${office}/package/2006/relationships">${
    entries.map(([id, kind, target]) => `<Relationship Id="${id}" Type="${relation}/${kind}" Target="${target}"/>`).join("")
  }</Relationships>`;
}

function packageFile(root: string, parts: Record<string, string>, types: Record<string, string>) {
  const overrides = Object.entries(types).map(([path, type]) =>
    `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join("");
  return zipSync(Object.fromEntries(Object.entries({
    ...parts,
    "_rels/.rels": relationships([["rId1", "officeDocument", root]]),
    "[Content_Types].xml": `<Types xmlns="${office}/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      ${overrides}</Types>`,
  }).map(([path, content]) => [path, strToU8(content)])));
}

const word = "word/document.xml";
const docx = () => packageFile(word, {
  [word]: `<w:document xmlns:w="${office}/wordprocessingml/2006/main"><w:body>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Omni Reader</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:rFonts w:eastAsia="Noto Sans SC"/></w:rPr><w:t>中文排版验收</w:t></w:r></w:p>
    <w:p><w:r><w:br w:type="page"/><w:t>Second page</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
  </w:body></w:document>`,
}, { [word]: "wordprocessingml.document.main" });

const sheet = "xl/worksheets/sheet1.xml";
const workbook = "xl/workbook.xml";
const xlsx = () => packageFile(workbook, {
  [workbook]: `<workbook xmlns="${office}/spreadsheetml/2006/main" xmlns:r="${relation}">
    <sheets><sheet name="季度 Report" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": relationships([["rId1", "worksheet", "worksheets/sheet1.xml"]]),
  "xl/styles.xml": `<styleSheet xmlns="${office}/spreadsheetml/2006/main">
    <fonts><font><sz val="11"/></font><font><b/><color rgb="FF184B68"/><sz val="12"/></font></fonts>
    <fills><fill/><fill><patternFill patternType="solid"><fgColor rgb="FFE7F3F8"/></patternFill></fill></fills>
    <cellXfs><xf fontId="0" fillId="0" numFmtId="0"/><xf fontId="1" fillId="1" numFmtId="4">
      <alignment horizontal="center" wrapText="1"/></xf></cellXfs></styleSheet>`,
  "xl/sharedStrings.xml": `<sst xmlns="${office}/spreadsheetml/2006/main"><si><r><t>季度</t></r>
    <r><t xml:space="preserve"> Quarter</t></r></si></sst>`,
  [sheet]: `<worksheet xmlns="${office}/spreadsheetml/2006/main"><dimension ref="A1:C4"/>
  <cols><col min="3" max="3" width="20" hidden="1"/></cols><sheetData>${
    [["季度 Quarter", "Sales"], ["Q1", 125], ["Q2", 350]].map((row, index) => `<row r="${index + 1}">${
      row.map((cell, column) => {
        const address = `${column === 0 ? "A" : "B"}${index + 1}`;
        if (address === "A1") return `<c r="A1" t="s" s="1"><v>0</v></c>`;
        if (address === "B3") return `<c r="B3" s="1"><v>1234.5</v></c>`;
        return typeof cell === "number" ? `<c r="${address}"><v>${cell}</v></c>`
          : `<c r="${address}" t="inlineStr"><is><t>${cell}</t></is></c>`;
      }).join("")
    }</row>`).join("")
  }<row r="4" hidden="1"><c r="A4" t="inlineStr"><is><t>隐藏 Hidden</t></is></c></row></sheetData>
  <mergeCells><mergeCell ref="B1:C1"/></mergeCells></worksheet>`,
}, { [workbook]: "spreadsheetml.sheet.main", [sheet]: "spreadsheetml.worksheet" });

const presentation = "ppt/presentation.xml";
const slideCount = 12;
const slidePath = (index: number) => `ppt/slides/slide${index}.xml`;
const pptx = () => {
  const parts: Record<string, string> = {};
  const types: Record<string, string> = {};
  const slides: [string, string, string][] = [];
  for (let index = 1; index <= slideCount; index++) {
    const title = index === 1 ? "Omni Reader" : index === 2 ? "Second slide 中文图表" : `Slide ${index}`;
    const path = slidePath(index);
    slides.push([`rId${index}`, "slide", `slides/slide${index}.xml`]);
    parts[path] = `<p:sld xmlns:p="${office}/presentationml/2006/main" xmlns:a="${drawing}/main"><p:cSld><p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/>
      <a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
      <p:spPr><a:xfrm><a:off x="700000" y="600000"/><a:ext cx="6500000" cy="900000"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
      <p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr sz="2600"/><a:t>${title}</a:t></a:r></a:p></p:txBody>
      </p:sp></p:spTree></p:cSld></p:sld>`;
    types[path] = "presentationml.slide";
  }
  parts[presentation] = `<p:presentation xmlns:p="${office}/presentationml/2006/main" xmlns:r="${relation}">
    <p:sldIdLst>${slides.map(([id], index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`).join("")}</p:sldIdLst>
    <p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  parts["ppt/_rels/presentation.xml.rels"] = relationships(slides);
  types[presentation] = "presentationml.presentation.main";
  return packageFile(presentation, parts, types);
};

export const officeFixtures = [
  { make: docx, extension: "docx", pages: 2 },
  { make: xlsx, extension: "xlsx" },
  { make: pptx, extension: "pptx", pages: slideCount },
] as const;
