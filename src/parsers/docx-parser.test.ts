import { expect, test, beforeAll, afterAll } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";

// Minimal but mammoth-compatible DOCX structure
async function makeDocx(opts: {
  headings?: string[];
  body?: string;
  tableCount?: number;
  imageMedia?: Array<{ name: string; data: Buffer }>;
} = {}): Promise<Buffer> {
  const zip = new JSZip();

  const headingXml = (opts.headings ?? [])
    .map(h => `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${h}</w:t></w:r></w:p>`)
    .join("\n");

  const tableXml = Array.from({ length: opts.tableCount ?? 0 }, () =>
    `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`
  ).join("\n");

  const bodyXml = opts.body
    ? `<w:p><w:r><w:t>${opts.body}</w:t></w:r></w:p>`
    : "";

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`);

  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);

  // Styles mapping Heading1 → "heading 1" so mammoth recognises it
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
  </w:style>
</w:styles>`);

  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${headingXml}${bodyXml}${tableXml}</w:body>
</w:document>`);

  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:creator>Test Author</dc:creator>
  <dcterms:created>2024-01-15T10:00:00Z</dcterms:created>
</cp:coreProperties>`);

  zip.file("docProps/app.xml", `<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Company>Test GmbH</Company>
  <Pages>3</Pages>
</Properties>`);

  for (const img of (opts.imageMedia ?? [])) {
    zip.file(`word/media/${img.name}`, img.data);
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

const testDir = join(tmpdir(), `huginn-docx-test-${randomUUID()}`);
let docxPath: string;
let docxWithImagePath: string;
let docxWithNonImagePath: string;

// Tiny 1×1 white PNG
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "012e0000000c4944415408d76360f8ff0000010000" + "07f0e5300000000049454e44ae426082",
  "hex"
);

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });

  docxPath = join(testDir, "test.docx");
  await writeFile(docxPath, await makeDocx({
    headings: ["Introduction", "Scope"],
    body: "Some paragraph text here.",
    tableCount: 1,
  }));

  docxWithImagePath = join(testDir, "with-image.docx");
  await writeFile(docxWithImagePath, await makeDocx({
    imageMedia: [{ name: "image1.png", data: TINY_PNG }],
  }));

  docxWithNonImagePath = join(testDir, "with-non-image.docx");
  await writeFile(docxWithNonImagePath, await makeDocx({
    imageMedia: [{ name: "video.mp4", data: Buffer.from("fake video") }],
  }));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("extracts headings from Word heading styles", async () => {
  const { parseDocx } = await import("./docx-parser.ts");
  const result = await parseDocx(docxPath);
  expect(result.headingsFromStructure).toContain("Introduction");
  expect(result.headingsFromStructure).toContain("Scope");
});

test("counts tables", async () => {
  const { parseDocx } = await import("./docx-parser.ts");
  const result = await parseDocx(docxPath);
  expect(result.tableCount).toBe(1);
});

test("extracts body text", async () => {
  const { parseDocx } = await import("./docx-parser.ts");
  const result = await parseDocx(docxPath);
  expect(result.text).toContain("Some paragraph text here.");
});

test("reads metadata from docProps", async () => {
  const { parseDocx } = await import("./docx-parser.ts");
  const result = await parseDocx(docxPath);
  expect(result.metadata["Author"]).toBe("Test Author");
  expect(result.metadata["Company"]).toBe("Test GmbH");
  expect(result.pageCount).toBe(3);
});

test("imageCount counts only image-extension files in word/media/", async () => {
  const { parseDocx } = await import("./docx-parser.ts");
  const result = await parseDocx(docxWithImagePath);
  expect(result.imageCount).toBe(1);
});

test("non-image media files are excluded from OCR and imageCount", async () => {
  const { parseDocx } = await import("./docx-parser.ts");
  const result = await parseDocx(docxWithNonImagePath);
  expect(result.imageCount).toBe(0);
  expect(result.ocrPageCount).toBe(0);
});
