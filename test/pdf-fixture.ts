export function makeLargePdf() {
  const stream = [
    "0.2 0.4 0.6 rg 0 660 350 80 re f",
    "1 0.2 0.1 rg 480 660 110 80 re f",
    "% Start of deliberate uncompressed padding",
    ...Array.from({ length: 1100 }, () => "%" + "x".repeat(1000)),
  ].join("\n");
  const other = "0 0.8 0.4 rg 40 40 520 720 re f\n0 0 0 rg\nBT /F1 16 Tf 50 730 Td (Tidal observatory marker) Tj ET\n" +
    "BT /F2 16 Tf 50 700 Td <6F6E6C50> Tj ET";
  const chinese = [
    "/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /ObservatoryUnicode def", "/CMapType 2 def",
    "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange",
    "2 beginbfchar", "<6F6E> <6F6E>", "<6C50> <6C50>", "endbfchar",
    "endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 7 0 R /F2 8 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    `<< /Length ${other.length} >>\nstream\n${other}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [9 0 R] /ToUnicode 10 0 R >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /DW 1000 /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>",
    `<< /Length ${chinese.length} >>\nstream\n${chinese}\nendstream`,
  ];
  let source = "%PDF-1.4\n";
  const entries = ["0000000000 65535 f "];
  for (const [index, object] of objects.entries()) {
    entries.push(`${String(source.length).padStart(10, "0")} 00000 n `);
    source += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = source.length;
  source += `xref\n0 ${entries.length}\n${entries.join("\n")}\n`;
  return Buffer.from(source + `trailer\n<< /Size ${entries.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
