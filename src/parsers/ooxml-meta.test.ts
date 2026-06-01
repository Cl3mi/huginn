import { expect, test } from "bun:test";
import JSZip from "jszip";

async function makeZip(coreXml: string, appXml?: string): Promise<JSZip> {
  const zip = new JSZip();
  zip.file("docProps/core.xml", coreXml);
  if (appXml) zip.file("docProps/app.xml", appXml);
  return zip;
}

const CORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<cp:coreProperties
  xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:creator>Jane Smith</dc:creator>
  <cp:lastModifiedBy>John Doe</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">2024-03-15T09:00:00Z</dcterms:created>
</cp:coreProperties>`;

const APP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Company>Acme GmbH</Company>
  <Pages>5</Pages>
</Properties>`;

test("parses creator from core.xml", async () => {
  const { parseOoxmlMeta } = await import("./ooxml-meta.ts");
  const zip = await makeZip(CORE_XML);
  const meta = await parseOoxmlMeta(zip);
  expect(meta.creator).toBe("Jane Smith");
});

test("parses lastModifiedBy from core.xml", async () => {
  const { parseOoxmlMeta } = await import("./ooxml-meta.ts");
  const zip = await makeZip(CORE_XML);
  const meta = await parseOoxmlMeta(zip);
  expect(meta.lastModifiedBy).toBe("John Doe");
});

test("parses creationDate from core.xml", async () => {
  const { parseOoxmlMeta } = await import("./ooxml-meta.ts");
  const zip = await makeZip(CORE_XML);
  const meta = await parseOoxmlMeta(zip);
  expect(meta.creationDate).toBe("2024-03-15T09:00:00Z");
});

test("parses company and pageCountHint from app.xml", async () => {
  const { parseOoxmlMeta } = await import("./ooxml-meta.ts");
  const zip = await makeZip(CORE_XML, APP_XML);
  const meta = await parseOoxmlMeta(zip);
  expect(meta.company).toBe("Acme GmbH");
  expect(meta.pageCountHint).toBe(5);
});

test("returns empty object when docProps files are absent", async () => {
  const { parseOoxmlMeta } = await import("./ooxml-meta.ts");
  const zip = new JSZip();
  const meta = await parseOoxmlMeta(zip);
  expect(meta.creator).toBeUndefined();
  expect(meta.company).toBeUndefined();
});
