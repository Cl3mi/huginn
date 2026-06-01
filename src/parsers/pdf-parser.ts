import { readFile, writeFile, unlink } from "fs/promises";
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

// pdfjs-dist v6 requires DOM globals at runtime (DOMMatrix, ImageData) and
// recommends its `legacy` build in Node-like environments. node-canvas provides
// the globals; the legacy build avoids the rest of the DOM-init code path.
async function ensurePdfjsLib(): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> {
  if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
    const canvasMod = (await import("canvas")) as unknown as { DOMMatrix: unknown; ImageData: unknown };
    (globalThis as { DOMMatrix?: unknown }).DOMMatrix = canvasMod.DOMMatrix;
    (globalThis as { ImageData?: unknown }).ImageData = canvasMod.ImageData;
  }
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdfjs-dist v6 in Node needs the legacy worker file. Point at it on first use.
  if (!lib.GlobalWorkerOptions.workerSrc) {
    lib.GlobalWorkerOptions.workerSrc = (await import.meta.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"));
  }
  return lib;
}

export async function parsePdf(absolutePath: string): Promise<NativeParseResult> {
  const pdfjsLib = await ensurePdfjsLib();

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
    const { info } = (await doc.getMetadata()) as unknown as { info: Record<string, unknown> };
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
