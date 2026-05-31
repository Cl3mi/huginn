# Tika Replacement Design

**Date:** 2026-05-31  
**Status:** Approved  
**Scope:** Replace Apache Tika Docker container and `officeparser` npm package with native Bun-compatible libraries, adding embedded-image OCR for all formats via tesseract.

---

## Motivation

The current parsing stack requires a running Tika Docker container (Java, ~500 MB image) for all PDF work and uses `officeparser` for DOCX/XLSX/PPTX. Tika is an optional dependency today (PDFs are skipped gracefully if unreachable), but it is the primary parser for the most document-rich format. Eliminating it removes Docker complexity, cuts startup time, and enables OCR on embedded images across all formats — something Tika never provided.

---

## Approach: Per-format parsers + shared OCR helper (Option C)

```
src/parsers/
  native-result.ts      shared NativeParseResult interface
  ocr.ts                tesseract child-process wrapper
  ooxml-meta.ts         shared OPC docProps reader (DOCX/XLSX/PPTX)
  pdf-parser.ts         pdfjs-dist, multi-signal headings, scanned-page OCR
  docx-parser.ts        mammoth HTML mode, JSZip word/media/, per-image OCR
  xlsx-parser.ts        SheetJS cell text, JSZip xl/media/, per-image OCR
  pptx-parser.ts        JSZip XML, slide title placeholders, per-slide OCR
  tika.ts               DELETED
  officeparser.ts       DELETED
  parser-compare.ts     DELETED
```

Each parser returns the same `NativeParseResult`. `2-parse.ts` dispatches by extension — same structure as today.

---

## Section 1: Shared interface & OCR helper

### `src/parsers/native-result.ts`

```typescript
export interface NativeParseResult {
  text: string;                    // native text + OCR text merged
  charCount: number;
  pageCount?: number;              // pages (PDF), slides (PPTX), sheets (XLSX, documented as sheetCount semantics)
  metadata: Record<string, string>; // author, creation date, title, company
  headingsFromStructure: string[]; // <h1>-<h6> from HTML (DOCX) or scored signals (PDF) or title placeholders (PPTX)
  tableCount: number;              // <table> tags (DOCX), <a:tbl> count (PPTX), 0 for PDF/XLSX
  imageCount: number;              // embedded image count
  scannedPageRatio: number;        // PDF only; fraction of pages with < 100 chars native text
  scannedPageIndices: number[];    // PDF only; 1-indexed page numbers detected as image-only
  ocrPageCount: number;            // pages/images that had tesseract run on them
}
```

Replaces `TikaResult` and `OfficeparserResult`. All consumers (`2-parse.ts`) updated to use this type.

### `src/parsers/ocr.ts`

- `runTesseract(imagePath: string): Promise<string>`
  - Spawns `tesseract <imagePath> stdout -l deu+eng` as a child process
  - Timeout: 30 s per image
  - Returns trimmed stdout text
  - If tesseract is not on PATH: returns `""`, logs a one-time `warn` (graceful skip)
  - Caller creates and cleans up the temp image file

### `src/parsers/ooxml-meta.ts`

Shared helper for all OPC-based formats (DOCX/XLSX/PPTX). Accepts a `JSZip` instance, reads `docProps/core.xml` and `docProps/app.xml`, returns:

```typescript
interface OoxmlMeta {
  creator?: string;           // dc:creator
  lastModifiedBy?: string;    // cp:lastModifiedBy
  company?: string;           // <Company> in app.xml
  creationDate?: string;      // dcterms:created
  pageCountHint?: number;     // <Pages> in app.xml (Word only)
}
```

All three Office parsers call this instead of duplicating XML parsing.

---

## Section 2: PDF parser (`src/parsers/pdf-parser.ts`)

**Dependencies:** `pdfjs-dist`, `canvas`

### Text extraction
Load with `pdfjs-dist`, call `getTextContent()` per page. Concatenate all items' `str` fields with newlines at page boundaries. Normalize whitespace.

### Scanned page detection + OCR
Per page, if extracted text length < 100 chars:
- Render page to `canvas` → write temp PNG → `runTesseract()` → append OCR text to that page's text block
- Mark page index as scanned (1-indexed)
- `scannedPageRatio` = scanned pages / total pages
- `scannedPageIndices` = list of scanned page numbers

### Multi-signal heading detection

Run on text items from `getTextContent()`. Each item has `str`, `transform` (font size in `transform[3]`), and `fontName`. Score each candidate line:

| Signal | Source | Points |
|--------|--------|--------|
| Numbered pattern (`1.`, `1.1`, `2.3.4`, `Appendix A`) | regex on `str` | 3 |
| Font size > 1.3× median body size | `transform[3]` | 3 |
| Font name contains Bold/Heavy/Black | `fontName` | 2 |
| Short line + large vertical gap above (y-delta > 20pt) | position delta | 2 |
| All-caps, 3–40 chars | `str` check | 1 |
| Near top of page or after vertical gap > 50pt | y-position threshold | 1 |

Lines scoring ≥ 4 are added to `headingsFromStructure`. This replaces the `xhtml` strategy; `mergeHeadings` in `2-parse.ts` receives a `pdfStructure` slot.

### Metadata
`getMetadata()` returns the PDF info dict. Maps `Author`, `CreationDate`, `Title` into the `metadata` record. `pageCount` comes from `numPages`.

### Image count
`getOperatorList()` per page — count `OPS.paintImageXObject` and `OPS.paintInlineImageXObject` operator codes. Sum across pages → `imageCount`.

### Table count
Set to `0` — not reliably detectable from pdfjs-dist without a layout engine. Known regression from Tika's XHTML `<table>` counting. Chunk strategy logic handles `tableCount = 0` gracefully (no "consider table_rows" alternative surfaces for PDFs).

---

## Section 3: Office parsers

### `src/parsers/docx-parser.ts`

**Dependencies:** `mammoth`, `jszip`

- mammoth in **HTML mode** (`mammoth.convertToHtml()`) → HTML string
- `headingsFromStructure`: extract text from `<h1>`–`<h6>` tags
- `tableCount`: count `<table>` tags in HTML output
- Plain text: strip all HTML tags from the same output (no separate parse pass)
- Metadata: open .docx as JSZip → `parseOoxmlMeta(zip)` → populate `metadata` record; `pageCount` from `pageCountHint`
- Images:
  ```typescript
  const imageEntries = Object.keys(zip.files).filter(f =>
    f.startsWith("word/media/") &&
    /\.(png|jpg|jpeg|tiff|bmp|gif)$/i.test(f)
  );
  ```
  For each: extract to temp file → `runTesseract()` → append only if `ocrText.length > 20`
- `imageCount` = `imageEntries.length`

Replaces `officeparser.ts` entirely. The three `execFileAsync("unzip", ...)` calls in `2-parse.ts` (`extractHeadingsFromDocxXml`, `extractDateFromDocxCoreXml`, `extractDocxAuthorMeta`) are all deleted — mammoth HTML mode covers headings, JSZip covers metadata.

### `src/parsers/xlsx-parser.ts`

**Dependencies:** `xlsx` (SheetJS), `jszip`

- SheetJS `read(buffer, { type: "buffer" })` → iterate sheets, `sheet_to_csv()` per sheet, join with newlines
- `headingsFromStructure`: `[]` — XLSX has no heading semantics
- `tableCount`: `0` — each sheet is already tabular; chunk strategy forces `table_rows` for `.xlsx` regardless
- `pageCount`: sheet count (comment in code: "sheet count, not printed pages")
- Metadata: JSZip → `parseOoxmlMeta(zip)`
- Images:
  ```typescript
  const imageEntries = Object.keys(zip.files).filter(f =>
    f.startsWith("xl/media/") &&
    /\.(png|jpg|jpeg|tiff|bmp|gif)$/i.test(f)
  );
  ```
  Same OCR gate as DOCX (`length > 20`)

### `src/parsers/pptx-parser.ts`

**Dependencies:** `jszip`

- JSZip → `ppt/presentation.xml` to get slide count and order
- Per slide: read `ppt/slides/slideN.xml` → extract all `<a:t>` text nodes
- Headings: `<p:sp>` shapes with `<p:ph type="title"/>` or `<p:ph type="ctrTitle"/>` → their `<a:t>` text → `headingsFromStructure`
  - Note for future: `<p:ph type="subTitle"/>` and `<p:ph type="body"/>` with `lvl` attribute carry outline-level info in structured decks; worth adding as a secondary heading signal later
- `tableCount`: count `<a:tbl>` elements across all slides
- `pageCount`: slide count
- Metadata: JSZip → `parseOoxmlMeta(zip)`
- Images: read `ppt/slides/_rels/slideN.xml.rels` per slide → collect resolved `ppt/media/` paths, filtered to image extensions only (`png|jpg|jpeg|tiff|bmp|gif`) — slides can also reference video and audio via .rels
  ```typescript
  const processedMedia = new Set<string>();
  for (const mediaPath of resolvedMediaPaths) {
    if (processedMedia.has(mediaPath)) continue;
    processedMedia.add(mediaPath);
    // extract + OCR
  }
  imageCount = processedMedia.size;
  ```
  Deduplication is by resolved path, not relationship ID — same image referenced from multiple slides is OCR'd once.
- OCR gate: `ocrText.length > 20` before appending (same as DOCX/XLSX)

---

## Section 4: Changes to `2-parse.ts`, `state.ts`, and config

### `src/phases/2-parse.ts`

- Remove imports: `parseWithTika`, `parseWithOfficeParser`, `compareParserResults`
- Add imports: `parsePdf`, `parseDocx`, `parseXlsx`, `parsePptx`
- Remove `tikaUnavailable` flag and `ECONNREFUSED` error branch
- `parseOfficeFile`: dispatch by `file.extension` → `parseDocx` / `parseXlsx` / `parsePptx`
- `mergeHeadings`: rename `xhtml` parameter/strategy label to `pdfStructure` (PDF) or `htmlStructure` (DOCX)
- Delete: `extractHeadingsFromDocxXml`, `extractDateFromDocxCoreXml`, `extractDocxAuthorMeta`
- `buildDateSignals` reads author/date from `result.metadata` in both PDF and Office paths
- `parserUsed` values: `"pdfjs"` | `"mammoth"` | `"sheetjs"` | `"pptx-native"`

### `src/state.ts`

- `ParsedDocument.parserUsed` type: `"pdfjs" | "mammoth" | "sheetjs" | "pptx-native"`
- `ParsedDocument.parseFailureReason`: rename `"tika_error"` to `"parse_error"` (format-agnostic)
- `ParserComparison` interface: deleted
- `ParsedDocument.parserComparisonResult?`: deleted

### `src/config.ts`

- Remove `tikaUrl` field and all references

### `src/server/health-state.ts` / `routes.ts`

- Remove `checkTikaHealth` call — Ollama is the only remaining external dependency

### `docker-compose.yml`

- Remove `tika` service
- Remove `tika` from `scanner.depends_on`
- Remove `TIKA_URL` from scanner environment

### `package.json`

Add: `pdfjs-dist`, `mammoth`, `xlsx`, `jszip`, `canvas`  
Remove: `officeparser`

---

## Section 5: Error handling & testing

### Error handling

| Failure | Behavior |
|---------|----------|
| pdfjs corrupt/encrypted PDF | throw → `2-parse.ts` catches, `parseFailureReason: "parse_error"` |
| mammoth parse failure | same throw/catch |
| SheetJS / JSZip failure | same throw/catch |
| tesseract not on PATH | `ocr.ts` catches spawn error, logs one-time `warn`, returns `""` — parser continues without OCR |
| Individual image OCR failure | caught per-image, `warn` log, skipped — does not abort document |
| canvas not installed (PDF render fails) | caught, page treated as scanned, `isOcrRequired: true` set as downstream signal, OCR skipped |

### Tests

- `src/parsers/ocr.test.ts` — stub `execFile`; verify length gate, timeout, graceful PATH miss
- `src/parsers/pdf-parser.test.ts` — mock pdfjs page objects; verify scanned threshold, heading scoring boundary (score 3 = not heading, score 4 = heading), `imageCount` from operator codes
- `src/parsers/docx-parser.test.ts` — fixture `.docx`; verify heading count, table count, OCR gate (< 20 chars not appended), non-image media entries ignored
- `src/parsers/xlsx-parser.test.ts` — fixture `.xlsx`; verify cell text concatenation, sheet count, image type filtering
- `src/parsers/pptx-parser.test.ts` — fixture `.pptx`; verify title placeholder heading extraction, media deduplication (same file from two slides counted once)
- `src/parsers/ooxml-meta.test.ts` — verify `creator`, `company`, `creationDate` from known `core.xml` + `app.xml`
- Existing `2-parse.ts` integration tests: update `parserUsed` assertions, remove `ParserComparison` assertions

---

## Known regressions

- **PDF table count**: Tika extracted `<table>` counts from XHTML; pdfjs-dist has no equivalent. `tableCount` is always `0` for PDFs. Downstream impact: "consider table_rows" alternative in chunk strategy reasoning will not surface for PDFs.
- **Parser comparison**: `parserComparisonResult` on `ParsedDocument` is removed. The two-parser comparison (officeparser vs Tika) had no downstream consumers beyond the Phase 8 report; its absence reduces report detail.
- **DOCX `pageCount`**: Tika reported printed page count for DOCX. The new approach reads `<Pages>` from `docProps/app.xml` via mammoth/JSZip — this is the same value Word writes, so parity is expected but not guaranteed for all generators.
