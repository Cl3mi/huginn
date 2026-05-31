import { expect, test, beforeAll, afterAll } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "012e0000000c4944415408d76360f8ff000001000007f0e5300000000049454e44ae426082",
  "hex"
);

async function makePptx(opts: {
  slides?: Array<{ title?: string; body?: string; tableCount?: number; imageName?: string }>;
} = {}): Promise<Buffer> {
  const zip = new JSZip();
  const slides = opts.slides ?? [];

  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("\n  ")}
</Types>`);

  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);

  const slideRefs = slides.map((_, i) =>
    `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`
  ).join("\n    ");

  zip.file("ppt/presentation.xml", `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <p:sldIdLst>
    ${slideRefs}
  </p:sldIdLst>
</p:presentation>`);

  zip.file("ppt/_rels/presentation.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${slides.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join("\n  ")}
</Relationships>`);

  zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:creator>Presenter</dc:creator>
</cp:coreProperties>`);

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i]!;
    const titleXml = slide.title
      ? `<p:sp>
          <p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
          <p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>${slide.title}</a:t></a:r></a:p></p:txBody>
        </p:sp>`
      : "";

    const bodyXml = slide.body
      ? `<p:sp>
          <p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>${slide.body}</a:t></a:r></a:p></p:txBody>
        </p:sp>`
      : "";

    const tableXml = Array.from({ length: slide.tableCount ?? 0 }, () =>
      `<p:graphicFrame><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>X</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    ).join("\n");

    zip.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree>${titleXml}${bodyXml}${tableXml}</p:spTree></p:cSld>
</p:sld>`);

    const imageRel = slide.imageName
      ? `<Relationship Id="rImg1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${slide.imageName}"/>`
      : "";

    zip.file(`ppt/slides/_rels/slide${i + 1}.xml.rels`, `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${imageRel}
</Relationships>`);

    if (slide.imageName) {
      zip.file(`ppt/media/${slide.imageName}`, TINY_PNG);
    }
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

const testDir = join(tmpdir(), `huginn-pptx-test-${randomUUID()}`);
let simplePptxPath: string;
let sharedImagePptxPath: string;

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });

  simplePptxPath = join(testDir, "simple.pptx");
  await writeFile(simplePptxPath, await makePptx({
    slides: [
      { title: "Introduction", body: "First slide body text." },
      { title: "Methods", body: "Second slide body text.", tableCount: 1 },
    ],
  }));

  // Two slides reference the same image — should be OCR'd once
  sharedImagePptxPath = join(testDir, "shared-image.pptx");
  await writeFile(sharedImagePptxPath, await makePptx({
    slides: [
      { title: "Slide 1", imageName: "logo.png" },
      { title: "Slide 2", imageName: "logo.png" },
    ],
  }));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("extracts title placeholder headings", async () => {
  const { parsePptx } = await import("./pptx-parser.ts");
  const result = await parsePptx(simplePptxPath);
  expect(result.headingsFromStructure).toContain("Introduction");
  expect(result.headingsFromStructure).toContain("Methods");
});

test("extracts body text from slides", async () => {
  const { parsePptx } = await import("./pptx-parser.ts");
  const result = await parsePptx(simplePptxPath);
  expect(result.text).toContain("First slide body text.");
  expect(result.text).toContain("Second slide body text.");
});

test("counts tables across all slides", async () => {
  const { parsePptx } = await import("./pptx-parser.ts");
  const result = await parsePptx(simplePptxPath);
  expect(result.tableCount).toBe(1);
});

test("pageCount equals slide count", async () => {
  const { parsePptx } = await import("./pptx-parser.ts");
  const result = await parsePptx(simplePptxPath);
  expect(result.pageCount).toBe(2);
});

test("reads creator from docProps", async () => {
  const { parsePptx } = await import("./pptx-parser.ts");
  const result = await parsePptx(simplePptxPath);
  expect(result.metadata["Author"]).toBe("Presenter");
});

test("deduplicates shared images — imageCount is 1 not 2", async () => {
  const { parsePptx } = await import("./pptx-parser.ts");
  const result = await parsePptx(sharedImagePptxPath);
  expect(result.imageCount).toBe(1);
});
