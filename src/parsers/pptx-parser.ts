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
