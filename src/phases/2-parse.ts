import { execFile } from "child_process";
import { promisify } from "util";
import type { ScannerState, ParsedDocument, HeadingNode, FileEntry, ChunkStrategyReasoning, DateSignals } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { estimateTokens } from "../utils/tokenizer.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { parseWithTika } from "../parsers/tika.ts";
import { parseWithOfficeParser } from "../parsers/officeparser.ts";
import { compareParserResults } from "../parsers/parser-compare.ts";

const execFileAsync = promisify(execFile);

// franc uses ESM-only exports — dynamic import required
type FrancFn = (text: string, options?: { minLength?: number }) => string;

let francFn: FrancFn | null = null;
async function detectLanguage(text: string): Promise<string> {
  if (!francFn) {
    const mod = await import("franc");
    francFn = mod.franc as FrancFn;
  }
  // franc needs at least ~30 chars to be reliable
  const sample = text.slice(0, 1000);
  if (sample.length < 30) return "und"; // undetermined
  return francFn(sample, { minLength: 5 });
}

// Replace non-breaking spaces (U+00A0) so regex patterns match correctly
function normalizeWhitespace(text: string): string {
  return text.replace(/\u00A0/g, " ");
}

// Detect garbled binary content — control chars (0x00–0x08, 0x0E–0x1F) indicate encoding failure.
function isGarbledText(text: string): boolean {
  if (text.length < 50) return false;
  const sample = text.slice(0, 5000);
  let controlCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x08) || (code >= 0x0E && code <= 0x1F)) controlCount++;
  }
  return controlCount / sample.length > 0.01; // >1% control chars = garbled
}

// Numbered patterns like "1.", "1.1", "4.2.1 Title"
function extractHeadingsFromNumbered(text: string): string[] {
  const headings: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(/^(\d+(?:\.\d+)*\.?)\s+(.{3,80})$/);
    if (m) {
      headings.push(`${m[1]} ${m[2]}`.trim());
    }
  }
  return headings;
}

// XHTML h1-h6 tags from Tika
function headingsFromXhtml(xhtmlHeadings: string[]): string[] {
  return xhtmlHeadings.filter((h) => h.length >= 3 && h.length <= 200);
}

// Heuristic — short lines without terminal period, followed by longer content
function extractHeadingsFromHeuristic(text: string): string[] {
  const headings: string[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    const next = lines[i + 1]!;
    if (
      line.length >= 4 &&
      line.length <= 80 &&
      !line.endsWith(".") &&
      !line.endsWith(",") &&
      !line.match(/^\d+$/) && // not a bare number
      next.length > 80        // followed by longer content
    ) {
      headings.push(line);
    }
  }
  return headings;
}

// Strategy 4: DOCX XML font-size parsing — catches manually formatted headings that don't use Word Heading styles
async function extractHeadingsFromDocxXml(absolutePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "unzip",
      ["-p", absolutePath, "word/document.xml"],
      { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
    );
    // Parse <w:p> paragraphs with font size >= 28 half-points (>=14pt)
    const headings: string[] = [];
    const paraRe = /<w:p[ >][\s\S]*?<\/w:p>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paraRe.exec(stdout)) !== null) {
      const para = pm[0];
      const szMatch = para.match(/<w:sz[^>]*w:val="(\d+)"/);
      if (!szMatch) continue;
      const sz = parseInt(szMatch[1] ?? "0", 10);
      if (sz < 28) continue;
      const text = para.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length >= 4 && text.length <= 120) {
        headings.push(text);
      }
    }
    return headings;
  } catch {
    // unzip not available or parse failed — graceful skip
    return [];
  }
}

// Extract date from filename — supports YYYY-MM-DD, YYYY_MM_DD, YYYYMMDD
function extractDateFromFilename(filename: string): Date | null {
  const m8 = filename.match(/(\d{4})[-_](\d{2})[-_](\d{2})/);
  if (m8) {
    const d = new Date(`${m8[1]}-${m8[2]}-${m8[3]}`);
    if (!isNaN(d.getTime())) return d;
  }
  const m6 = filename.match(/(\d{4})(\d{2})(\d{2})/);
  if (m6) {
    const d = new Date(`${m6[1]}-${m6[2]}-${m6[3]}`);
    if (!isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2030) return d;
  }
  return null;
}

// Extract dcterms:modified from DOCX core.xml
async function extractDateFromDocxCoreXml(absolutePath: string): Promise<Date | null> {
  try {
    const { stdout } = await execFileAsync(
      "unzip",
      ["-p", absolutePath, "docProps/core.xml"],
      { maxBuffer: 100 * 1024, timeout: 5000 }
    );
    const m = stdout.match(/<dcterms:modified[^>]*>([^<]+)<\/dcterms:modified>/);
    if (m?.[1]) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d;
    }
  } catch {
    // not a DOCX or unzip failed
  }
  return null;
}

// Extract revision/stand date from text — searches first 3000 chars where metadata typically appears
function extractDateFromText(text: string): { date: Date; source: "stand_pattern" | "revision_pattern" } | null {
  const sample = text.slice(0, 3000);
  const re = /\b(Stand|Revision|Datum|Erstellt am|Geändert am|Änderungsdatum|Änderungsstand)\s*:?\s*(\d{1,2})\.(\d{1,2})\.(\d{4})\b/i;
  const m = re.exec(sample);
  if (!m) return null;
  const day = parseInt(m[2] ?? "0", 10);
  const month = parseInt(m[3] ?? "0", 10);
  const year = parseInt(m[4] ?? "0", 10);
  if (year < 2000 || year > 2035 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  if (isNaN(d.getTime())) return null;
  const source = /\bStand\b/i.test(m[1] ?? "") ? "stand_pattern" : "revision_pattern";
  return { date: d, source };
}

// Build consolidated DateSignals from all available date sources
async function buildDateSignals(
  file: FileEntry,
  text: string,
  options: { docxPath?: string; tikaMetadata?: Record<string, string> } = {}
): Promise<DateSignals> {
  const mtime = file.modifiedAt.toISOString().slice(0, 10);
  const ctime = file.createdAt.toISOString().slice(0, 10);
  const mtimeReliable = file.modifiedAt.getTime() !== file.createdAt.getTime();

  let documentInternalDate: string | undefined;
  let internalDateSource: DateSignals["internalDateSource"] | undefined;

  // DOCX core.xml — most reliable for DOCX files
  if (options.docxPath) {
    const d = await extractDateFromDocxCoreXml(options.docxPath);
    if (d) { documentInternalDate = d.toISOString().slice(0, 10); internalDateSource = "docx_core_xml"; }
  }

  // PDF creation date from Tika metadata
  if (!documentInternalDate && options.tikaMetadata) {
    const raw = options.tikaMetadata["Creation-Date"]
      ?? options.tikaMetadata["created"]
      ?? options.tikaMetadata["dcterms:created"];
    if (raw) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) { documentInternalDate = d.toISOString().slice(0, 10); internalDateSource = "pdf_metadata"; }
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

  // bestDate: prefer document-internal date, fall back to ctime
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

// Majority vote across up to 4 strategies (DOCX XML is 4th)
function mergeHeadings(
  numbered: string[],
  xhtml: string[],
  heuristic: string[],
  docxXml: string[] = []
): { headings: string[]; strategy: string } {
  // Count votes: each strategy with >3 results gets 1 vote
  const candidates: Array<{ list: string[]; name: string }> = [
    { list: xhtml, name: "xhtml" },
    { list: numbered, name: "numbered" },
    { list: docxXml, name: "docx_xml" },
    { list: heuristic, name: "heuristic" },
  ];
  // XHTML and DOCX XML come from markup — trust over inference
  for (const { list, name } of candidates) {
    if (list.length > 3) return { headings: list, strategy: name };
  }
  // Fall back to union
  const all = [...new Set([...numbered, ...xhtml, ...heuristic, ...docxXml])];
  return { headings: all, strategy: "union" };
}

function buildHeadingTree(headingTexts: string[]): HeadingNode[] {
  return headingTexts.map((text) => {
    // Infer level from numbering depth
    const numberingMatch = text.match(/^(\d+(?:\.\d+)*)/);
    let level = 2; // default H2
    let numbering: string | undefined;
    if (numberingMatch) {
      numbering = numberingMatch[1];
      const dots = (numbering?.match(/\./g) ?? []).length;
      level = Math.min(dots + 1, 6);
    }
    return {
      level,
      text: text.slice(0, 120), // hard cap at 120 chars
      ...(numbering ? { numbering } : {}),
      childCount: 0,
      approximateTokens: estimateTokens(text),
    };
  });
}

type OemValue = NonNullable<ParsedDocument["detectedOem"]>;

// OEM detection — folder and document-internal signals resolved separately
function oemFromText(text: string): OemValue {
  const hasFikb = PATTERNS.fikb.test(text); PATTERNS.fikb.lastIndex = 0;
  const hasKbMaster = PATTERNS.kbMaster.test(text); PATTERNS.kbMaster.lastIndex = 0;
  const hasQv = PATTERNS.qualitySpec.test(text); PATTERNS.qualitySpec.lastIndex = 0;
  if (hasFikb || /\bmerced(es|benz)\b/i.test(text)) return "mercedes";
  if (hasQv || /\bbmw\b/i.test(text)) return "bmw";
  if (hasKbMaster || /\baudi\b/i.test(text)) return "audi";
  return "unknown";
}

function detectOem(
  sample: string,
  headings: string[],
  pathSegments: string[]
): { oem: OemValue; source: NonNullable<ParsedDocument["oemSource"]> } {
  const docOem = oemFromText([sample, ...headings].join(" "));
  const folderOem = oemFromText(pathSegments.join(" "));

  // Conflict: document-internal signal wins, source is "reconciled"
  if (docOem !== "unknown" && folderOem !== "unknown" && docOem !== folderOem) {
    return { oem: docOem, source: "reconciled" };
  }
  if (docOem !== "unknown") return { oem: docOem, source: "document_internal" };
  if (folderOem !== "unknown") return { oem: folderOem, source: "folder" };
  return { oem: "unknown", source: "folder" };
}

// --- Document type classification ---
// Filename patterns fire first (strong signal) — content fallback is secondary.
// This prevents content words like "deviation" in an SRS body from triggering "abweichliste".
function classifyDocType(filename: string, headings: string[], sample: string): ParsedDocument["detectedDocType"] {
  const fn = filename.toLowerCase();
  // Content text: headings + sample only (NOT filename — avoids cross-contamination)
  const content = [...headings.map((h) => h.toLowerCase()), sample.toLowerCase()].join(" ");

  // Filename-first rules (ordered by specificity)
  if (/\bfmea\b/i.test(fn)) return "fmea";
  if (/\baudit\b/i.test(fn)) return "audit";
  if (/\b(srs|irs|lastenheft|anforderung|requirement)\b/i.test(fn)) return "lastenheft";
  if (/\b(testbericht|test[_\s-]?report|ergebnisbericht|prüfbericht)\b/i.test(fn)) return "testbericht";
  if (/\b(abweichliste|abweichung|deviationslist)\b/i.test(fn)) return "abweichliste";
  if (/\b(pruefspec|prüfspec|testspec|pruefspezifikation|prüfspezifikation|prüfvorschrift)\b/i.test(fn)) return "pruefspezifikation";
  if (/\b(milestones?|risk[_\s-]?register|issue[_\s-]?tracker|planning?)\b/i.test(fn)) return "planning";
  if (/\b(sla|service[_\s-]?level)\b/i.test(fn)) return "sla";
  if (/\blessons?[_\s-]?learned\b/i.test(fn)) return "lessons_learned";
  if (/\b(angebot|proposal|offer)\b/i.test(fn)) return "angebot";
  if (/\b8d[-_\s]?(bericht|report)\b/i.test(fn)) return "8d_report";
  if (/\b(empb|erstmuster|isir)\b/i.test(fn)) return "empb";
  if (/([äa]nderung)(santrag|sauftrag|sbekanntmachung)|change[-_\s]?request|\becr\b|\becn\b/i.test(fn)) return "aenderungsantrag";
  if (/\b(kontrollplan|pr[üu]fplan|control[-_\s]?plan)\b/i.test(fn)) return "kontrollplan";
  if (/\bserien(liefer)?freigabe\b|\bslf\b/i.test(fn)) return "serienfreigabe";
  if (/\b(reklamation|beanstandung|warranty[-_\s]?claim)\b/i.test(fn)) return "reklamation";
  if (/\b(arbeits|verfahrens)anweisung\b|\barbeitsvorschrift\b|work[-_\s]?instruction/i.test(fn)) return "arbeitsanweisung";
  if (/\b(sitzungs|besprechungs)?protokoll\b|meeting[-_\s]?minutes/i.test(fn)) return "protokoll";
  if (/\b(lieferanten)?handbuch\b|\bsupplier[-_\s]?manual\b|\bleitfaden\b/i.test(fn)) return "handbuch";

  // Content-based fallback (headings + sample only — no filename)
  if (/lessons?\s*learned/i.test(content)) return "lessons_learned";
  if (/service\s*level|\bsla\b/i.test(content)) return "sla";
  if (/\bfmea\b/i.test(content)) return "fmea";
  if (/testbericht|ergebnisbericht|prüfbericht|\bn\.i\.o\.\b/i.test(content)) return "testbericht";
  if (/prüfspezifikation|prüfvorschrift|test\s*spec/i.test(content)) return "pruefspezifikation";
  // "abweichliste"/"abweichungsliste" are German compound nouns — safe; bare "deviation" is not
  if (/abweichliste|abweichungsliste/i.test(content)) return "abweichliste";
  if (/qv[-\s]?\d|iso\s*\d|din\s*\d|en\s*\d/i.test(fn) || /\bnorm\b/i.test(content)) return "norm";
  if (/angebot|proposal|\boffer\b/i.test(content)) return "angebot";
  if (/lastenheft|spezifikation|anforderung|requirement/i.test(content)) return "lastenheft";
  if (/\b8d[-_\s]?(bericht|report)\b/i.test(content)) return "8d_report";
  if (/erstmusterpr[üu]fbericht|\bempb\b|\bisir\b|first\s+article\s+inspection/i.test(content)) return "empb";
  if (/[äa]nderungsantrag|[äa]nderungsauftrag|engineering\s+change\s+request/i.test(content)) return "aenderungsantrag";
  if (/kontrollplan|pr[üu]fplan|control\s*plan/i.test(content)) return "kontrollplan";
  if (/serien(liefer)?freigabe|produktionsfreigabe/i.test(content)) return "serienfreigabe";
  if (/\breklamation\b|\bbeanstandung\b|warranty\s+claim/i.test(content)) return "reklamation";
  if (/arbeitsanweisung|verfahrensanweisung|\barbeitsvorschrift\b|work\s+instruction/i.test(content)) return "arbeitsanweisung";
  if (/sitzungsprotokoll|besprechungsprotokoll|\bprotokoll\b/i.test(content)) return "protokoll";
  if (/lieferantenhandbuch|supplier\s+manual|qualit[äa]tshandbuch/i.test(content)) return "handbuch";
  return "other";
}

// --- RAG strategy helpers ---

function deriveChunkStrategyWithReasoning(
  extension: string,
  headingNodes: HeadingNode[],
  tableCount: number,
  pdfClassification: ParsedDocument["pdfClassification"]
): { strategy: ParsedDocument["recommendedChunkStrategy"]; reasoning: ChunkStrategyReasoning } {
  const headingCount = headingNodes.length;
  const headingDepth = headingNodes.reduce((max, h) => Math.max(max, h.level), 0);
  const hasNestedHeadings = headingDepth > 2;
  const avgTokensPerSection = headingCount > 0
    ? Math.round(headingNodes.reduce((s, h) => s + h.approximateTokens, 0) / headingCount)
    : 0;
  const isXlsx = extension === ".xlsx";
  const signals: ChunkStrategyReasoning["signals"] = {
    headingCount,
    headingDepth,
    avgTokensPerSection,
    tableCount,
    hasNestedHeadings,
    isXlsx,
    pdfClassification: pdfClassification ?? "not_pdf",
  };

  // XLSX: always table_rows — spreadsheets have no meaningful heading hierarchy
  if (isXlsx) {
    return {
      strategy: "table_rows",
      reasoning: { recommended: "table_rows", confidence: 0.95, signals },
    };
  }

  // No headings: sliding_window (forced for fully_scanned, inferred for flat text)
  if (headingCount === 0) {
    const confidence = pdfClassification === "fully_scanned" ? 0.90 : 0.75;
    const alt = tableCount > 3 ? {
      alternativeConsidered: "table_rows" as const,
      alternativeReason: `${tableCount} tables detected — reconsider if doc is primarily tabular`.slice(0, 120),
    } : {};
    return {
      strategy: "sliding_window",
      reasoning: { recommended: "sliding_window", confidence, signals, ...alt },
    };
  }

  let confidence: number;
  if (headingCount >= 10 && hasNestedHeadings) confidence = 0.90;
  else if (headingCount >= 5) confidence = 0.78;
  else confidence = 0.60; // sparse headings — less certain

  // Competing table signal lowers confidence and surfaces dual-strategy alternative
  const alt = tableCount > 5 ? {
    alternativeConsidered: "table_rows" as const,
    alternativeReason: `${tableCount} tables detected — consider dual-strategy: heading_sections for text, table_rows for large tables`.slice(0, 120),
  } : {};
  if (tableCount > 5) confidence = Math.max(confidence - 0.10, 0.50);

  return {
    strategy: "heading_sections",
    reasoning: { recommended: "heading_sections", confidence, signals, ...alt },
  };
}

const REQUIREMENT_RELIABLE_TYPES = new Set<ParsedDocument["detectedDocType"]>([
  "lastenheft", "pruefspezifikation", "testbericht", "norm",
]);

function deriveRequirementReliability(
  detectedDocType: ParsedDocument["detectedDocType"],
  extension: string
): boolean {
  if (extension === ".xlsx") return false;
  return REQUIREMENT_RELIABLE_TYPES.has(detectedDocType);
}

export async function runParse(state: ScannerState): Promise<void> {
  const t = logger.phaseStart("2-parse");
  let tikaUnavailable = false;

  for (const file of state.files) {
    let parsed: ParsedDocument;

    try {
      if (CONFIG.officeExtensions.includes(file.extension as typeof CONFIG.officeExtensions[number])) {
        parsed = await parseOfficeFile(file, tikaUnavailable);
      } else if (CONFIG.pdfExtensions.includes(file.extension as typeof CONFIG.pdfExtensions[number])) {
        if (tikaUnavailable) {
          logger.warn("Tika unavailable, skipping PDF", { docId: file.id, path: file.path });
          continue;
        }
        parsed = await parsePdfFile(file);
      } else {
        logger.warn("Unsupported extension, skipping", { docId: file.id, ext: file.extension });
        continue;
      }
    } catch (e) {
      const errMsg = String(e);
      // If Tika is unreachable, mark and continue
      if (errMsg.includes("ECONNREFUSED") || errMsg.includes("fetch failed")) {
        logger.error("Tika unreachable, will skip PDFs for rest of run", { error: errMsg });
        tikaUnavailable = true;
        continue;
      }
      logger.warn("Parse failed for file, skipping", { docId: file.id, path: file.path, error: errMsg });
      continue;
    }

    state.parsed.push(parsed);
  }

  const scannedCount = state.parsed.filter((d) => d.pdfClassification === "fully_scanned").length;
  const hybridCount = state.parsed.filter((d) => d.pdfClassification === "hybrid").length;
  const ocrRequiredCount = state.parsed.filter((d) => d.isOcrRequired).length;
  const parseFailures = state.parsed.filter((d) => !d.parseSuccess).length;
  const byType: Record<string, number> = {};
  for (const d of state.parsed) {
    const t = d.detectedDocType ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }

  logger.phaseEnd("2-parse", t, {
    parsed: state.parsed.length,
    fullScanned: scannedCount,
    hybridPdfs: hybridCount,
    ocrRequired: ocrRequiredCount,
    parseFailures,
    byType,
  });
}

async function parseOfficeFile(file: FileEntry, tikaUnavailable: boolean): Promise<ParsedDocument> {
  const opResult = await parseWithOfficeParser(file.absolutePath);
  const opText = normalizeWhitespace(opResult.text);
  const opGarbled = isGarbledText(opText);

  // XLSX files have no meaningful heading structure — cell values like "5 days early" or
  // "13 days late" would be falsely picked up by the numbered/heuristic strategies.
  // Only trust Tika XHTML headings for XLSX (from named ranges or explicit headers).
  const isXlsx = file.extension === ".xlsx";
  const numberedHeadings = isXlsx ? [] : extractHeadingsFromNumbered(opText);
  const heuristicHeadings = isXlsx ? [] : extractHeadingsFromHeuristic(opText);

  const docxXmlHeadings = file.extension === ".docx"
    ? await extractHeadingsFromDocxXml(file.absolutePath)
    : [];

  // Secondary: Tika for comparison and XHTML headings (skip if unavailable)
  let tikaResult: Awaited<ReturnType<typeof parseWithTika>> | null = null;
  let comparisonResult;
  let tikaHeadings: string[] = [];

  if (!tikaUnavailable) {
    try {
      tikaResult = await parseWithTika(file.absolutePath);
      tikaHeadings = tikaResult.headingsFromXhtml;

      comparisonResult = compareParserResults({
        docId: file.id,
        officeparserChars: opResult.charCount,
        officeparserHeadings: numberedHeadings,
        tikaChars: tikaResult.charCount,
        tikaHeadings: tikaResult.headingsFromXhtml,
      });
    } catch {
      // Tika comparison optional for Office files
    }
  }

  const { headings: finalHeadings } = mergeHeadings(numberedHeadings, tikaHeadings, heuristicHeadings, docxXmlHeadings);
  const headingNodes = buildHeadingTree(finalHeadings);

  const sample = opText.slice(0, 2000);
  // skip franc for short docs — franc result unreliable below 200 chars
  const language = opResult.charCount >= 200 ? await detectLanguage(opText) : "und";
  const { oem: detectedOem, source: oemSource } = detectOem(sample, finalHeadings, file.pathSegments);
  const detectedDocType = classifyDocType(file.filename, finalHeadings, sample);

  const dateSignals = await buildDateSignals(
    file,
    opText,
    file.extension === ".docx" ? { docxPath: file.absolutePath } : {}
  );
  const dateSource: ParsedDocument["dateSource"] =
    dateSignals.internalDateSource === "docx_core_xml" ? "docx_core_xml" :
    dateSignals.internalDateSource === "pdf_metadata" ? "pdf_metadata" :
    dateSignals.internalDateSource !== undefined ? "filename" :
    "mtime";

  const charCount = opResult.charCount;
  const parseSuccess = charCount > 100 && !opGarbled;
  const tableCount = tikaResult?.tableCount ?? 0;
  const { strategy: recommendedChunkStrategy, reasoning: chunkStrategyReasoning } =
    deriveChunkStrategyWithReasoning(file.extension, headingNodes, tableCount, "not_pdf");
  const requirementMetadataReliable = deriveRequirementReliability(detectedDocType, file.extension);

  return {
    ...file,
    charCount,
    tokenCountEstimate: estimateTokens(opText),
    ...(tikaResult?.pageCount !== undefined ? { pageCount: tikaResult.pageCount } : {}),
    language,
    headings: headingNodes,
    hasNumberedHeadings: numberedHeadings.length > 2,
    tableCount,
    parserUsed: "officeparser",
    ...(comparisonResult ? { parserComparisonResult: comparisonResult } : {}),
    isScannedPdf: false,
    isOcrRequired: false,
    pdfClassification: "not_pdf",
    parseSuccess,
    ...(!parseSuccess ? { parseFailureReason: opGarbled ? "garbled_encoding" as const : "empty_extraction" as const } : {}),
    dateSource,
    dateSignals,
    recommendedChunkStrategy,
    chunkStrategyReasoning,
    requirementMetadataReliable,
    detectedOem,
    oemSource,
    ...(detectedDocType ? { detectedDocType } : {}),
    // cached for downstream phases — avoids re-reading binary files
    ...(!opGarbled && opText.length > 0 ? { textContent: opText.slice(0, 2_000_000) } : {}),
  };
}

async function parsePdfFile(file: FileEntry): Promise<ParsedDocument> {
  const tikaResult = await parseWithTika(file.absolutePath);
  const tikaText = normalizeWhitespace(tikaResult.text);
  const tikaGarbled = isGarbledText(tikaText);

  const pageCount = tikaResult.pageCount ?? 1;
  const charsPerPage = tikaResult.charCount / pageCount;

  // Three-tier hybrid PDF classification
  let pdfClassification: ParsedDocument["pdfClassification"];
  let isOcrRequired: boolean;
  if (charsPerPage < 10) {
    pdfClassification = "fully_scanned";
    isOcrRequired = true;
  } else if (charsPerPage < 200 && tikaResult.imageCount > pageCount) {
    pdfClassification = "hybrid";
    isOcrRequired = false; // partial OCR needed but flag separately
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
      imageCount: tikaResult.imageCount,
    });
  }

  const numberedHeadings = extractHeadingsFromNumbered(tikaText);
  const heuristicHeadings = extractHeadingsFromHeuristic(tikaText);
  const { headings: finalHeadings } = mergeHeadings(
    numberedHeadings,
    headingsFromXhtml(tikaResult.headingsFromXhtml),
    heuristicHeadings
  );
  const headingNodes = buildHeadingTree(finalHeadings);

  const sample = tikaText.slice(0, 2000);
  // skip franc for short docs — franc result unreliable below 200 chars
  const language = tikaResult.charCount >= 200 ? await detectLanguage(tikaText) : "und";
  const { oem: detectedOem, source: oemSource } = detectOem(sample, finalHeadings, file.pathSegments);
  const detectedDocType = classifyDocType(file.filename, finalHeadings, sample);

  const dateSignals = await buildDateSignals(
    file,
    tikaText,
    { tikaMetadata: tikaResult.metadata }
  );
  const dateSource: ParsedDocument["dateSource"] =
    dateSignals.internalDateSource === "docx_core_xml" ? "docx_core_xml" :
    dateSignals.internalDateSource === "pdf_metadata" ? "pdf_metadata" :
    dateSignals.internalDateSource !== undefined ? "filename" :
    "mtime";

  const charCount = tikaResult.charCount;
  const parseSuccess = charCount > 100 && !tikaGarbled;
  const { strategy: recommendedChunkStrategy, reasoning: chunkStrategyReasoning } =
    deriveChunkStrategyWithReasoning(file.extension, headingNodes, tikaResult.tableCount, pdfClassification);
  const requirementMetadataReliable = deriveRequirementReliability(detectedDocType, file.extension);

  return {
    ...file,
    charCount,
    tokenCountEstimate: estimateTokens(tikaText),
    pageCount,
    language,
    headings: headingNodes,
    hasNumberedHeadings: numberedHeadings.length > 2,
    tableCount: tikaResult.tableCount,
    parserUsed: "tika",
    isScannedPdf,
    isOcrRequired,
    pdfClassification,
    imageCount: tikaResult.imageCount,
    scannedPageRatio: tikaResult.scannedPageRatio,
    ...(tikaResult.scannedPageIndices.length > 0 ? { scannedPageIndices: tikaResult.scannedPageIndices } : {}),
    parseSuccess,
    ...(!parseSuccess ? { parseFailureReason: tikaGarbled ? "garbled_encoding" as const : "empty_extraction" as const } : {}),
    dateSource,
    dateSignals,
    recommendedChunkStrategy,
    chunkStrategyReasoning,
    requirementMetadataReliable,
    detectedOem,
    oemSource,
    ...(detectedDocType ? { detectedDocType } : {}),
    // cached for downstream phases — avoids re-reading binary files
    ...(!tikaGarbled && tikaText.length > 0 ? { textContent: tikaText.slice(0, 2_000_000) } : {}),
  };
}
