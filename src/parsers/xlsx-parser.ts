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
