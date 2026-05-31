# Tika Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Apache Tika Docker container and `officeparser` npm package with native per-format parsers (`pdfjs-dist`, `mammoth`, `xlsx`/SheetJS, `jszip`) plus tesseract OCR for embedded images across all formats.

**Architecture:** Six new files in `src/parsers/` — one shared interface, one OCR helper, one OOXML metadata helper, and four format-specific parsers. `2-parse.ts` dispatches to the correct parser by extension. The `TikaResult` / `OfficeparserResult` types and the three old parser files are deleted; all consumers use the new `NativeParseResult` interface.

**Tech Stack:** `pdfjs-dist` (PDF text + heading signals + image detection), `canvas` (PDF page rendering for OCR), `mammoth` (DOCX HTML mode), `xlsx`/SheetJS (XLSX cell text), `jszip` (Office zip traversal + PPTX XML), tesseract system binary (OCR via child process), Bun test framework.

**Spec:** `docs/superpowers/specs/2026-05-31-tika-replacement-design.md`

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| Create | `src/parsers/native-result.ts` | Shared `NativeParseResult` interface |
| Create | `src/parsers/ocr.ts` | tesseract child-process wrapper |
| Create | `src/parsers/ooxml-meta.ts` | OPC `docProps/` reader shared by DOCX/XLSX/PPTX |
| Create | `src/parsers/pdf-parser.ts` | pdfjs-dist text + multi-signal headings + scanned OCR |
| Create | `src/parsers/docx-parser.ts` | mammoth HTML + JSZip image OCR |
| Create | `src/parsers/xlsx-parser.ts` | SheetJS cell text + JSZip image OCR |
| Create | `src/parsers/pptx-parser.ts` | JSZip XML slide text + title headings + image OCR |
| Create | `src/parsers/ocr.test.ts` | Unit tests for OCR module |
| Create | `src/parsers/ooxml-meta.test.ts` | Unit tests for OOXML metadata parser |
| Create | `src/parsers/pdf-parser.test.ts` | Unit tests for PDF parser (mocked pdfjs) |
| Create | `src/parsers/docx-parser.test.ts` | Unit tests for DOCX parser (JSZip fixture) |
| Create | `src/parsers/xlsx-parser.test.ts` | Unit tests for XLSX parser (SheetJS fixture) |
| Create | `src/parsers/pptx-parser.test.ts` | Unit tests for PPTX parser (JSZip fixture) |
| Delete | `src/parsers/tika.ts` | Replaced by pdf-parser.ts |
| Delete | `src/parsers/officeparser.ts` | Replaced by docx/xlsx/pptx-parser.ts |
| Delete | `src/parsers/parser-compare.ts` | No longer needed (single parser per format) |
| Modify | `src/state.ts` | Update `parserUsed` type, remove `ParserComparison`, rename `tika_error` |
| Modify | `src/phases/2-parse.ts` | Rewire dispatch logic, remove tika/officeparser calls |
| Modify | `src/config.ts` | Remove `tikaUrl`, `parserDivergenceThreshold` |
| Modify | `src/server/index.ts` | Remove Tika health check + polling |
| Modify | `src/server/health-state.ts` | Remove `tikaOk` field |
| Modify | `src/server/routes.ts` | Remove `tikaOk` from health response |
| Modify | `docker-compose.yml` | Remove `tika` service and its dependencies |
| Modify | `package.json` | Add new deps, remove `officeparser` |

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install new packages**

```bash
bun add pdfjs-dist mammoth xlsx jszip canvas
bun remove officeparser
```

Expected: `package.json` updated, `bun.lock` regenerated, no errors.

- [ ] **Step 2: Verify typecheck still passes on existing code**

```bash
bun run typecheck
```

Expected: exits 0 (no new type errors from dependency additions).

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lockb
git commit -m "chore: add pdfjs-dist mammoth xlsx jszip canvas; remove officeparser"
```

---

## Task 2: Define shared interface

**Files:**
- Create: `src/parsers/native-result.ts`

No test needed — pure types.

- [ ] **Step 1: Create the file**

```typescript
// src/parsers/native-result.ts
export interface NativeParseResult {
  text: string;                      // native text + OCR text merged
  charCount: number;
  pageCount?: number;                // pages (PDF), slides (PPTX), sheets (XLSX — not printed pages)
  metadata: Record<string, string>;  // Author, Creation-Date, Title, Company
  headingsFromStructure: string[];   // <h1>-<h6> (DOCX), scored signals (PDF), title placeholders (PPTX)
  tableCount: number;                // <table> (DOCX), <a:tbl> (PPTX), 0 for PDF/XLSX
  imageCount: number;
  scannedPageRatio: number;          // PDF only; 0 for all others
  scannedPageIndices: number[];      // PDF only; [] for all others
  ocrPageCount: number;              // images/pages that had tesseract run
}
```

- [ ] **Step 2: Commit**

```bash
git add src/parsers/native-result.ts
git commit -m "feat(parsers): add NativeParseResult shared interface"
```

---

## Task 3: OCR helper (TDD)

**Files:**
- Create: `src/parsers/ocr.ts`
- Create: `src/parsers/ocr.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/parsers/ocr.test.ts
import { expect, test, beforeAll, afterAll } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// A tiny valid 1×1 white PNG (67 bytes) — just needs to be a readable image file
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
  "2e0000000c4944415408d76360f8ff000001000007f0e5300000000049454e44ae426082",
  "hex"
);

const testDir = join(tmpdir(), `huginn-ocr-test-${randomUUID()}`);
const testImage = join(testDir, "test.png");

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });
  await writeFile(testImage, TINY_PNG);
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("returns empty string when binary path does not exist", async () => {
  const { runTesseract } = await import("./ocr.ts");
  const result = await runTesseract(testImage, "/nonexistent/tesseract-binary-xyz");
  expect(result).toBe("");
});

test("returns empty string on spawn failure (bad binary)", async () => {
  const { runTesseract } = await import("./ocr.ts");
  const result = await runTesseract("/nonexistent/image.png", "/nonexistent/tesseract-xyz");
  expect(result).toBe("");
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
bun test src/parsers/ocr.test.ts
```

Expected: FAIL with "Cannot find module './ocr.ts'"

- [ ] **Step 3: Implement `ocr.ts`**

```typescript
// src/parsers/ocr.ts
import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger.ts";

const execFileAsync = promisify(execFile);
let _warnedMissing = false;

// binaryPath is injectable for tests; defaults to system tesseract
export async function runTesseract(
  imagePath: string,
  binaryPath = "tesseract"
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      binaryPath,
      [imagePath, "stdout", "-l", "deu+eng"],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout.trim();
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("No such file")) {
      if (!_warnedMissing) {
        logger.warn("tesseract not found — OCR disabled for this run");
        _warnedMissing = true;
      }
      return "";
    }
    logger.warn("tesseract failed", { imagePath, error: msg.slice(0, 200) });
    return "";
  }
}

// Reset the one-time warning flag (used in tests)
export function _resetWarnFlag(): void {
  _warnedMissing = false;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/parsers/ocr.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/ocr.ts src/parsers/ocr.test.ts
git commit -m "feat(parsers): add tesseract OCR helper with graceful-miss handling"
```

---

## Task 4: OOXML metadata helper (TDD)

**Files:**
- Create: `src/parsers/ooxml-meta.ts`
- Create: `src/parsers/ooxml-meta.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/parsers/ooxml-meta.test.ts
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/parsers/ooxml-meta.test.ts
```

Expected: FAIL with "Cannot find module './ooxml-meta.ts'"

- [ ] **Step 3: Implement `ooxml-meta.ts`**

```typescript
// src/parsers/ooxml-meta.ts
import type JSZip from "jszip";

export interface OoxmlMeta {
  creator?: string;
  lastModifiedBy?: string;
  company?: string;
  creationDate?: string;
  pageCountHint?: number;
}

export async function parseOoxmlMeta(zip: JSZip): Promise<OoxmlMeta> {
  const meta: OoxmlMeta = {};

  const coreFile = zip.file("docProps/core.xml");
  if (coreFile) {
    const xml = await coreFile.async("string");
    const creator  = xml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)?.[1]?.trim();
    const lastBy   = xml.match(/<cp:lastModifiedBy[^>]*>([^<]+)<\/cp:lastModifiedBy>/)?.[1]?.trim();
    const created  = xml.match(/<dcterms:created[^>]*>([^<]+)<\/dcterms:created>/)?.[1]?.trim();
    if (creator) meta.creator = creator;
    if (lastBy)  meta.lastModifiedBy = lastBy;
    if (created) meta.creationDate = created;
  }

  const appFile = zip.file("docProps/app.xml");
  if (appFile) {
    const xml = await appFile.async("string");
    const company = xml.match(/<Company>([^<]+)<\/Company>/)?.[1]?.trim();
    const pages   = xml.match(/<Pages>(\d+)<\/Pages>/)?.[1];
    if (company) meta.company = company;
    if (pages)   meta.pageCountHint = parseInt(pages, 10);
  }

  return meta;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/parsers/ooxml-meta.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/ooxml-meta.ts src/parsers/ooxml-meta.test.ts
git commit -m "feat(parsers): add OOXML docProps metadata reader"
```

---

## Task 5: PDF parser (TDD)

**Files:**
- Create: `src/parsers/pdf-parser.ts`
- Create: `src/parsers/pdf-parser.test.ts`

- [ ] **Step 1: Write failing tests**

The heading extraction function is exported for direct unit testing without needing real PDF files.

```typescript
// src/parsers/pdf-parser.test.ts
import { expect, test, describe } from "bun:test";

// TextItem shape as returned by pdfjs-dist getTextContent()
interface TextItem {
  str: string;
  transform: number[]; // [a, b, c, fontSize, x, y]
  fontName: string;
}

function item(str: string, fontSize: number, fontName: string, y: number, prevY = y + 60): TextItem {
  return { str, transform: [1, 0, 0, fontSize, 100, y], fontName };
}

describe("extractHeadings", () => {
  test("scores numbered heading ≥ 4 — included", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    // "1. Introduction" at 18pt (> 1.3×12 body) + numbered = 3+3 = 6
    const items: TextItem[] = [
      item("Body text here normal.", 12, "Arial", 700),
      item("Body text here normal.", 12, "Arial", 685),
      item("Body text here normal.", 12, "Arial", 670),
      item("1. Introduction", 18, "ArialBold", 600),
    ];
    const headings = extractHeadings(items);
    expect(headings).toContain("1. Introduction");
  });

  test("scores plain body text < 4 — excluded", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    const items: TextItem[] = [
      item("Body text here normal.", 12, "Arial", 700),
      item("More body text here.", 12, "Arial", 685),
      item("Yet more text here.", 12, "Arial", 670),
    ];
    const headings = extractHeadings(items);
    expect(headings).toHaveLength(0);
  });

  test("all-caps short line scores 1 pt — needs another signal to reach 4", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    // "SCOPE" all-caps (1pt) + large font 18pt (3pt) = 4 → included
    const items: TextItem[] = [
      item("body text normal size here.", 12, "Arial", 700),
      item("body text normal size here.", 12, "Arial", 685),
      item("body text normal size here.", 12, "Arial", 670),
      item("SCOPE", 18, "Arial", 600),
    ];
    const headings = extractHeadings(items);
    expect(headings).toContain("SCOPE");
  });

  test("item with str shorter than 3 chars is skipped", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    const items: TextItem[] = [
      item("body text normal size here.", 12, "Arial", 700),
      item("body text normal size here.", 12, "Arial", 685),
      item("1.", 18, "ArialBold", 600), // too short even with score 6
    ];
    const headings = extractHeadings(items);
    expect(headings).toHaveLength(0);
  });

  test("returns empty array for empty input", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    expect(extractHeadings([])).toEqual([]);
  });
});

describe("scanned page threshold", () => {
  test("page with ≥ 100 chars is not scanned", async () => {
    const { isScannedPage } = await import("./pdf-parser.ts");
    expect(isScannedPage("x".repeat(100))).toBe(false);
  });

  test("page with < 100 chars is scanned", async () => {
    const { isScannedPage } = await import("./pdf-parser.ts");
    expect(isScannedPage("x".repeat(99))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/parsers/pdf-parser.test.ts
```

Expected: FAIL with "Cannot find module './pdf-parser.ts'"

- [ ] **Step 3: Implement `pdf-parser.ts`**

```typescript
// src/parsers/pdf-parser.ts
import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { runTesseract } from "./ocr.ts";
import { logger } from "../utils/logger.ts";
import type { NativeParseResult } from "./native-result.ts";

interface TextItem {
  str: string;
  transform: number[]; // index 3 = fontSize, index 4 = x, index 5 = y
  fontName: string;
}

// Exported for unit testing
export function isScannedPage(pageText: string): boolean {
  return pageText.trim().length < 100;
}

// Exported for unit testing
export function extractHeadings(items: TextItem[]): string[] {
  if (items.length === 0) return [];

  const sizes = items
    .map(it => Math.abs(it.transform[3] ?? 0))
    .filter(s => s > 0)
    .sort((a, b) => a - b);

  if (sizes.length === 0) return [];
  const median = sizes[Math.floor(sizes.length / 2)]!;

  const headings: string[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const str = item.str.trim();
    if (!str || str.length < 3 || str.length > 200) continue;

    const fontSize = Math.abs(item.transform[3] ?? 0);
    const fontName = item.fontName ?? "";
    const y = item.transform[5] ?? 0;
    const prevY = i > 0 ? (items[i - 1]!.transform[5] ?? 0) : y;
    const yDelta = Math.abs(y - prevY);

    let score = 0;

    // Signal 1: Numbered pattern (3 pts)
    if (/^(\d+(?:\.\d+)*\.?\s|Appendix\s+[A-Z])/i.test(str)) score += 3;

    // Signal 2: Font size > 1.3× median body (3 pts)
    if (median > 0 && fontSize > median * 1.3) score += 3;

    // Signal 3: Bold/Heavy/Black in font name (2 pts)
    if (/bold|heavy|black/i.test(fontName)) score += 2;

    // Signal 4: Short line + vertical gap > 20pt (2 pts)
    if (str.length <= 80 && yDelta > 20) score += 2;

    // Signal 5: All-caps, 3–40 chars (1 pt)
    if (str === str.toUpperCase() && str.length >= 3 && str.length <= 40 && /[A-Z]/.test(str)) score += 1;

    // Signal 6: Vertical gap > 50pt (1 pt)
    if (yDelta > 50) score += 1;

    if (score >= 4) headings.push(str);
  }

  return headings;
}

async function renderPageAndOcr(page: unknown): Promise<string> {
  const { createCanvas } = await import("canvas");
  const p = page as {
    getViewport: (o: { scale: number }) => { width: number; height: number };
    render: (o: { canvasContext: unknown; viewport: unknown }) => { promise: Promise<void> };
  };
  const viewport = p.getViewport({ scale: 2.0 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");

  await p.render({ canvasContext: ctx, viewport }).promise;

  const tmpPath = join(tmpdir(), `huginn-pdf-${randomUUID()}.png`);
  await writeFile(tmpPath, canvas.toBuffer("image/png"));
  try {
    return await runTesseract(tmpPath);
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

export async function parsePdf(absolutePath: string): Promise<NativeParseResult> {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "";

  const buffer = await readFile(absolutePath);
  const data = new Uint8Array(buffer);

  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    verbosity: 0,
    useSystemFonts: true,
  }).promise;

  const numPages = doc.numPages;

  // Metadata
  const metadata: Record<string, string> = {};
  try {
    const { info } = await doc.getMetadata() as { info: Record<string, unknown> };
    if (info["Author"])       metadata["Author"]       = String(info["Author"]);
    if (info["Title"])        metadata["Title"]         = String(info["Title"]);
    if (info["CreationDate"]) metadata["Creation-Date"] = String(info["CreationDate"]);
    if (info["Creator"])      metadata["Creator"]       = String(info["Creator"]);
  } catch { /* metadata is optional */ }

  const allTextItems: TextItem[] = [];
  const pageTexts: string[] = [];
  const scannedIndices: number[] = [];
  let imageCount = 0;
  let ocrPageCount = 0;

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await doc.getPage(pageNum);

    const textContent = await page.getTextContent();
    const items = (textContent.items as TextItem[]);
    const pageText = items.map(it => it.str).join(" ").replace(/\s+/g, " ").trim();

    // Count images from operator list
    const opList = await page.getOperatorList();
    const OPS = pdfjsLib.OPS;
    for (const op of opList.fnArray) {
      if (op === OPS.paintImageXObject || op === OPS.paintInlineImageXObject) imageCount++;
    }

    if (isScannedPage(pageText)) {
      scannedIndices.push(pageNum);
      let ocrText = "";
      try {
        ocrText = await renderPageAndOcr(page);
        ocrPageCount++;
      } catch (e) {
        logger.warn("PDF page render/OCR failed", { page: pageNum, error: String(e) });
      }
      pageTexts.push(ocrText || pageText);
    } else {
      pageTexts.push(pageText);
      // Only collect text items from non-scanned pages for heading analysis
      for (const it of items) {
        if (it.str.trim()) allTextItems.push(it);
      }
    }
  }

  const text = pageTexts.join("\n\n");
  const scannedPageRatio = numPages > 0 ? scannedIndices.length / numPages : 0;

  return {
    text,
    charCount: text.length,
    pageCount: numPages,
    metadata,
    headingsFromStructure: extractHeadings(allTextItems),
    tableCount: 0,
    imageCount,
    scannedPageRatio,
    scannedPageIndices: scannedIndices,
    ocrPageCount,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/parsers/pdf-parser.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/pdf-parser.ts src/parsers/pdf-parser.test.ts
git commit -m "feat(parsers): add pdfjs-dist PDF parser with multi-signal heading detection and scanned-page OCR"
```

---

## Task 6: DOCX parser (TDD)

**Files:**
- Create: `src/parsers/docx-parser.ts`
- Create: `src/parsers/docx-parser.test.ts`

- [ ] **Step 1: Write failing tests**

The test creates a minimal valid DOCX in-memory using JSZip so no binary fixture file is needed.

```typescript
// src/parsers/docx-parser.test.ts
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/parsers/docx-parser.test.ts
```

Expected: FAIL with "Cannot find module './docx-parser.ts'"

- [ ] **Step 3: Implement `docx-parser.ts`**

```typescript
// src/parsers/docx-parser.ts
import { readFile, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import mammoth from "mammoth";
import JSZip from "jszip";
import { runTesseract } from "./ocr.ts";
import { parseOoxmlMeta } from "./ooxml-meta.ts";
import { logger } from "../utils/logger.ts";
import type { NativeParseResult } from "./native-result.ts";

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|tiff|bmp|gif)$/i;

function headingsFromHtml(html: string): string[] {
  const headings: string[] = [];
  const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = (m[2] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text.length >= 3) headings.push(text);
  }
  return headings;
}

function countTablesInHtml(html: string): number {
  return (html.match(/<table[\s>]/gi) ?? []).length;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function parseDocx(absolutePath: string): Promise<NativeParseResult> {
  const buffer = await readFile(absolutePath);

  const { value: html } = await mammoth.convertToHtml({ buffer });

  const headingsFromStructure = headingsFromHtml(html);
  const tableCount = countTablesInHtml(html);
  const nativeText = stripHtml(html);

  const zip = await JSZip.loadAsync(buffer);
  const meta = await parseOoxmlMeta(zip);

  const metadata: Record<string, string> = {};
  if (meta.creator)       metadata["Author"]           = meta.creator;
  if (meta.lastModifiedBy) metadata["Last-Modified-By"] = meta.lastModifiedBy;
  if (meta.company)       metadata["Company"]           = meta.company;
  if (meta.creationDate)  metadata["Creation-Date"]     = meta.creationDate;

  const imageEntries = Object.keys(zip.files).filter(f =>
    f.startsWith("word/media/") && IMAGE_EXTENSIONS.test(f)
  );

  const ocrParts: string[] = [];
  let ocrPageCount = 0;

  for (const entry of imageEntries) {
    const imgBuffer = await zip.files[entry]!.async("nodebuffer");
    const ext = entry.slice(entry.lastIndexOf("."));
    const tmpPath = join(tmpdir(), `huginn-docx-ocr-${randomUUID()}${ext}`);
    await writeFile(tmpPath, imgBuffer);
    try {
      const ocrText = await runTesseract(tmpPath);
      if (ocrText.length > 20) {
        ocrParts.push(ocrText);
        ocrPageCount++;
      }
    } catch (e) {
      logger.warn("DOCX image OCR failed", { entry, error: String(e) });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  const text = [nativeText, ...ocrParts].filter(Boolean).join("\n\n");

  return {
    text,
    charCount: text.length,
    ...(meta.pageCountHint !== undefined ? { pageCount: meta.pageCountHint } : {}),
    metadata,
    headingsFromStructure,
    tableCount,
    imageCount: imageEntries.length,
    scannedPageRatio: 0,
    scannedPageIndices: [],
    ocrPageCount,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/parsers/docx-parser.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/docx-parser.ts src/parsers/docx-parser.test.ts
git commit -m "feat(parsers): add mammoth DOCX parser with HTML heading extraction and image OCR"
```

---

## Task 7: XLSX parser (TDD)

**Files:**
- Create: `src/parsers/xlsx-parser.ts`
- Create: `src/parsers/xlsx-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/parsers/xlsx-parser.test.ts
import { expect, test, beforeAll, afterAll } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import * as XLSX from "xlsx";

const testDir = join(tmpdir(), `huginn-xlsx-test-${randomUUID()}`);
let xlsxPath: string;
let xlsxWithImagePath: string;

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "012e0000000c4944415408d76360f8ff000001000007f0e5300000000049454e44ae426082",
  "hex"
);

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });

  // Create a real XLSX using SheetJS
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([["Name", "Value"], ["Alpha", 1], ["Beta", 2]]);
  const ws2 = XLSX.utils.aoa_to_sheet([["Col A", "Col B"], ["X", "Y"]]);
  XLSX.utils.book_append_sheet(wb, ws1, "Sheet1");
  XLSX.utils.book_append_sheet(wb, ws2, "Sheet2");
  xlsxPath = join(testDir, "test.xlsx");
  await writeFile(xlsxPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  // XLSX with image in xl/media/ — inject via JSZip after generation
  const JSZip = (await import("jszip")).default;
  const baseBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const zip = await JSZip.loadAsync(baseBuffer);
  zip.file("xl/media/image1.png", TINY_PNG);
  xlsxWithImagePath = join(testDir, "with-image.xlsx");
  await writeFile(xlsxWithImagePath, await zip.generateAsync({ type: "nodebuffer" }));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("extracts text from all sheets", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.text).toContain("Alpha");
  expect(result.text).toContain("Col A");
});

test("pageCount equals sheet count", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.pageCount).toBe(2);
});

test("headingsFromStructure is empty (XLSX has no heading semantics)", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.headingsFromStructure).toEqual([]);
});

test("imageCount counts image files in xl/media/", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxWithImagePath);
  expect(result.imageCount).toBe(1);
});

test("scannedPageRatio is 0 for XLSX", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.scannedPageRatio).toBe(0);
  expect(result.scannedPageIndices).toEqual([]);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/parsers/xlsx-parser.test.ts
```

Expected: FAIL with "Cannot find module './xlsx-parser.ts'"

- [ ] **Step 3: Implement `xlsx-parser.ts`**

```typescript
// src/parsers/xlsx-parser.ts
import { readFile, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import * as XLSX from "xlsx";
import JSZip from "jszip";
import { runTesseract } from "./ocr.ts";
import { parseOoxmlMeta } from "./ooxml-meta.ts";
import { logger } from "../utils/logger.ts";
import type { NativeParseResult } from "./native-result.ts";

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|tiff|bmp|gif)$/i;

export async function parseXlsx(absolutePath: string): Promise<NativeParseResult> {
  const buffer = await readFile(absolutePath);

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetTexts: string[] = [];
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]!;
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) sheetTexts.push(csv);
  }
  const sheetCount = workbook.SheetNames.length;

  const zip = await JSZip.loadAsync(buffer);
  const meta = await parseOoxmlMeta(zip);

  const metadata: Record<string, string> = {};
  if (meta.creator)      metadata["Author"]       = meta.creator;
  if (meta.company)      metadata["Company"]       = meta.company;
  if (meta.creationDate) metadata["Creation-Date"] = meta.creationDate;

  const imageEntries = Object.keys(zip.files).filter(f =>
    f.startsWith("xl/media/") && IMAGE_EXTENSIONS.test(f)
  );

  const ocrParts: string[] = [];
  let ocrPageCount = 0;

  for (const entry of imageEntries) {
    const imgBuffer = await zip.files[entry]!.async("nodebuffer");
    const ext = entry.slice(entry.lastIndexOf("."));
    const tmpPath = join(tmpdir(), `huginn-xlsx-ocr-${randomUUID()}${ext}`);
    await writeFile(tmpPath, imgBuffer);
    try {
      const ocrText = await runTesseract(tmpPath);
      if (ocrText.length > 20) {
        ocrParts.push(ocrText);
        ocrPageCount++;
      }
    } catch (e) {
      logger.warn("XLSX image OCR failed", { entry, error: String(e) });
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  }

  const nativeText = sheetTexts.join("\n\n");
  const text = [nativeText, ...ocrParts].filter(Boolean).join("\n\n");

  return {
    text,
    charCount: text.length,
    pageCount: sheetCount, // sheet count, not printed pages
    metadata,
    headingsFromStructure: [],
    tableCount: 0,
    imageCount: imageEntries.length,
    scannedPageRatio: 0,
    scannedPageIndices: [],
    ocrPageCount,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/parsers/xlsx-parser.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/xlsx-parser.ts src/parsers/xlsx-parser.test.ts
git commit -m "feat(parsers): add SheetJS XLSX parser with image OCR"
```

---

## Task 8: PPTX parser (TDD)

**Files:**
- Create: `src/parsers/pptx-parser.ts`
- Create: `src/parsers/pptx-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/parsers/pptx-parser.test.ts
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/parsers/pptx-parser.test.ts
```

Expected: FAIL with "Cannot find module './pptx-parser.ts'"

- [ ] **Step 3: Implement `pptx-parser.ts`**

```typescript
// src/parsers/pptx-parser.ts
import { readFile, writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import JSZip from "jszip";
import { runTesseract } from "./ocr.ts";
import { parseOoxmlMeta } from "./ooxml-meta.ts";
import { logger } from "../utils/logger.ts";
import type { NativeParseResult } from "./native-result.ts";

const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|tiff|bmp|gif)$/i;

function extractAllText(xml: string): string {
  return (xml.match(/<a:t[^>]*>([^<]*)<\/a:t>/g) ?? [])
    .map(tag => tag.replace(/<[^>]+>/g, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTitleText(xml: string): string | null {
  const spRe = /<p:sp[\s\S]*?<\/p:sp>/g;
  let m: RegExpExecArray | null;
  while ((m = spRe.exec(xml)) !== null) {
    const sp = m[0]!;
    if (!/<p:ph[^>]+type="(title|ctrTitle)"/.test(sp)) continue;
    const text = extractAllText(sp);
    if (text.length >= 3) return text;
  }
  return null;
}

function countTables(xml: string): number {
  return (xml.match(/<a:tbl[\s>]/g) ?? []).length;
}

function getSlideIndices(presXml: string): number[] {
  const re = /ppt\/slides\/slide(\d+)\.xml/g;
  const indices: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(presXml)) !== null) {
    indices.push(parseInt(m[1]!, 10));
  }
  return indices;
}

async function getSlideMediaPaths(zip: JSZip, slideIndex: number): Promise<string[]> {
  const relsFile = zip.file(`ppt/slides/_rels/slide${slideIndex}.xml.rels`);
  if (!relsFile) return [];
  const relsXml = await relsFile.async("string");
  const re = /Target="\.\.\/media\/([^"]+)"/g;
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(relsXml)) !== null) {
    const mediaPath = `ppt/media/${m[1]}`;
    if (IMAGE_EXTENSIONS.test(mediaPath)) paths.push(mediaPath);
  }
  return paths;
}

export async function parsePptx(absolutePath: string): Promise<NativeParseResult> {
  const buffer = await readFile(absolutePath);
  const zip = await JSZip.loadAsync(buffer);

  const presFile = zip.file("ppt/presentation.xml");
  const presXml = presFile ? await presFile.async("string") : "";
  let slideIndices = getSlideIndices(presXml);

  // Fallback: discover slides directly from zip entries
  if (slideIndices.length === 0) {
    slideIndices = Object.keys(zip.files)
      .filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .map(f => parseInt(f.match(/slide(\d+)\.xml/)![1]!, 10))
      .sort((a, b) => a - b);
  }

  const slideTexts: string[] = [];
  const headingsFromStructure: string[] = [];
  let tableCount = 0;
  const processedMedia = new Set<string>();
  let ocrPageCount = 0;

  for (const idx of slideIndices) {
    const slideFile = zip.file(`ppt/slides/slide${idx}.xml`);
    if (!slideFile) continue;

    const slideXml = await slideFile.async("string");
    const slideText = extractAllText(slideXml);
    const title = extractTitleText(slideXml);
    tableCount += countTables(slideXml);
    if (title) headingsFromStructure.push(title);

    const mediaPaths = await getSlideMediaPaths(zip, idx);
    const ocrParts: string[] = [slideText];

    for (const mediaPath of mediaPaths) {
      if (processedMedia.has(mediaPath)) continue;
      processedMedia.add(mediaPath);

      const mediaFile = zip.file(mediaPath);
      if (!mediaFile) continue;

      const imgBuffer = await mediaFile.async("nodebuffer");
      const ext = mediaPath.slice(mediaPath.lastIndexOf("."));
      const tmpPath = join(tmpdir(), `huginn-pptx-ocr-${randomUUID()}${ext}`);
      await writeFile(tmpPath, imgBuffer);
      try {
        const ocrText = await runTesseract(tmpPath);
        if (ocrText.length > 20) {
          ocrParts.push(ocrText);
          ocrPageCount++;
        }
      } catch (e) {
        logger.warn("PPTX image OCR failed", { mediaPath, error: String(e) });
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    }

    slideTexts.push(ocrParts.filter(Boolean).join(" "));
  }

  const meta = await parseOoxmlMeta(zip);
  const metadata: Record<string, string> = {};
  if (meta.creator)      metadata["Author"]       = meta.creator;
  if (meta.company)      metadata["Company"]       = meta.company;
  if (meta.creationDate) metadata["Creation-Date"] = meta.creationDate;

  const text = slideTexts.join("\n\n");

  return {
    text,
    charCount: text.length,
    pageCount: slideIndices.length,
    metadata,
    headingsFromStructure,
    tableCount,
    imageCount: processedMedia.size,
    scannedPageRatio: 0,
    scannedPageIndices: [],
    ocrPageCount,
  };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/parsers/pptx-parser.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/parsers/pptx-parser.ts src/parsers/pptx-parser.test.ts
git commit -m "feat(parsers): add JSZip PPTX parser with title heading extraction and deduplicated image OCR"
```

---

## Task 9: Update `state.ts` types

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Update `parserUsed` union type**

Find line:
```typescript
parserUsed: "officeparser" | "tika";
```
Replace with:
```typescript
parserUsed: "pdfjs" | "mammoth" | "sheetjs" | "pptx-native";
```

- [ ] **Step 2: Rename `tika_error` to `parse_error` in `parseFailureReason`**

Find:
```typescript
parseFailureReason?: "empty_extraction" | "tika_error" | "zero_pages" | "garbled_encoding";
```
Replace with:
```typescript
parseFailureReason?: "empty_extraction" | "parse_error" | "zero_pages" | "garbled_encoding";
```

- [ ] **Step 3: Add `parserMetadata` runtime field to `ParsedDocument`**

After the `pdfAuthorHint` runtime comment block, add:
```typescript
// Runtime cache — parser-provided metadata (author, creation date, company).
// Consumed by the origin-classifier loop in Phase 2. NEVER serialized to JSON.
parserMetadata?: Record<string, string>;
```

- [ ] **Step 4: Delete `ParserComparison` interface and its usage on `ParsedDocument`**

Delete the entire `ParserComparison` interface:
```typescript
export interface ParserComparison {
  officeParserChars: number;
  tikaChars: number;
  charDeltaPercent: number;
  headingCountDelta: number;
  divergenceLevel: "none" | "minor" | "major";
}
```

Delete the `parserComparisonResult` field from `ParsedDocument`:
```typescript
parserComparisonResult?: ParserComparison;
```

- [ ] **Step 4: Run typecheck to confirm no regressions**

```bash
bun run typecheck
```

Expected: type errors only in `src/parsers/tika.ts`, `src/parsers/officeparser.ts`, `src/parsers/parser-compare.ts`, and `src/phases/2-parse.ts` — these are addressed in the next tasks.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts
git commit -m "refactor(state): update parserUsed type, remove ParserComparison, rename tika_error"
```

---

## Task 10: Rewire `2-parse.ts`

**Files:**
- Modify: `src/phases/2-parse.ts`

This is the largest change. It replaces the entire `parseOfficeFile` and `parsePdfFile` functions and updates `mergeHeadings` and `buildDateSignals`.

- [ ] **Step 1: Replace imports at the top of the file**

Remove these lines:
```typescript
import { parseWithTika } from "../parsers/tika.ts";
import { parseWithOfficeParser } from "../parsers/officeparser.ts";
import { compareParserResults } from "../parsers/parser-compare.ts";
```

Add these lines in their place:
```typescript
import { parsePdf } from "../parsers/pdf-parser.ts";
import { parseDocx } from "../parsers/docx-parser.ts";
import { parseXlsx } from "../parsers/xlsx-parser.ts";
import { parsePptx } from "../parsers/pptx-parser.ts";
import type { NativeParseResult } from "../parsers/native-result.ts";
```

- [ ] **Step 2: Update `mergeHeadings` — rename `xhtml` param, drop `docxXml` param**

Replace the existing `mergeHeadings` function entirely:

```typescript
function mergeHeadings(
  numbered: string[],
  structure: string[],  // <h1>-<h6> (DOCX), multi-signal (PDF), title placeholders (PPTX)
  heuristic: string[],
): { headings: string[]; strategy: string } {
  const candidates: Array<{ list: string[]; name: string }> = [
    { list: structure, name: "structure" },
    { list: numbered,  name: "numbered" },
    { list: heuristic, name: "heuristic" },
  ];
  for (const { list, name } of candidates) {
    if (list.length > 3) return { headings: list, strategy: name };
  }
  const all = [...new Set([...numbered, ...structure, ...heuristic])];
  return { headings: all, strategy: "union" };
}
```

- [ ] **Step 3: Update `buildDateSignals` — replace `docxPath`/`tikaMetadata` options with `metadata`**

Replace the existing `buildDateSignals` function signature and internal date-extraction logic:

```typescript
async function buildDateSignals(
  file: FileEntry,
  text: string,
  options: { metadata?: Record<string, string>; extension?: string } = {}
): Promise<DateSignals> {
  const mtime = file.modifiedAt.toISOString().slice(0, 10);
  const ctime = file.createdAt.toISOString().slice(0, 10);
  const mtimeReliable = file.modifiedAt.getTime() !== file.createdAt.getTime();

  let documentInternalDate: string | undefined;
  let internalDateSource: DateSignals["internalDateSource"] | undefined;

  // Parser-provided metadata date (PDF info dict, DOCX/XLSX/PPTX docProps/core.xml)
  if (!documentInternalDate && options.metadata) {
    const raw = options.metadata["Creation-Date"];
    if (raw) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) {
        documentInternalDate = d.toISOString().slice(0, 10);
        // Preserve docx_core_xml source for DOCX (same semantic as before)
        internalDateSource = options.extension === ".docx" ? "docx_core_xml" : "pdf_metadata";
      }
    }
  }

  // Filename date (e.g. YYYYMMDD or YYYY-MM-DD in name)
  if (!documentInternalDate) {
    const d = extractDateFromFilename(file.filename);
    if (d) { documentInternalDate = d.toISOString().slice(0, 10); internalDateSource = "filename"; }
  }

  // Text-based extraction (German "Stand:", "Datum:", "Revision:", etc.)
  if (!documentInternalDate) {
    const result = extractDateFromText(text);
    if (result) { documentInternalDate = result.date.toISOString().slice(0, 10); internalDateSource = result.source; }
  }

  const bestDate = documentInternalDate ?? ctime;

  return {
    mtime,
    ctime,
    mtimeReliable,
    ...(documentInternalDate !== undefined ? { documentInternalDate } : {}),
    ...(internalDateSource !== undefined ? { internalDateSource } : {}),
    bestDate,
  };
}
```

- [ ] **Step 4: Delete the three helper functions that are now in the parsers**

Delete these three functions entirely (their logic moved into `docx-parser.ts` and `ooxml-meta.ts`):
- `extractHeadingsFromDocxXml`
- `extractDateFromDocxCoreXml`
- `extractDocxAuthorMeta`

Also delete the local helper `headingsFromXhtml` (was `tikaResult.headingsFromXhtml` filter):
```typescript
// DOCX XML font-size parsing — catches manually formatted headings that don't use Word Heading styles
async function extractHeadingsFromDocxXml(absolutePath: string): Promise<string[]> { ... }
// Extract dcterms:modified from DOCX core.xml
async function extractDateFromDocxCoreXml(absolutePath: string): Promise<Date | null> { ... }
// Extract author and company metadata from DOCX
async function extractDocxAuthorMeta(absolutePath: string): Promise<DocxAuthorMeta> { ... }
// XHTML h1-h6 tags from Tika
function headingsFromXhtml(xhtmlHeadings: string[]): string[] { ... }
```

- [ ] **Step 5: Replace `parseOfficeFile`**

Replace the entire `parseOfficeFile` function with:

```typescript
async function parseOfficeFile(file: FileEntry): Promise<ParsedDocument> {
  let result: NativeParseResult;
  let parserUsed: ParsedDocument["parserUsed"];

  if (file.extension === ".docx") {
    result = await parseDocx(file.absolutePath);
    parserUsed = "mammoth";
  } else if (file.extension === ".xlsx") {
    result = await parseXlsx(file.absolutePath);
    parserUsed = "sheetjs";
  } else if (file.extension === ".pptx") {
    result = await parsePptx(file.absolutePath);
    parserUsed = "pptx-native";
  } else {
    throw new Error(`Unsupported Office extension: ${file.extension}`);
  }

  const text = normalizeWhitespace(result.text);
  const garbled = isGarbledText(text);

  const isXlsx = file.extension === ".xlsx";
  const numberedHeadings = isXlsx ? [] : extractHeadingsFromNumbered(text);
  const heuristicHeadings = isXlsx ? [] : extractHeadingsFromHeuristic(text);
  const { headings: finalHeadings } = mergeHeadings(
    numberedHeadings,
    result.headingsFromStructure,
    heuristicHeadings,
  );
  const headingNodes = buildHeadingTree(finalHeadings);

  const sample = text.slice(0, 2000);
  const language = result.charCount >= 200 ? await detectLanguage(text) : "und";
  const { oem: detectedOem, source: oemSource } = detectOem(sample, finalHeadings, file.pathSegments);
  const detectedDocType = classifyDocType(file.filename, finalHeadings, sample);

  const dateSignals = await buildDateSignals(file, text, {
    metadata: result.metadata,
    extension: file.extension,
  });
  const dateSource: ParsedDocument["dateSource"] =
    dateSignals.internalDateSource === "docx_core_xml" ? "docx_core_xml" :
    dateSignals.internalDateSource === "pdf_metadata"  ? "pdf_metadata"  :
    dateSignals.internalDateSource !== undefined        ? "filename"      :
    "mtime";

  const charCount = result.charCount;
  const parseSuccess = charCount > 100 && !garbled;
  const { strategy: recommendedChunkStrategy, reasoning: chunkStrategyReasoning } =
    deriveChunkStrategyWithReasoning(file.extension, headingNodes, result.tableCount, "not_pdf");
  const requirementMetadataReliable = deriveRequirementReliability(detectedDocType, file.extension);

  return {
    ...file,
    charCount,
    tokenCountEstimate: estimateTokens(text),
    ...(result.pageCount !== undefined ? { pageCount: result.pageCount } : {}),
    language,
    headings: headingNodes,
    hasNumberedHeadings: numberedHeadings.length > 2,
    tableCount: result.tableCount,
    parserUsed,
    isScannedPdf: false,
    isOcrRequired: false,
    pdfClassification: "not_pdf",
    imageCount: result.imageCount,
    parseSuccess,
    ...(!parseSuccess ? { parseFailureReason: garbled ? "garbled_encoding" as const : "empty_extraction" as const } : {}),
    dateSource,
    dateSignals,
    recommendedChunkStrategy,
    chunkStrategyReasoning,
    requirementMetadataReliable,
    detectedOem,
    oemSource,
    ...(detectedDocType ? { detectedDocType } : {}),
    ...(!garbled && text.length > 0 ? { textContent: text.slice(0, 2_000_000) } : {}),
    parserMetadata: result.metadata,
  };
}
```

- [ ] **Step 6: Replace `parsePdfFile`**

Replace the entire `parsePdfFile` function with:

```typescript
async function parsePdfFile(file: FileEntry): Promise<ParsedDocument> {
  const result = await parsePdf(file.absolutePath);

  const pdfAuthorHint = result.metadata["Author"];
  const text = normalizeWhitespace(result.text);
  const garbled = isGarbledText(text);

  const pageCount = result.pageCount ?? 1;
  const charsPerPage = result.charCount / pageCount;

  let pdfClassification: ParsedDocument["pdfClassification"];
  let isOcrRequired: boolean;
  if (charsPerPage < 10) {
    pdfClassification = "fully_scanned";
    isOcrRequired = true;
  } else if (charsPerPage < 200 && result.imageCount > pageCount) {
    pdfClassification = "hybrid";
    isOcrRequired = false;
  } else {
    pdfClassification = "native";
    isOcrRequired = false;
  }
  const isScannedPdf = pdfClassification === "fully_scanned";

  if (pdfClassification === "fully_scanned" || pdfClassification === "hybrid") {
    logger.warn("Non-native PDF detected", {
      docId: file.id,
      path: file.path,
      pdfClassification,
      charsPerPage: Math.round(charsPerPage),
      imageCount: result.imageCount,
    });
  }

  const numberedHeadings = extractHeadingsFromNumbered(text);
  const heuristicHeadings = extractHeadingsFromHeuristic(text);
  const { headings: finalHeadings } = mergeHeadings(
    numberedHeadings,
    result.headingsFromStructure,
    heuristicHeadings,
  );
  const headingNodes = buildHeadingTree(finalHeadings);

  const sample = text.slice(0, 2000);
  const language = result.charCount >= 200 ? await detectLanguage(text) : "und";
  const { oem: detectedOem, source: oemSource } = detectOem(sample, finalHeadings, file.pathSegments);
  const detectedDocType = classifyDocType(file.filename, finalHeadings, sample);

  const dateSignals = await buildDateSignals(file, text, {
    metadata: result.metadata,
    extension: file.extension,
  });
  const dateSource: ParsedDocument["dateSource"] =
    dateSignals.internalDateSource === "docx_core_xml" ? "docx_core_xml" :
    dateSignals.internalDateSource === "pdf_metadata"  ? "pdf_metadata"  :
    dateSignals.internalDateSource !== undefined        ? "filename"      :
    "mtime";

  const charCount = result.charCount;
  const parseSuccess = charCount > 100 && !garbled;
  const { strategy: recommendedChunkStrategy, reasoning: chunkStrategyReasoning } =
    deriveChunkStrategyWithReasoning(file.extension, headingNodes, result.tableCount, pdfClassification);
  const requirementMetadataReliable = deriveRequirementReliability(detectedDocType, file.extension);

  return {
    ...file,
    charCount,
    tokenCountEstimate: estimateTokens(text),
    pageCount,
    language,
    headings: headingNodes,
    hasNumberedHeadings: numberedHeadings.length > 2,
    tableCount: result.tableCount,
    parserUsed: "pdfjs",
    isScannedPdf,
    isOcrRequired,
    pdfClassification,
    imageCount: result.imageCount,
    scannedPageRatio: result.scannedPageRatio,
    ...(result.scannedPageIndices.length > 0 ? { scannedPageIndices: result.scannedPageIndices } : {}),
    parseSuccess,
    ...(!parseSuccess ? { parseFailureReason: garbled ? "garbled_encoding" as const : "empty_extraction" as const } : {}),
    dateSource,
    dateSignals,
    recommendedChunkStrategy,
    chunkStrategyReasoning,
    requirementMetadataReliable,
    detectedOem,
    oemSource,
    ...(detectedDocType ? { detectedDocType } : {}),
    ...(pdfAuthorHint ? { pdfAuthorHint } : {}),
    ...(!garbled && text.length > 0 ? { textContent: text.slice(0, 2_000_000) } : {}),
    parserMetadata: result.metadata,
  };
}
```

- [ ] **Step 7: Update `runParse` — remove `tikaUnavailable` flag and ECONNREFUSED branch**

In `runParse`, remove `let tikaUnavailable = false;`.

Change this call:
```typescript
parsed = await parseOfficeFile(file, tikaUnavailable);
```
To:
```typescript
parsed = await parseOfficeFile(file);
```

Remove this entire block:
```typescript
if (tikaUnavailable) {
  logger.warn("Tika unavailable, skipping PDF", { docId: file.id, path: file.path });
  continue;
}
```

Remove this entire branch from the catch block:
```typescript
if (errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed")) {
  logger.error("Tika unreachable, will skip PDFs for rest of run", { error: errMsg });
  tikaUnavailable = true;
  continue;
}
```

Also remove the `DocxAuthorMeta` import since `extractDocxAuthorMeta` is gone:
```typescript
import { collectOriginSignals, classifyOrigin, type DocxAuthorMeta } from "../utils/origin-classifier.ts";
```
Replace with:
```typescript
import { collectOriginSignals, classifyOrigin } from "../utils/origin-classifier.ts";
```

In the origin classification loop at the bottom of `runParse`, the DOCX author meta block currently calls `extractDocxAuthorMeta`. Replace it:

Old block:
```typescript
let docxMeta: DocxAuthorMeta | undefined;
if (doc.extension === ".docx") {
  docxMeta = await extractDocxAuthorMeta(doc.absolutePath);
}
const signals = collectOriginSignals(doc, state.companyIdentity, docxMeta, doc.pdfAuthorHint);
```

New (author metadata is now in ParsedDocument's `metadata` field from the parser, so read it from there):
```typescript
const signals = collectOriginSignals(doc, state.companyIdentity, undefined, doc.pdfAuthorHint);
```

`collectOriginSignals` uses `docxMeta.creator`, `docxMeta.lastModifiedBy`, and `docxMeta.company`. All three are now in `doc.parserMetadata` (the new runtime field added in Task 9). Pass a constructed object:

```typescript
const docxMeta = doc.extension === ".docx" ? {
  creator:        doc.parserMetadata?.["Author"],
  lastModifiedBy: doc.parserMetadata?.["Last-Modified-By"],
  company:        doc.parserMetadata?.["Company"],
} : undefined;
const signals = collectOriginSignals(doc, state.companyIdentity, docxMeta, doc.pdfAuthorHint);
```

Also restore the `DocxAuthorMeta` import in `2-parse.ts` (it comes from origin-classifier, not a deleted file):
```typescript
import { collectOriginSignals, classifyOrigin, type DocxAuthorMeta } from "../utils/origin-classifier.ts";
```

- [ ] **Step 8: Run typecheck**

```bash
bun run typecheck
```

Expected: errors only in `tika.ts`, `officeparser.ts`, `parser-compare.ts` (to be deleted), and potentially `origin-classifier.ts` if `DocxAuthorMeta` import was removed.

- [ ] **Step 9: Commit**

```bash
git add src/phases/2-parse.ts
git commit -m "refactor(2-parse): wire native parsers, remove Tika/officeparser dispatch"
```

---

## Task 11: Clean up — delete old files, update config and server

**Files:**
- Delete: `src/parsers/tika.ts`
- Delete: `src/parsers/officeparser.ts`
- Delete: `src/parsers/parser-compare.ts`
- Modify: `src/config.ts`
- Modify: `src/server/health-state.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/routes.ts`
- Modify: `docker-compose.yml`

- [ ] **Step 1: Delete the old parser files**

```bash
rm src/parsers/tika.ts src/parsers/officeparser.ts src/parsers/parser-compare.ts
```

- [ ] **Step 2: Update `src/config.ts` — remove `tikaUrl` and `parserDivergenceThreshold`**

Remove these two lines:
```typescript
tikaUrl: process.env["TIKA_URL"] || "http://tika:9998",
```
```typescript
parserDivergenceThreshold: 0.20,  // 20% char count difference triggers alert
```

- [ ] **Step 3: Update `src/server/health-state.ts` — remove `tikaOk`**

Replace the entire file with:
```typescript
export const healthState = {
  ollamaOk: false,
  modelsAvailable: [] as string[],
  setupReady: false,
};
```

- [ ] **Step 4: Update `src/server/index.ts` — remove Tika health check**

Remove this import:
```typescript
import { checkTikaHealth } from "../parsers/tika.ts";
```

Replace this block in `start()`:
```typescript
const tikaOk = await checkTikaHealth();
const { ok: ollamaOk, modelsAvailable } = await waitForOllama();
healthState.tikaOk = tikaOk;
healthState.ollamaOk = ollamaOk;
healthState.modelsAvailable = modelsAvailable;

if (!tikaOk) logger.warn("Tika unreachable — PDF parsing will be skipped");
if (!ollamaOk) {
```

With:
```typescript
const { ok: ollamaOk, modelsAvailable } = await waitForOllama();
healthState.ollamaOk = ollamaOk;
healthState.modelsAvailable = modelsAvailable;

if (!ollamaOk) {
```

Replace the `setInterval` polling block:
```typescript
setInterval(async () => {
  const [t, { ok: o, modelsAvailable: m }] = await Promise.all([
    checkTikaHealth(),
    checkOllamaHealth(),
  ]);
  healthState.tikaOk = t;
  healthState.ollamaOk = o;
  healthState.modelsAvailable = m;
}, 30_000);
```

With:
```typescript
setInterval(async () => {
  const { ok: o, modelsAvailable: m } = await checkOllamaHealth();
  healthState.ollamaOk = o;
  healthState.modelsAvailable = m;
}, 30_000);
```

- [ ] **Step 5: Update `src/server/routes.ts` — remove `tikaOk` from health response**

In `handleHealth()`, change:
```typescript
return json({
  tikaOk: healthState.tikaOk,
  ollamaOk: healthState.ollamaOk,
```

To:
```typescript
return json({
  ollamaOk: healthState.ollamaOk,
```

- [ ] **Step 6: Remove `parserComparisonResult` from phase 9 serialization**

In `src/phases/9-report.ts`, find and delete this line (it references the deleted `ParserComparison` type):
```typescript
      parserComparisonResult: d.parserComparisonResult,
```

- [ ] **Step 8: Update `docker-compose.yml` — remove Tika service**

Remove the entire `tika:` service block (from `tika:` through its closing line).

In the `scanner:` service, remove:
```yaml
  tika:
    condition: service_started
```
from `depends_on`.

Remove from the scanner's `environment` block:
```yaml
  - TIKA_URL=http://tika:9998
```

- [ ] **Step 9: Run typecheck**

```bash
bun run typecheck
```

Expected: exits 0 with no errors.

- [ ] **Step 10: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: replace Tika + officeparser with native per-format parsers and tesseract OCR

- pdf-parser.ts: pdfjs-dist text extraction, 6-signal heading scoring, scanned-page OCR
- docx-parser.ts: mammoth HTML mode, JSZip image OCR with length gate
- xlsx-parser.ts: SheetJS cell text, JSZip image OCR
- pptx-parser.ts: JSZip XML slide text, title-placeholder headings, deduplicated image OCR
- ocr.ts: shared tesseract child-process wrapper, graceful PATH-miss
- ooxml-meta.ts: shared OPC docProps reader for DOCX/XLSX/PPTX
- Removes Tika Docker service, tikaOk health check, TIKA_URL config
- Updates state.ts: parserUsed type, parse_error replaces tika_error, removes ParserComparison"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run typecheck**

```bash
bun run typecheck
```

Expected: exits 0.

- [ ] **Step 2: Run all tests with verbose output**

```bash
bun test --reporter=verbose
```

Expected: all tests pass; no skipped tests from the new parser suite.

- [ ] **Step 3: Confirm docker-compose no longer references Tika**

```bash
grep -n tika docker-compose.yml
```

Expected: no output.

- [ ] **Step 4: Confirm no remaining imports of deleted parsers**

```bash
grep -rn "from.*parsers/tika\|from.*parsers/officeparser\|from.*parser-compare\|checkTikaHealth\|tikaOk\|tikaUrl\|parserDivergenceThreshold" src/
```

Expected: no output.

- [ ] **Step 5: Confirm `NativeParseResult` is the only parser interface imported in `2-parse.ts`**

```bash
grep "from.*parsers" src/phases/2-parse.ts
```

Expected: only imports from `pdf-parser`, `docx-parser`, `xlsx-parser`, `pptx-parser`, `native-result`.
