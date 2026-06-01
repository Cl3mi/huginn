import type { ScannerState, ParsedDocument, HeadingNode, FileEntry, ChunkStrategyReasoning, DateSignals } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { estimateTokens } from "../utils/tokenizer.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { parsePdf } from "../parsers/pdf-parser.ts";
import { parseDocx } from "../parsers/docx-parser.ts";
import { parseXlsx } from "../parsers/xlsx-parser.ts";
import { parsePptx } from "../parsers/pptx-parser.ts";
import type { NativeParseResult } from "../parsers/native-result.ts";
import { ProjectionAccumulator, projectDocument } from "./3-projection.ts";
import { collectOriginSignals, classifyOrigin, type DocxAuthorMeta } from "../utils/origin-classifier.ts";

export let _lastAccumulator: ProjectionAccumulator | null = null;

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

// ── Debug helpers (no-op when state.decisionAudit is undefined) ──────────────

function buildDocTypeDebugSignals(
  filename: string,
  headings: string[],
  sample: string,
): Record<string, number | boolean> {
  const fn = filename.toLowerCase();
  const content = [...headings.map((h) => h.toLowerCase()), sample.toLowerCase()].join(" ");
  return {
    headingCount: headings.length,
    filenameMatchFired:
      /\bfmea\b|\baudit\b|\bsrs\b|\birs\b|\blastenheft\b|\btestbericht\b|\babweichliste\b|\bpruefspec\b|\bprüfspec\b|\bmilestones?\b|\brisk\b|\bplanning\b|\bangebot\b|\b8d\b|\bempb\b|\bkontrollplan\b|\bserienfreigabe\b|\breklamation\b|\barbeitsanweisung\b|\bprotokoll\b|\bhandbuch\b|\bsla\b|\blessons?\b/i.test(fn),
    hasFmeaSignal:   /\bfmea\b/i.test(fn) || /\bfmea\b/i.test(content),
    hasLastenheftSignal: /\b(srs|irs|lastenheft|anforderung|requirement)\b/i.test(fn) || /lastenheft|anforderung|requirement/i.test(content),
    hasTestberichtSignal: /testbericht|ergebnisbericht|prüfbericht/i.test(fn) || /testbericht|ergebnisbericht/i.test(content),
    hasAbweichlisteSignal: /abweichliste/i.test(fn) || /abweichliste|abweichungsliste/i.test(content),
    hasNormSignal: /iso\s*\d|din\s*\d|en\s*\d|\bnorm\b/i.test(content),
  };
}

function buildOemDebugSignals(
  sample: string,
  headings: string[],
  pathSegments: string[],
): Record<string, boolean> {
  const text = [sample, ...headings, pathSegments.join(" ")].join(" ");
  const hasFikb = PATTERNS.fikb.test(text); PATTERNS.fikb.lastIndex = 0;
  const hasKbMaster = PATTERNS.kbMaster.test(text); PATTERNS.kbMaster.lastIndex = 0;
  const hasQv = PATTERNS.qualitySpec.test(text); PATTERNS.qualitySpec.lastIndex = 0;
  return {
    hasFikbPattern: hasFikb,
    hasKbMasterPattern: hasKbMaster,
    hasQvPattern: hasQv,
    hasMercedesKeyword: /\bmerced(es|benz)\b/i.test(text),
    hasBmwKeyword: /\bbmw\b/i.test(text),
    hasAudiKeyword: /\baudi\b/i.test(text),
  };
}

export async function runParse(state: ScannerState): Promise<void> {
  const t = logger.phaseStart("2-parse");

  const projectionAcc = new ProjectionAccumulator();

  for (const file of state.files) {
    let parsed: ParsedDocument;

    try {
      if (CONFIG.officeExtensions.includes(file.extension as typeof CONFIG.officeExtensions[number])) {
        parsed = await parseOfficeFile(file);
      } else if (CONFIG.pdfExtensions.includes(file.extension as typeof CONFIG.pdfExtensions[number])) {
        parsed = await parsePdfFile(file);
      } else {
        logger.warn("Unsupported extension, skipping", { docId: file.id, ext: file.extension });
        continue;
      }
    } catch (e) {
      const errMsg = String(e);
      logger.warn("Parse failed for file, skipping", { docId: file.id, path: file.path, error: errMsg });
      continue;
    }

    state.parsed.push(parsed);
    if (state.decisionAudit !== undefined) {
      const sample = (parsed.textContent ?? "").slice(0, 2000);
      const headingTexts = parsed.headings.map((h) => h.text);
      state.decisionAudit.set(parsed.id, {
        docId: parsed.id,
        docTypeSignals: {
          ...buildDocTypeDebugSignals(parsed.filename, headingTexts, sample),
          ...buildOemDebugSignals(sample, headingTexts, parsed.pathSegments),
        },
        docTypeChosen: parsed.detectedDocType ?? "other",
        oemDetected: parsed.detectedOem ?? "unknown",
        oemSource: parsed.oemSource ?? "folder",
        chunkStrategyChosen: parsed.recommendedChunkStrategy,
        chunkStrategyConfidence: parsed.chunkStrategyReasoning.confidence,
        chunkStrategySignals: {
          headingCount: parsed.chunkStrategyReasoning.signals.headingCount,
          headingDepth: parsed.chunkStrategyReasoning.signals.headingDepth,
          tableCount: parsed.chunkStrategyReasoning.signals.tableCount,
          isXlsx: parsed.chunkStrategyReasoning.signals.isXlsx,
          pdfClassification: parsed.chunkStrategyReasoning.signals.pdfClassification,
        },
      });
    }
    const projection = await projectDocument(parsed, projectionAcc);
    state.ingestionProjections.push(projection);
  }

  _lastAccumulator = projectionAcc;
  logger.info("Per-doc ingestion projection complete", { projectedDocs: state.ingestionProjections.length });

  const scannedCount = state.parsed.filter((d) => d.pdfClassification === "fully_scanned").length;
  const hybridCount = state.parsed.filter((d) => d.pdfClassification === "hybrid").length;
  const ocrRequiredCount = state.parsed.filter((d) => d.isOcrRequired).length;
  const parseFailures = state.parsed.filter((d) => !d.parseSuccess).length;
  const byType: Record<string, number> = {};
  for (const d of state.parsed) {
    const t = d.detectedDocType ?? "unknown";
    byType[t] = (byType[t] ?? 0) + 1;
  }

  if (state.companyIdentity) {
    for (const doc of state.parsed) {
      const docxMeta: DocxAuthorMeta | undefined = doc.extension === ".docx" ? {
        ...(doc.parserMetadata?.["Author"]           ? { creator:        doc.parserMetadata["Author"] }           : {}),
        ...(doc.parserMetadata?.["Last-Modified-By"] ? { lastModifiedBy: doc.parserMetadata["Last-Modified-By"] } : {}),
        ...(doc.parserMetadata?.["Company"]          ? { company:        doc.parserMetadata["Company"] }          : {}),
      } : undefined;
      const signals = collectOriginSignals(doc, state.companyIdentity, docxMeta, doc.pdfAuthorHint);
      const classification = classifyOrigin(signals);
      doc.originClassification = classification;
      doc.documentOrigin = classification.result;
    }
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
