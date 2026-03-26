import type { ScannerState, ConsistencyCheck } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";

// Clamp interpretation strings so they pass the content-leak guard.
// Interpretations are diagnostic metadata, not document content.
function clamp(s: string): string {
  return s.slice(0, CONFIG.maxStringLengthInReport);
}

function check(
  checkName: string,
  value: number,
  threshold: number,
  passIf: "below" | "above" | "between",
  severity: ConsistencyCheck["severity"],
  interpretation: string
): ConsistencyCheck {
  let passed: boolean;
  if (passIf === "below") passed = value <= threshold;
  else if (passIf === "above") passed = value >= threshold;
  else passed = true; // "between" — caller computes passed
  return { checkName, passed, value, threshold, severity, interpretation };
}

export async function runValidate(state: ScannerState): Promise<void> {
  const t = logger.phaseStart("7-validate");
  const checks: ConsistencyCheck[] = [];

  // 0. CORPUS_EMPTY — all downstream metrics are meaningless
  if (state.parsed.length === 0) {
    checks.push({
      checkName: "CORPUS_EMPTY",
      passed: false,
      value: 0,
      threshold: 1,
      severity: "CRITICAL",
      interpretation: clamp("No documents were parsed — DOCUMENTS_ROOT may be wrong or contain no supported file types. All downstream metrics are unreliable."),
    });
    state.consistencyChecks = checks;
    logger.phaseEnd("7-validate", t, { totalChecks: 1, critical: 1, warnings: 0, passed: 0 });
    return;
  }

  // 0b. CORPUS_TOO_SMALL — version pair and LLM validation stats not meaningful below 5 docs
  if (state.parsed.length < 5) {
    checks.push({
      checkName: "CORPUS_TOO_SMALL",
      passed: false,
      value: state.parsed.length,
      threshold: 5,
      severity: "WARNING",
      interpretation: `Only ${state.parsed.length} doc(s) parsed — version pair scores and LLM validation statistics are not meaningful with fewer than 5 documents.`,
    });
  }

  // 1. sectionSizeEstimate — avg tokens/section >5000 chunks poorly with heading_sections strategy
  const largeSectionDocs: Array<{ id: string; filename: string }> = [];
  for (const doc of state.parsed) {
    if (doc.headings.length === 0 || doc.tokenCountEstimate === 0) continue;
    const avgTokensPerSection = doc.tokenCountEstimate / doc.headings.length;
    if (avgTokensPerSection > 5000) {
      largeSectionDocs.push({ id: doc.id, filename: doc.filename });
    }
  }
  checks.push({
    checkName: "sectionSizeEstimate",
    passed: largeSectionDocs.length === 0,
    value: largeSectionDocs.length,
    threshold: 0,
    severity: "INFO",
    interpretation: clamp(largeSectionDocs.length > 0
      ? `${largeSectionDocs.length} doc(s) have avg >5000 tokens/section — heading structure may be too coarse for heading_sections chunking`
      : "Section size estimates within expected range for heading_sections chunking"),
  });

  // 2. versionPairSymmetry — check for asymmetric detections
  const pairSet = new Set(state.versionPairs.map((p) => `${p.docA}:${p.docB}`));
  const asymmetric: string[] = [];
  for (const pair of state.versionPairs) {
    if (pair.confidence === "HIGH" && !pairSet.has(`${pair.docB}:${pair.docA}`) && !pairSet.has(`${pair.docA}:${pair.docB}`)) {
      asymmetric.push(`${pair.docA}<->${pair.docB}`);
    }
  }
  checks.push({
    checkName: "versionPairSymmetry",
    passed: asymmetric.length === 0,
    value: asymmetric.length,
    threshold: 0,
    severity: asymmetric.length > 0 ? "WARNING" : "INFO",
    interpretation: asymmetric.length > 0
      ? `${asymmetric.length} asymmetric version pair(s) detected — possible detection error`
      : "Version pair detection is symmetric",
  });

  // 3. referenceResolutionRate — only counts internal references (doc_ref, chapter_ref, fikb, kb_master)
  // External norms (iso_norm, vda_norm, etc.) are expected to be unresolved — they're external standards.
  const INTERNAL_REF_TYPES = new Set(["doc_ref", "chapter_ref", "fikb", "kb_master"]);
  const internalRefs = state.references.filter((r) => INTERNAL_REF_TYPES.has(r.type));
  const resolvedInternal = internalRefs.filter((r) => r.resolutionMethod === "exact" || r.resolutionMethod === "fuzzy").length;
  const resolutionRate = internalRefs.length > 0 ? resolvedInternal / internalRefs.length : 1;
  const externalNormCount = state.references.filter((r) => r.resolutionMethod === "external_norm").length;
  checks.push({
    checkName: "referenceResolutionRate",
    passed: resolutionRate >= 0.40,
    value: resolutionRate,
    threshold: 0.40,
    severity: resolutionRate < 0.40 && internalRefs.length > 0 ? "WARNING" : "INFO",
    interpretation: clamp(internalRefs.length === 0
      ? `No internal cross-references found (${externalNormCount} external norm refs excluded from rate)`
      : resolutionRate < 0.40
        ? `Only ${(resolutionRate * 100).toFixed(0)}% of internal references resolved — corpus may be incomplete (${externalNormCount} external norm refs not counted)`
        : `${(resolutionRate * 100).toFixed(0)}% of internal references resolved (${externalNormCount} external norm refs excluded)`),
  });

  // 4. requirementDensityRange
  const reqsByDoc = new Map<string, number>();
  for (const req of state.requirements) {
    reqsByDoc.set(req.docId, (reqsByDoc.get(req.docId) ?? 0) + 1);
  }
  for (const doc of state.parsed) {
    const pages = Math.max(doc.pageCount ?? 1, 1);
    const reqs = reqsByDoc.get(doc.id) ?? 0;
    const density = reqs / pages;
    if (density < 0.5 && doc.detectedDocType === "lastenheft") {
      checks.push({
        checkName: "requirementDensityRange",
        passed: false,
        value: density,
        threshold: 0.5,
        severity: "INFO",
        interpretation: `Doc ${doc.id} (${doc.filename}): classified as lastenheft but has only ${density.toFixed(2)} requirements/page — may need review`,
      });
    } else if (density > 15) {
      checks.push({
        checkName: "requirementDensityRange",
        passed: false,
        value: density,
        threshold: 15,
        severity: "WARNING",
        interpretation: `Doc ${doc.id} (${doc.filename}): ${density.toFixed(1)} requirements/page — possible false positives in regex extraction`,
      });
    }
  }
  if (!checks.some((c) => c.checkName === "requirementDensityRange")) {
    checks.push({
      checkName: "requirementDensityRange",
      passed: true,
      value: 0,
      threshold: 15,
      severity: "INFO",
      interpretation: "Requirement density is within expected ranges for all documents",
    });
  }

  // 5. parserDivergenceRate
  const officeDocs = state.parsed.filter((d) => d.parserUsed === "officeparser");
  const diverged = officeDocs.filter((d) =>
    d.parserComparisonResult?.divergenceLevel === "major"
  ).length;
  const divergenceRate = officeDocs.length > 0 ? diverged / officeDocs.length : 0;
  checks.push({
    checkName: "parserDivergenceRate",
    passed: divergenceRate <= 0.30,
    value: divergenceRate,
    threshold: 0.30,
    severity: divergenceRate > 0.30 ? "CRITICAL" : "INFO",
    interpretation: divergenceRate > 0.30
      ? `${(divergenceRate * 100).toFixed(0)}% of Office files have major parser divergence — CRITICAL: officeparser may be unreliable for this corpus, consider using Tika for all document types`
      : `${(divergenceRate * 100).toFixed(0)}% major parser divergence in Office files — acceptable`,
  });

  // 6. scannedPdfRate — graduated by per-doc scannedPageRatio
  // CRITICAL: >50% pages image-only; WARNING: >10% pages image-only
  const pdfs = state.parsed.filter((d) => d.extension === ".pdf");
  const fullOcrDocs = pdfs.filter((d) => (d.scannedPageRatio ?? 0) > 0.5);
  const partialOcrDocs = pdfs.filter((d) => {
    const r = d.scannedPageRatio ?? 0;
    return r > 0.1 && r <= 0.5;
  });
  const nativeDocs = pdfs.filter((d) => (d.scannedPageRatio ?? 0) <= 0.1);
  const severity: ConsistencyCheck["severity"] = fullOcrDocs.length > 0 ? "CRITICAL"
    : partialOcrDocs.length > 0 ? "WARNING"
    : "INFO";
  checks.push({
    checkName: "scannedPdfRate",
    passed: fullOcrDocs.length === 0 && partialOcrDocs.length === 0,
    value: fullOcrDocs.length + partialOcrDocs.length,
    threshold: 0,
    severity,
    interpretation: clamp(
      fullOcrDocs.length > 0
        ? `${fullOcrDocs.length} PDF(s) need full OCR (>50% pages scanned), ${partialOcrDocs.length} need partial OCR (>10%), ${nativeDocs.length} native`
        : partialOcrDocs.length > 0
          ? `${partialOcrDocs.length} PDF(s) need partial OCR (10–50% pages scanned), ${nativeDocs.length} fully native`
          : `All ${nativeDocs.length} PDFs are native (scannedPageRatio ≤10% per doc)`
    ),
  });

  // 7. oemConsistency — multiple OEMs in same project folder
  const projectOems = new Map<string, Set<string>>();
  for (const doc of state.parsed) {
    const project = doc.inferredProject ?? "unknown";
    const oem = doc.detectedOem;
    if (oem && oem !== "unknown") {
      if (!projectOems.has(project)) projectOems.set(project, new Set());
      projectOems.get(project)!.add(oem);
    }
  }
  const mixedProjects = [...projectOems.entries()].filter(([, oems]) => oems.size > 1);
  checks.push({
    checkName: "oemConsistency",
    passed: mixedProjects.length === 0,
    value: mixedProjects.length,
    threshold: 0,
    severity: mixedProjects.length > 0 ? "WARNING" : "INFO",
    interpretation: mixedProjects.length > 0
      ? `${mixedProjects.length} project(s) contain documents from multiple OEMs — may be cross-OEM projects or misclassification`
      : "Each project folder contains documents from a single OEM",
  });

  // 8. languageMixRate
  const nonGerman = state.parsed.filter((d) => d.language !== "deu" && d.language !== "und").length;
  const langMixRate = state.parsed.length > 0 ? nonGerman / state.parsed.length : 0;
  checks.push({
    checkName: "languageMixRate",
    passed: true,
    value: langMixRate,
    threshold: 0.30,
    severity: langMixRate > 0.30 ? "INFO" : "INFO",
    interpretation: `${(langMixRate * 100).toFixed(0)}% of documents have non-German primary language${langMixRate > 0.30 ? " — consider bilingual chunking strategy in RAG pipeline" : ""}`,
  });

  // 9. fikbCoverage — for Lastenhefte, what % of FIKBs appear in Abweichlisten
  const lastenhefte = state.parsed.filter((d) => d.detectedDocType === "lastenheft");
  const abweichlisten = state.parsed.filter((d) => d.detectedDocType === "abweichliste");

  if (lastenhefte.length > 0 && abweichlisten.length > 0) {
    const fikbsInLastenhefte = new Set(
      state.references.filter((r) =>
        (r.type === "fikb" || r.type === "kb_master") &&
        lastenhefte.some((d) => d.id === r.docId)
      ).map((r) => r.rawText)
    );
    const fikbsInAbweichlisten = new Set(
      state.references.filter((r) =>
        (r.type === "fikb" || r.type === "kb_master") &&
        abweichlisten.some((d) => d.id === r.docId)
      ).map((r) => r.rawText)
    );

    const covered = [...fikbsInLastenhefte].filter((f) => fikbsInAbweichlisten.has(f)).length;
    const coverageRate = fikbsInLastenhefte.size > 0 ? covered / fikbsInLastenhefte.size : 1;
    checks.push({
      checkName: "fikbCoverage",
      passed: coverageRate >= 0.7,
      value: coverageRate,
      threshold: 0.7,
      severity: coverageRate < 0.7 ? "WARNING" : "INFO",
      interpretation: `${(coverageRate * 100).toFixed(0)}% of FIKB/KB_Master IDs from Lastenhefte appear in Abweichlisten${coverageRate < 0.7 ? " — deviation tracking may be incomplete" : ""}`,
    });
  }

  // 10. llmValidationDelta
  if (state.llmValidation.sampledDocIds.length > 0) {
    const delta = state.llmValidation.regexVsLlmDelta;
    checks.push({
      checkName: "llmValidationDelta",
      passed: delta <= 0.20,
      value: delta,
      threshold: 0.20,
      severity: delta > 0.20 ? "WARNING" : "INFO",
      interpretation: delta > 0.20
        ? `Regex vs LLM requirement count differs by ${(delta * 100).toFixed(0)}% — ${delta > 0 ? "LLM finds more requirements; regex may miss implicit ones" : "regex may have false positives"}`
        : `Regex and LLM requirement counts agree within ${(delta * 100).toFixed(0)}% — extraction reliable`,
    });
  }

  // 11. parseSuccessRate — detects silent parse failures (password-protected, corrupt, empty)
  const totalParsed = state.parsed.length;
  const successfullyParsed = state.parsed.filter((d) => d.parseSuccess).length;
  const parseSuccessRate = totalParsed > 0 ? successfullyParsed / totalParsed : 1;
  if (totalParsed > 0) {
    let severity: ConsistencyCheck["severity"] = "INFO";
    let interpretation = `${(parseSuccessRate * 100).toFixed(0)}% parse success rate (${successfullyParsed}/${totalParsed} docs with charCount > 100)`;
    if (parseSuccessRate < 0.70) {
      severity = "CRITICAL";
      interpretation = `parseSuccessRate=${(parseSuccessRate * 100).toFixed(0)}% — corpus metrics are not trustworthy. Resolve parse failures before using this report for RAG architecture decisions.`;
    } else if (parseSuccessRate < 0.85) {
      severity = "WARNING";
      interpretation = `parseSuccessRate=${(parseSuccessRate * 100).toFixed(0)}% — significant parse failures detected. Aggregate metrics may be unreliable. Check for password-protected or corrupt files.`;
    }
    checks.push({
      checkName: "parseSuccessRate",
      passed: parseSuccessRate >= 0.85,
      value: parseSuccessRate,
      threshold: 0.85,
      severity,
      interpretation: clamp(interpretation),
    });
  }

  // 12. chunkStrategyConfidence — heading_sections recommended but heading signal is weak
  const lowConfidenceDocs = state.parsed.filter(
    (d) => d.recommendedChunkStrategy === "heading_sections" &&
           d.chunkStrategyReasoning.confidence < 0.70
  );
  checks.push({
    checkName: "chunkStrategyConfidence",
    passed: lowConfidenceDocs.length === 0,
    value: lowConfidenceDocs.length,
    threshold: 0,
    severity: lowConfidenceDocs.length > 0 ? "WARNING" : "INFO",
    interpretation: clamp(lowConfidenceDocs.length > 0
      ? `${lowConfidenceDocs.length} doc(s) have heading_sections recommended with confidence <70% — sparse headings, manual formatting suspected`
      : "All heading_sections recommendations have adequate confidence"),
  });

  // 13. oemSourceConflict — folder vs document-internal OEM signals disagree
  const reconciledDocs = state.parsed.filter((d) => d.oemSource === "reconciled");
  checks.push({
    checkName: "oemSourceConflict",
    passed: reconciledDocs.length === 0,
    value: reconciledDocs.length,
    threshold: 0,
    severity: reconciledDocs.length > 0 ? "WARNING" : "INFO",
    interpretation: clamp(reconciledDocs.length > 0
      ? `${reconciledDocs.length} doc(s) have conflicting OEM signals (folder vs document-internal) — doc-internal signal used; verify folder structure`
      : "No OEM signal conflicts between folder and document-internal detection"),
  });

  // 14. uniformTimestamps — all docs share identical mtime (NTFS/SMB copy artifact)
  if (state.parsed.length >= 5) {
    const mtimes = new Set(state.parsed.map((d) => d.dateSignals.mtime));
    if (mtimes.size === 1) {
      checks.push({
        checkName: "uniformTimestamps",
        passed: false,
        value: state.parsed.length,
        threshold: 1,
        severity: "WARNING",
        interpretation: clamp(`All ${state.parsed.length} documents share identical mtime — likely filesystem copy artifact; date-based version ordering is unreliable`),
      });
    } else {
      checks.push({
        checkName: "uniformTimestamps",
        passed: true,
        value: mtimes.size,
        threshold: 1,
        severity: "INFO",
        interpretation: `${mtimes.size} distinct mtime values across ${state.parsed.length} documents`,
      });
    }
  }

  // 15. actionabilityMatrix — overall signal reliability for RAG architecture decisions
  const criticalFailed = checks.filter((c) => !c.passed && c.severity === "CRITICAL").length;
  const warningFailed = checks.filter((c) => !c.passed && c.severity === "WARNING").length;
  const parseSuccessEntry = checks.find((c) => c.checkName === "parseSuccessRate");
  const parseRate = parseSuccessEntry?.value ?? 1;
  const isActionable = parseRate >= 0.85 && criticalFailed === 0 && warningFailed <= 2;
  const actionSeverity: ConsistencyCheck["severity"] = criticalFailed > 0 ? "CRITICAL"
    : warningFailed > 2 ? "WARNING"
    : "INFO";
  checks.push({
    checkName: "actionabilityMatrix",
    passed: isActionable,
    value: criticalFailed + warningFailed * 0.5,
    threshold: 0,
    severity: actionSeverity,
    interpretation: clamp(isActionable
      ? "Scan results are actionable — sufficient signal quality for RAG architecture decisions"
      : criticalFailed > 0
        ? `${criticalFailed} CRITICAL check(s) failed — resolve before using results for architecture decisions`
        : `${warningFailed} warnings — review flagged items before finalizing RAG architecture`),
  });

  state.consistencyChecks = checks.map((c) => ({
    ...c,
    interpretation: clamp(c.interpretation),
  }));

  const criticalCount = checks.filter((c) => !c.passed && c.severity === "CRITICAL").length;
  const warningCount = checks.filter((c) => !c.passed && c.severity === "WARNING").length;

  logger.phaseEnd("7-validate", t, {
    totalChecks: checks.length,
    critical: criticalCount,
    warnings: warningCount,
    passed: checks.filter((c) => c.passed).length,
  });
}
