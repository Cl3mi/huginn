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
  if (meta.creator)        metadata["Author"]           = meta.creator;
  if (meta.lastModifiedBy) metadata["Last-Modified-By"] = meta.lastModifiedBy;
  if (meta.company)        metadata["Company"]           = meta.company;
  if (meta.creationDate)   metadata["Creation-Date"]     = meta.creationDate;

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
