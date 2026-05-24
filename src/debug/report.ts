// src/debug/report.ts
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { ScannerState, ExtractedReference } from "../state.ts";
import type { PatternCoverageEntry, ZeroOutputEntry } from "./types.ts";
import { CONFIG } from "../config.ts";

const DEBUG_STRING_MAX = 60;
const EXEMPT_KEYS = new Set(["patternName"]);

function deepTruncateDebug(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.length > DEBUG_STRING_MAX ? obj.slice(0, DEBUG_STRING_MAX) : obj;
  }
  if (Array.isArray(obj)) return obj.map(deepTruncateDebug);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = EXEMPT_KEYS.has(key) ? val : deepTruncateDebug(val);
    }
    return result;
  }
  return obj;
}

function sanitizeDebugReport(obj: unknown, path = "root"): void {
  if (typeof obj === "string") {
    if (obj.length > DEBUG_STRING_MAX) {
      throw new Error(
        `Debug report guard at ${path}: string length ${obj.length} > ${DEBUG_STRING_MAX}`,
      );
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => sanitizeDebugReport(item, `${path}[${i}]`));
    return;
  }
  if (obj !== null && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      if (!EXEMPT_KEYS.has(key)) sanitizeDebugReport(val, `${path}.${key}`);
    }
  }
}

function computePatternCoverage(state: ScannerState): PatternCoverageEntry[] {
  const entries: PatternCoverageEntry[] = [];

  // Reference patterns
  const refPatterns: Array<{ name: string; types: ExtractedReference["type"][] }> = [
    { name: "NORM", types: ["iso_norm", "din_norm", "en_norm", "vda_norm", "iatf_norm"] },
    { name: "QUALITY_SPEC", types: ["quality_spec"] },
    { name: "FIKB", types: ["fikb"] },
    { name: "KB_MASTER", types: ["kb_master"] },
    { name: "CHAPTER_REF", types: ["chapter_ref"] },
    { name: "DOC_REF", types: ["doc_ref"] },
  ];
  for (const { name, types } of refPatterns) {
    const typeSet = new Set<string>(types);
    const matching = state.references.filter((r) => typeSet.has(r.type));
    entries.push({
      patternName: name,
      phase: "references",
      matchCount: matching.length,
      matchedDocIds: [...new Set(matching.map((r) => r.docId))],
      zeroMatch: matching.length === 0,
    });
  }

  // Requirement patterns (from state.requirements — reliable docs only).
  // INFORMATIVE is excluded: Phase 7 filters it out before pushing to state.requirements,
  // so it would always show zero-match and create a misleading signal.
  const reqTypes = ["MANDATORY", "RECOMMENDED", "PERMITTED", "DECLARATIVE"] as const;
  for (const reqType of reqTypes) {
    const matching = state.requirements.filter((r) => r.type === reqType);
    entries.push({
      patternName: reqType,
      phase: "requirements",
      matchCount: matching.length,
      matchedDocIds: [...new Set(matching.map((r) => r.docId))],
      zeroMatch: matching.length === 0,
    });
  }

  return entries;
}

const WRONG_DOC_TYPES = new Set<string>(["planning", "protokoll", "other"]);

function computeZeroOutputEntries(state: ScannerState): ZeroOutputEntry[] {
  const reqCountByDoc = new Map<string, number>();
  for (const r of state.requirements) {
    reqCountByDoc.set(r.docId, (reqCountByDoc.get(r.docId) ?? 0) + 1);
  }
  const refCountByDoc = new Map<string, number>();
  for (const r of state.references) {
    refCountByDoc.set(r.docId, (refCountByDoc.get(r.docId) ?? 0) + 1);
  }
  const projById = new Map(state.ingestionProjections.map((p) => [p.docId, p]));

  const entries: ZeroOutputEntry[] = [];
  for (const doc of state.parsed) {
    const reqCount = reqCountByDoc.get(doc.id) ?? 0;
    const refCount = refCountByDoc.get(doc.id) ?? 0;
    const proj = projById.get(doc.id);
    const retentionRate = proj?.tokenRetentionRate ?? 0;

    const isInteresting = (reqCount === 0 && refCount === 0) || retentionRate < 0.10;
    if (!isInteresting) continue;

    const likelyCause: ZeroOutputEntry["likelyCause"] =
      !doc.parseSuccess                                  ? "parse_failure"
      : doc.pdfClassification === "fully_scanned"        ? "scanned_pdf"
      : WRONG_DOC_TYPES.has(doc.detectedDocType ?? "")   ? "wrong_doc_type"
      : "regex_miss";

    entries.push({
      docId: doc.id,
      docType: doc.detectedDocType ?? "other",
      parseSuccess: doc.parseSuccess,
      requirementCount: reqCount,
      referenceCount: refCount,
      tokenRetentionRate: retentionRate,
      likelyCause,
    });
  }
  return entries;
}

export function writeDebugReport(state: ScannerState, timestamp: string): string | null {
  const anyEnabled =
    state.decisionAudit !== undefined ||
    state.patternCoverage !== undefined ||
    state.llmTrace !== undefined ||
    state.zeroOutputDocs !== undefined;

  if (!anyEnabled) return null;

  // Populate computed categories
  if (state.patternCoverage !== undefined) {
    state.patternCoverage.push(...computePatternCoverage(state));
  }
  if (state.zeroOutputDocs !== undefined) {
    state.zeroOutputDocs.push(...computeZeroOutputEntries(state));
  }

  const output = {
    scanId: state.scanId,
    generatedAt: new Date().toISOString(),
    categories: {
      decisionAudit:
        state.decisionAudit !== undefined
          ? { enabled: true, records: [...state.decisionAudit.values()] }
          : { enabled: false },
      patternCoverage:
        state.patternCoverage !== undefined
          ? { enabled: true, entries: state.patternCoverage }
          : { enabled: false },
      llmTrace:
        state.llmTrace !== undefined
          ? { enabled: true, records: state.llmTrace }
          : { enabled: false },
      zeroOutputDocs:
        state.zeroOutputDocs !== undefined
          ? { enabled: true, entries: state.zeroOutputDocs }
          : { enabled: false },
    },
  };

  const truncated = deepTruncateDebug(output);
  sanitizeDebugReport(truncated);

  const path = join(CONFIG.reportOutput, `scan-report-${timestamp}-debug.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(truncated, null, 2), "utf-8");
  return path;
}
