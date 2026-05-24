import type { ScannerState, ExtractedRequirement, ParsedDocument } from "../state.ts";
import type { SectorProfile, ReqType } from "../profiles/types.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { complete } from "../llm/ollama.ts";
import { requirementValidationPrompt, type SectionSignals } from "../llm/prompts.ts";

function classifyType(text: string, profile: SectorProfile): ReqType {
  const reset = (re: RegExp) => { re.lastIndex = 0; };
  const { MANDATORY, RECOMMENDED, PERMITTED, DECLARATIVE } = profile.requirementPatterns;
  if (MANDATORY.test(text))   { reset(MANDATORY);   return "MANDATORY"; }
  reset(MANDATORY);
  if (RECOMMENDED.test(text)) { reset(RECOMMENDED); return "RECOMMENDED"; }
  reset(RECOMMENDED);
  if (PERMITTED.test(text))   { reset(PERMITTED);   return "PERMITTED"; }
  reset(PERMITTED);
  if (DECLARATIVE.test(text)) { reset(DECLARATIVE); return "DECLARATIVE"; }
  reset(DECLARATIVE);
  return "INFORMATIVE";
}

function classifyCategory(
  text: string,
  profile: SectorProfile,
): ExtractedRequirement["category"] {
  const safetyRe = profile.safetyKeywords;
  if (safetyRe.test(text)) { safetyRe.lastIndex = 0; return "Safety"; }
  safetyRe.lastIndex = 0;
  if (PATTERNS.materialKeywords.test(text))   { PATTERNS.materialKeywords.lastIndex = 0;   return "Material"; }
  if (PATTERNS.toleranceKeywords.test(text))  { PATTERNS.toleranceKeywords.lastIndex = 0;  return "Tolerance"; }
  if (PATTERNS.testingKeywords.test(text))    { PATTERNS.testingKeywords.lastIndex = 0;    return "Testing"; }
  if (PATTERNS.packagingKeywords.test(text))  { PATTERNS.packagingKeywords.lastIndex = 0;  return "Packaging"; }
  const delivRe = profile.deliveryKeywords;
  if (delivRe && delivRe.test(text)) { delivRe.lastIndex = 0; return "Delivery"; }
  return "Other";
}

function isSafetyRelevant(text: string, profile: SectorProfile): boolean {
  const result = profile.safetyKeywords.test(text);
  profile.safetyKeywords.lastIndex = 0;
  return result;
}

// PRIVACY: Extract count + unit tokens only — never store spec values.
function extractQuantitativeValueInfo(text: string): { count: number; unitTypes: string[] } | undefined {
  const matches = findAllMatches(PATTERNS.quantitativeValue, text);
  if (matches.length === 0) return undefined;
  const units = matches.map((m) => {
    const u = m.match(/[a-zA-Z°%µ]+/);
    return u ? u[0]! : "?";
  });
  return { count: matches.length, unitTypes: [...new Set(units)].slice(0, 5) };
}

function extractLinkedEntityRef(
  text: string,
  profile: SectorProfile,
): string | undefined {
  if (!profile.entityIdPatterns || profile.entityIdPatterns.length === 0) return undefined;
  for (const { pattern } of profile.entityIdPatterns) {
    const pat = new RegExp(pattern.source, "gi");
    const matches = findAllMatches(pat, text);
    if (matches.length > 0) return matches[0]!.slice(0, 30);
  }
  return undefined;
}

interface RequirementFilterResult {
  confirmed: boolean;
  negated: boolean;
  uncertain: boolean;
}

// Three pre-filters a sentence must pass to count as a confirmed requirement
function applyRequirementFilters(sentence: string, profile: SectorProfile): RequirementFilterResult {
  // Filter 1 — Negation exclusion (German modal only)
  if (profile.requirementLanguageFamily === "german_modal") {
    const negated = /nicht\s+muss|muss\s+nicht|nicht\s+soll|soll\s+nicht/i.test(sentence);
    if (negated) return { confirmed: false, negated: true, uncertain: false };
  }

  // Filter 2 — Subject plausibility: needs a subject noun, technical abbreviation, or compound noun
  const hasGermanSubject = /^(?:Die|Das|Der|Ein|Eine|Alle|Jede[rs]?)\s+[A-ZÄÖÜ]/.test(sentence.trim());
  const hasEnglishSubject = /^(?:The|A|An|All|Each|Every)\s+[a-zA-Z]/.test(sentence.trim());
  // handles "Supplier shall...", "BMS must..."
  const startsCapitalWithReqVerb = /^[A-Z].*\b(?:shall|must|should)\b/.test(sentence.trim());
  const hasTechnicalAbbrev = /[A-Z]{2,}/.test(sentence);
  const hasNounCompound = /[A-Z][a-z]+[A-Z][a-z]+/.test(sentence);
  const hasSubject = hasGermanSubject || hasEnglishSubject || startsCapitalWithReqVerb || hasTechnicalAbbrev || hasNounCompound;

  // Filter 3 — Sentence length gate: 8-80 words
  const wordCount = sentence.trim().split(/\s+/).length;
  const lengthOk = wordCount >= 8 && wordCount <= 80;

  if (!hasSubject || !lengthOk) {
    return { confirmed: false, negated: false, uncertain: true };
  }
  return { confirmed: true, negated: false, uncertain: false };
}

interface Section {
  heading: string;
  text: string;
}

function splitIntoSections(doc: ParsedDocument, fullText: string): Section[] {
  const sections: Section[] = [];
  const lines = fullText.split("\n");
  const headingSet = new Set(doc.headings.map((h) => h.text.toLowerCase().trim()));

  let currentHeading = "Einleitung";
  let currentLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (headingSet.has(trimmed.toLowerCase()) && trimmed.length >= 3 && trimmed.length <= 150) {
      if (currentLines.length > 0) {
        sections.push({ heading: currentHeading, text: currentLines.join("\n") });
      }
      currentHeading = trimmed.slice(0, 120);
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }
  if (currentLines.length > 0) {
    sections.push({ heading: currentHeading, text: currentLines.join("\n") });
  }

  return sections;
}

// Compute structural signals from section text — these are the ONLY values passed to the LLM.
// The text itself is consumed here and never forwarded to any external service.
function computeSectionSignals(text: string): SectionSignals {
  const wordCount = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  const modalMatches = text.match(/\b(?:muss|müssen|soll|sollen|kann|können|shall|must|should)\b/gi) ?? [];
  const modalVerbCount = modalMatches.length;
  const sentences = text.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
  const sentenceCount = Math.max(1, sentences.length);
  // Inline pattern — avoids global regex lastIndex state from PATTERNS
  const hasQuantitativeValues = /\d+[,.]?\d*\s*(?:mm|cm|m\b|kg|g\b|°C|K\b|N\b|MPa|kN|%|bar|kPa|µm)/i.test(text);
  return { wordCount, modalVerbCount, sentenceCount, hasQuantitativeValues, regexCount: 1 };
}

// PRIVACY: only pre-computed structural signals permitted — never document text
async function validateWithLlm(
  sampledSections: Array<{ docId: string; docType: string; heading: string; signals: SectionSignals }>
): Promise<{
  regexVsLlmDelta: number;
  confidenceInterval: { lower: number; upper: number };
  sampledDocIds: string[];
  byDocumentType: Record<string, { sampled: number; avgDelta: number }>;
  llmRecoveredCount?: number;
  llmRejectedCount?: number;
}> {
  let plausibleCount = 0;
  let lowCount = 0;    // LLM says regex undercounts → regex missed requirements
  let highCount = 0;   // LLM says regex overcounts → likely false positives
  const sampledDocIds: string[] = [];
  const typeStats = new Map<string, { agree: number; disagree: number; count: number }>();

  for (const { docId, docType, heading, signals } of sampledSections) {
    sampledDocIds.push(docId);

    let verdict = "PLAUSIBLE";
    try {
      const prompt = requirementValidationPrompt(signals);
      const response = await complete(prompt, { temperature: 0.0, maxTokens: 10 });
      verdict = response.trim().toUpperCase().split(/\s+/)[0] ?? "PLAUSIBLE";
    } catch (e) {
      logger.warn("LLM validation failed for section", { docId, heading, error: String(e) });
      continue;
    }

    if (verdict.startsWith("LOW")) { lowCount++; }
    else if (verdict.startsWith("HIGH")) { highCount++; }
    else { plausibleCount++; }

    if (!typeStats.has(docType)) typeStats.set(docType, { agree: 0, disagree: 0, count: 0 });
    const ts = typeStats.get(docType)!;
    ts.count++;
    if (verdict.startsWith("PLAUSIBLE")) ts.agree++; else ts.disagree++;
  }

  const total = plausibleCount + lowCount + highCount;
  const delta = total > 0 ? (lowCount + highCount) / total : 0;

  const n = sampledSections.length;
  const margin = n > 0 ? 1.96 * Math.sqrt((delta * (1 - delta)) / n) : 0.5;

  const byDocumentType: Record<string, { sampled: number; avgDelta: number }> = {};
  for (const [type, { disagree, count }] of typeStats) {
    byDocumentType[type] = { sampled: count, avgDelta: count > 0 ? disagree / count : 0 };
  }

  // LOW = LLM finds more requirements than regex; HIGH = LLM rejects regex counts
  return {
    regexVsLlmDelta: delta,
    confidenceInterval: {
      lower: Math.max(0, delta - margin),
      upper: Math.min(1, delta + margin),
    },
    sampledDocIds: [...new Set(sampledDocIds)],
    byDocumentType,
    ...(lowCount > 0 ? { llmRecoveredCount: lowCount } : {}),
    ...(highCount > 0 ? { llmRejectedCount: highCount } : {}),
  };
}

export async function runRequirements(state: ScannerState, ollamaAvailable: boolean): Promise<void> {
  const t = logger.phaseStart("7-requirements");

  const samplePoolByType = new Map<string, Array<{ docId: string; docType: string; heading: string; signals: SectionSignals }>>();

  for (const doc of state.parsed) {
    const fullText = doc.textContent ?? "";
    if (!fullText) continue;

    const sections = splitIntoSections(doc, fullText);
    let rawCount = 0;
    let confirmedCount = 0;
    let negatedCount = 0;
    let uncertainCount = 0;
    const docType = doc.detectedDocType ?? "other";

    for (const section of sections) {
      const type = classifyType(section.text, state.sectorProfile);
      if (type === "INFORMATIVE") continue;

      rawCount++;

      const sentences = section.text.split(/(?<=[.!?])\s+|(?<=[.!?])$/);
      let reqSentence: string;
      if (type === "DECLARATIVE") {
        reqSentence = sentences.find((s) => {
          const result = state.sectorProfile.requirementPatterns.DECLARATIVE.test(s.trim());
          state.sectorProfile.requirementPatterns.DECLARATIVE.lastIndex = 0;
          return result;
        }) ?? section.text;
      } else {
        reqSentence = sentences.find((s) => {
          const trimmed = s.trim();
          const { MANDATORY, RECOMMENDED, PERMITTED } = state.sectorProfile.requirementPatterns;
          const result = MANDATORY.test(trimmed) || RECOMMENDED.test(trimmed) || PERMITTED.test(trimmed);
          MANDATORY.lastIndex = 0; RECOMMENDED.lastIndex = 0; PERMITTED.lastIndex = 0;
          return result;
        }) ?? section.text;
      }

      const filterResult = applyRequirementFilters(reqSentence, state.sectorProfile);
      if (filterResult.negated) { negatedCount++; continue; }
      if (filterResult.uncertain) { uncertainCount++; continue; }

      // Confirmed requirement — only push to state.requirements for reliable doc types
      // (planning docs, trackers, meeting minutes produce structural false positives)
      confirmedCount++;
      if (!doc.requirementMetadataReliable) continue;
      const category = classifyCategory(section.text, state.sectorProfile);
      const safety = isSafetyRelevant(section.text, state.sectorProfile);
      const quantInfo = extractQuantitativeValueInfo(section.text);
      const hasQuantitative = (quantInfo?.count ?? 0) > 0;
      const linkedEntityRef = extractLinkedEntityRef(section.text, state.sectorProfile);
      const normPat = new RegExp(state.sectorProfile.normPattern.source, "gi");
      const normMatches = findAllMatches(normPat, section.text);
      const linkedNorm = normMatches[0]?.slice(0, 30);

      state.requirements.push({
        docId: doc.id,
        sectionHeading: section.heading.slice(0, 120),
        type,
        category,
        hasQuantitativeValue: hasQuantitative,
        ...(quantInfo ? { quantitativeValueCount: quantInfo.count, quantitativeUnitTypes: quantInfo.unitTypes } : {}),
        ...(linkedNorm ? { linkedNorm } : {}),
        ...(linkedEntityRef !== undefined ? { linkedEntityRef } : {}),
        isSafetyRelevant: safety,
        source: "regex" as const,
      });

      if (section.text.length > 200) {
        if (!samplePoolByType.has(docType)) samplePoolByType.set(docType, []);
        const pool = samplePoolByType.get(docType)!;
        if (pool.length < 50) { // cap per type
          const sectionSignals = computeSectionSignals(section.text);
          pool.push({ docId: doc.id, docType, heading: section.heading, signals: sectionSignals });
        }
      }
    }

    doc.requirementQuality = { confirmed: confirmedCount, negated: negatedCount, uncertain: uncertainCount, raw: rawCount };
  }

  // stratified sampling: min(2, bucket_size) per type, total ≥ llmSampleRate of pool
  if (ollamaAvailable && samplePoolByType.size > 0) {
    const stratifiedSample: Array<{ docId: string; docType: string; heading: string; signals: SectionSignals }> = [];
    const totalPool = [...samplePoolByType.values()].reduce((s, a) => s + a.length, 0);
    const flatTarget = Math.max(1, Math.ceil(totalPool * CONFIG.llmSampleRate));

    for (const [, pool] of samplePoolByType) {
      const minFromBucket = Math.min(2, pool.length);
      const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, minFromBucket);
      stratifiedSample.push(...shuffled);
    }
    // If flat 10% target is larger, add more randomly
    if (stratifiedSample.length < flatTarget) {
      const allPool = [...samplePoolByType.values()].flat();
      const existing = new Set(stratifiedSample.map((s) => s.docId + s.heading));
      const extra = allPool
        .filter((s) => !existing.has(s.docId + s.heading))
        .sort(() => Math.random() - 0.5)
        .slice(0, flatTarget - stratifiedSample.length);
      stratifiedSample.push(...extra);
    }

    const validation = await validateWithLlm(stratifiedSample);
    state.llmValidation = {
      sampledDocIds: validation.sampledDocIds,
      regexVsLlmDelta: validation.regexVsLlmDelta,
      confidenceInterval: validation.confidenceInterval,
      byDocumentType: validation.byDocumentType,
      ...((validation.llmRecoveredCount ?? 0) > 0 ? { llmRecoveredCount: validation.llmRecoveredCount } : {}),
      ...((validation.llmRejectedCount ?? 0) > 0 ? { llmRejectedCount: validation.llmRejectedCount } : {}),
    };

    if (validation.regexVsLlmDelta > 0.2) {
      logger.warn("LLM validation: significant regex vs LLM divergence", {
        delta: (validation.regexVsLlmDelta * 100).toFixed(1) + "%",
        byType: validation.byDocumentType,
      });
    }
  }

  const byType = state.requirements.reduce((acc, r) => {
    acc[r.type] = (acc[r.type] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const safetyCount = state.requirements.filter((r) => r.isSafetyRelevant).length;

  logger.phaseEnd("7-requirements", t, {
    totalRequirements: state.requirements.length,
    byType,
    safetyFlagged: safetyCount,
    llmDelta: state.llmValidation.regexVsLlmDelta,
  });
}
