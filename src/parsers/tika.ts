import { readFile } from "fs/promises";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";

export interface TikaResult {
  text: string;
  charCount: number;
  pageCount?: number;
  metadata: Record<string, string>;
  headingsFromXhtml: string[];
  tableCount: number;
  imageCount: number;           // IMP-01: count of embedded image resources
  scannedPageRatio: number;     // GAP-02: fraction of pages with < 100 chars (0.0–1.0)
  scannedPageIndices: number[]; // GAP-02: 1-indexed page numbers detected as image-only
}

// Health check for Tika
export async function checkTikaHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${CONFIG.tikaUrl}/tika`, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Parse a document via Tika's HTTP API
export async function parseWithTika(absolutePath: string): Promise<TikaResult> {
  const fileBuffer = await readFile(absolutePath);

  // Get plain text
  const textRes = await fetch(`${CONFIG.tikaUrl}/tika`, {
    method: "PUT",
    body: fileBuffer,
    headers: {
      "Accept": "text/plain",
      "Content-Disposition": `attachment; filename="${absolutePath.split("/").pop()}"`,
    },
    signal: AbortSignal.timeout(60000),
  });

  if (!textRes.ok) {
    throw new Error(`Tika text extraction failed: ${textRes.status} ${textRes.statusText}`);
  }

  const text = await textRes.text();

  // Get metadata
  let metadata: Record<string, string> = {};
  let imageCount = 0;
  try {
    const metaRes = await fetch(`${CONFIG.tikaUrl}/meta`, {
      method: "PUT",
      body: fileBuffer,
      headers: {
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(30000),
    });
    if (metaRes.ok) {
      const rawMeta = await metaRes.json() as Record<string, unknown>;
      // Flatten arrays to first value, stringify everything else
      for (const [k, v] of Object.entries(rawMeta)) {
        if (Array.isArray(v)) {
          metadata[k] = String(v[0] ?? "");
        } else {
          metadata[k] = String(v ?? "");
        }
      }
      // IMP-01: count embedded image resources from metadata
      // Tika reports embedded image count in "embeddedResourceTypeCounts" or similar keys
      imageCount = parseImageCount(rawMeta);
    }
  } catch (e) {
    logger.warn("Tika metadata extraction failed", { path: absolutePath, error: String(e) });
  }

  // Get XHTML to extract heading tags, table count, and per-page scanned analysis
  let headingsFromXhtml: string[] = [];
  let tableCount = 0;
  let scannedPageRatio = 0;
  let scannedPageIndices: number[] = [];
  try {
    const xhtmlRes = await fetch(`${CONFIG.tikaUrl}/tika`, {
      method: "PUT",
      body: fileBuffer,
      headers: {
        "Accept": "application/xhtml+xml",
      },
      signal: AbortSignal.timeout(60000),
    });
    if (xhtmlRes.ok) {
      const xhtml = await xhtmlRes.text();
      headingsFromXhtml = extractHeadingsFromXhtml(xhtml);
      tableCount = countTablesInXhtml(xhtml);
      // GAP-02: per-page analysis only meaningful for PDFs (page div markers)
      const pageAnalysis = analyzeScannedPages(xhtml);
      scannedPageRatio = pageAnalysis.ratio;
      scannedPageIndices = pageAnalysis.scannedIndices;
    }
  } catch (e) {
    logger.warn("Tika XHTML extraction failed", { path: absolutePath, error: String(e) });
  }

  // Parse page count from metadata
  const pageCount = parsePageCount(metadata);

  return {
    text,
    charCount: text.length,
    ...(pageCount !== undefined ? { pageCount } : {}),
    metadata,
    headingsFromXhtml,
    tableCount,
    imageCount,
    scannedPageRatio,
    scannedPageIndices,
  };
}

// IMP-01: Parse image count from Tika metadata response
function parseImageCount(rawMeta: Record<string, unknown>): number {
  // Tika may report image counts in various metadata keys
  const imageKeys = [
    "embeddedResourceTypeCounts",
    "pdf:PDFVersion", // not images, but check for image-related keys
  ];
  // Check for keys containing "image" (case-insensitive)
  let count = 0;
  for (const [k, v] of Object.entries(rawMeta)) {
    const kl = k.toLowerCase();
    if (kl.includes("image") && kl.includes("count")) {
      const n = parseInt(String(Array.isArray(v) ? v[0] : v), 10);
      if (!isNaN(n)) count += n;
    }
    // Tika's recursive metadata may list embedded resource types like "image/jpeg: 5"
    if (kl === "embeddedresourcetypecounts" || kl === "embedded:typecounts") {
      const val = String(Array.isArray(v) ? v[0] : v);
      // Format: "image/jpeg: 3, image/png: 2" etc.
      const imgMatches = val.matchAll(/image\/[^:]+:\s*(\d+)/gi);
      for (const m of imgMatches) {
        count += parseInt(m[1] ?? "0", 10);
      }
    }
  }
  return count;
}

function extractHeadingsFromXhtml(xhtml: string): string[] {
  const headings: string[] = [];
  // Match h1-h6 tags
  const headingRe = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(xhtml)) !== null) {
    const text = stripHtmlTags(m[2] ?? "").trim();
    if (text) headings.push(text);
  }
  return headings;
}

function countTablesInXhtml(xhtml: string): number {
  const tableRe = /<table[\s>]/gi;
  return (xhtml.match(tableRe) ?? []).length;
}

// GAP-02: Split XHTML by Tika's <div class="page"> markers to analyse per-page text density.
// Pages with < 100 chars of text are classified as image-only (scanned).
function analyzeScannedPages(xhtml: string): { ratio: number; scannedIndices: number[] } {
  // Split on <div class="page"> — segments[0] is preamble, segments[1..n] are pages
  const segments = xhtml.split(/<div class="page">/i);
  if (segments.length <= 1) {
    // No page markers — document type doesn't use page divs (e.g. DOCX via Tika)
    return { ratio: 0, scannedIndices: [] };
  }
  const scannedIndices: number[] = [];
  const totalPages = segments.length - 1; // skip preamble
  for (let i = 1; i <= totalPages; i++) {
    const pageText = stripHtmlTags(segments[i] ?? "").trim();
    if (pageText.length < 100) {
      scannedIndices.push(i);
    }
  }
  const ratio = totalPages > 0 ? scannedIndices.length / totalPages : 0;
  return { ratio, scannedIndices };
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parsePageCount(metadata: Record<string, string>): number | undefined {
  const pageKeys = [
    "xmpTPg:NPages",
    "meta:page-count",
    "Page-Count",
    "pdf:PDFVersion", // not page count but fallback signal
  ];
  for (const key of pageKeys) {
    const val = metadata[key];
    if (val) {
      const n = parseInt(val, 10);
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return undefined;
}
