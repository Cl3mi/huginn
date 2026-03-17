import { readFile } from "fs/promises";
import type { ScannerState, ExtractedRequirement, ParsedDocument } from "../state.ts";
import { logger } from "../utils/logger.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { complete, parseJsonFromLlm } from "../llm/ollama.ts";
import { requirementValidationPrompt } from "../llm/prompts.ts";
import { truncateToTokens } from "../utils/tokenizer.ts";

type RequirementType = ExtractedRequirement["type"];
type RequirementCategory = ExtractedRequirement["category"];

interface LlmRequirement {
  type: RequirementType;
  category: RequirementCategory;
  has_quantitative_value: boolean;
}

function classifyType(text: string): RequirementType {
  if (PATTERNS.muss.test(text)) { PATTERNS.muss.lastIndex = 0; return "MUSS"; }
  PATTERNS.muss.lastIndex = 0;
  if (PATTERNS.soll.test(text)) { PATTERNS.soll.lastIndex = 0; return "SOLL"; }
  PATTERNS.soll.lastIndex = 0;
  if (PATTERNS.kann.test(text)) { PATTERNS.kann.lastIndex = 0; return "KANN"; }
  PATTERNS.kann.lastIndex = 0;
  // GAP-01: Declarative requirements — numeric specs without modal verbs
  if (PATTERNS.declarative.test(text)) { PATTERNS.declarative.lastIndex = 0; return "DEKLARATIV"; }
  PATTERNS.declarative.lastIndex = 0;
  return "INFORMATIV";
}

function classifyCategory(text: string): RequirementCategory {
  const lower = text.toLowerCase();
  if (PATTERNS.safetyKeywords.test(text)) { PATTERNS.safetyKeywords.lastIndex = 0; return "Sicherheit"; }
  PATTERNS.safetyKeywords.lastIndex = 0;
  if (PATTERNS.materialKeywords.test(text)) { PATTERNS.materialKeywords.lastIndex = 0; return "Material"; }
  PATTERNS.materialKeywords.lastIndex = 0;
  if (PATTERNS.toleranceKeywords.test(text)) { PATTERNS.toleranceKeywords.lastIndex = 0; return "Toleranz"; }
  PATTERNS.toleranceKeywords.lastIndex = 0;
  if (PATTERNS.testingKeywords.test(text)) { PATTERNS.testingKeywords.lastIndex = 0; return "Prüfung"; }
  PATTERNS.testingKeywords.lastIndex = 0;
  if (PATTERNS.packagingKeywords.test(text)) { PATTERNS.packagingKeywords.lastIndex = 0; return "Verpackung"; }
  PATTERNS.packagingKeywords.lastIndex = 0;
  if (PATTERNS.deliveryKeywords.test(text)) { PATTERNS.deliveryKeywords.lastIndex = 0; return "Lieferung"; }
  PATTERNS.deliveryKeywords.lastIndex = 0;
  return "Sonstiges";
}

function isSafetyRelevant(text: string): boolean {
  const result = PATTERNS.safetyKeywords.test(text);
  PATTERNS.safetyKeywords.lastIndex = 0;
  return result;
}

function extractQuantitativeValueSummary(text: string): string | undefined {
  const matches = findAllMatches(PATTERNS.quantitativeValue, text);
  if (matches.length === 0) return undefined;
  return matches.slice(0, 3).join(", ").slice(0, 60); // hard cap
}

function extractLinkedFikb(text: string): string | undefined {
  const fikbs = findAllMatches(PATTERNS.fikb, text);
  const kbs = findAllMatches(PATTERNS.kbMaster, text);
  const all = [...fikbs, ...kbs];
  return all.length > 0 ? all[0]!.slice(0, 30) : undefined;
}

// IMP-07: Requirement pre-filters result
interface RequirementFilterResult {
  confirmed: boolean;
  negated: boolean;
  uncertain: boolean;
}

// IMP-07: Three pre-filters that a sentence must pass to be counted as a confirmed requirement
function applyRequirementFilters(sentence: string): RequirementFilterResult {
  // Filter 1 — Negation exclusion
  const negated = /nicht\s+muss|muss\s+nicht|nicht\s+soll|soll\s+nicht/i.test(sentence);
  if (negated) return { confirmed: false, negated: true, uncertain: false };

  // Filter 2 — Subject plausibility: needs a subject noun, technical abbreviation, or compound noun
  const hasGermanSubject = /^(?:Die|Das|Der|Ein|Eine|Alle|Jede[rs]?)\s+[A-ZÄÖÜ]/.test(sentence.trim());
  // P1: English articles + lowercase noun
  const hasEnglishSubject = /^(?:The|A|An|All|Each|Every)\s+[a-zA-Z]/.test(sentence.trim());
  // P1: Capital start + requirement verb — handles "Supplier shall...", "BMS must..."
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

// Split text into sections by headings
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

// IMP-04: LLM validation with stratified sampling and per-doc-type stats
async function validateWithLlm(
  sampledSections: Array<{ docId: string; docType: string; heading: string; text: string }>,
  regexCountsByDoc: Map<string, number>
): Promise<{
  regexVsLlmDelta: number;
  confidenceInterval: { lower: number; upper: number };
  sampledDocIds: string[];
  byDocumentType: Record<string, { sampled: number; avgDelta: number }>;
  llmRecoveredCount: number;
  llmRejectedCount: number;
}> {
  let totalRegex = 0;
  let totalLlm = 0;
  const sampledDocIds: string[] = [];
  // Per doc-type tracking
  const typeStats = new Map<string, { regex: number; llm: number; count: number }>();

  for (const { docId, docType, heading, text } of sampledSections) {
    sampledDocIds.push(docId);
    const truncated = truncateToTokens(text, 800);

    let llmCount = 0;
    try {
      const prompt = requirementValidationPrompt(truncated);
      const response = await complete(prompt, { temperature: 0.0, maxTokens: 1000 });
      const items = parseJsonFromLlm<LlmRequirement[]>(response);
      llmCount = Array.isArray(items) ? items.length : 0;
    } catch (e) {
      logger.warn("LLM validation failed for section", { docId, heading, error: String(e) });
      continue;
    }

    const regexCount = regexCountsByDoc.get(docId) ?? 0;
    totalRegex += regexCount;
    totalLlm += llmCount;

    if (!typeStats.has(docType)) typeStats.set(docType, { regex: 0, llm: 0, count: 0 });
    const ts = typeStats.get(docType)!;
    ts.regex += regexCount;
    ts.llm += llmCount;
    ts.count++;
  }

  const delta = totalRegex + totalLlm > 0
    ? Math.abs(totalRegex - totalLlm) / Math.max(totalRegex, totalLlm)
    : 0;

  const n = sampledSections.length;
  const margin = n > 0 ? 1.96 * Math.sqrt((delta * (1 - delta)) / n) : 0.5;

  const byDocumentType: Record<string, { sampled: number; avgDelta: number }> = {};
  for (const [type, { regex, llm, count }] of typeStats) {
    const typeDelta = regex + llm > 0 ? Math.abs(regex - llm) / Math.max(regex, llm) : 0;
    byDocumentType[type] = { sampled: count, avgDelta: typeDelta };
  }

  // GAP-09: Aggregate recovery/rejection counts
  const llmRecoveredCount = Math.max(0, totalLlm - totalRegex);
  const llmRejectedCount = Math.max(0, totalRegex - totalLlm);

  return {
    regexVsLlmDelta: delta,
    confidenceInterval: {
      lower: Math.max(0, delta - margin),
      upper: Math.min(1, delta + margin),
    },
    sampledDocIds: [...new Set(sampledDocIds)],
    byDocumentType,
    llmRecoveredCount,
    llmRejectedCount,
  };
}

export async function runRequirements(state: ScannerState, ollamaAvailable: boolean): Promise<void> {
  const t = logger.phaseStart("6-requirements");

  const regexCountsByDoc = new Map<string, number>();
  // IMP-04: Stratified sample pool — keyed by docType
  const samplePoolByType = new Map<string, Array<{ docId: string; docType: string; heading: string; text: string }>>();

  for (const doc of state.parsed) {
    let fullText = "";
    try {
      const buf = await readFile(doc.absolutePath);
      fullText = buf.toString("utf-8", 0, Math.min(buf.length, 2_000_000));
    } catch {
      continue;
    }

    const sections = splitIntoSections(doc, fullText);
    let rawCount = 0;
    let confirmedCount = 0;
    let negatedCount = 0;
    let uncertainCount = 0;
    const docType = doc.detectedDocType ?? "other";

    for (const section of sections) {
      const type = classifyType(section.text);
      if (type === "INFORMATIV") continue; // INFORMATIV sections skipped from requirement counting

      rawCount++;

      // IMP-07: Apply three pre-filters per sentence
      // Split section into sentences and find requirement-triggering sentence
      const sentences = section.text.split(/(?<=[.!?])\s+|(?<=[.!?])$/);
      let reqSentence: string;
      if (type === "DEKLARATIV") {
        // GAP-01: find sentence with declarative verb (no modal verb present)
        reqSentence = sentences.find((s) => {
          const result = PATTERNS.declarative.test(s.trim());
          PATTERNS.declarative.lastIndex = 0;
          return result;
        }) ?? section.text;
      } else {
        reqSentence = sentences.find((s) => {
          const trimmed = s.trim();
          return PATTERNS.muss.test(trimmed) || PATTERNS.soll.test(trimmed) || PATTERNS.kann.test(trimmed);
        }) ?? section.text;
        PATTERNS.muss.lastIndex = 0;
        PATTERNS.soll.lastIndex = 0;
        PATTERNS.kann.lastIndex = 0;
      }

      const filterResult = applyRequirementFilters(reqSentence);
      if (filterResult.negated) { negatedCount++; continue; }
      if (filterResult.uncertain) { uncertainCount++; continue; }

      // Confirmed requirement — only push to state.requirements for reliable doc types
      // (planning docs, trackers, meeting minutes produce structural false positives)
      confirmedCount++;
      if (!doc.requirementMetadataReliable) continue;
      const category = classifyCategory(section.text);
      const safety = isSafetyRelevant(section.text);
      const quantMatches = findAllMatches(PATTERNS.quantitativeValue, section.text);
      const hasQuantitative = quantMatches.length > 0;
      const quantSummary = extractQuantitativeValueSummary(section.text);
      const linkedFikb = extractLinkedFikb(section.text);
      const normMatches = findAllMatches(PATTERNS.norm, section.text);
      const linkedNorm = normMatches[0]?.slice(0, 30);

      state.requirements.push({
        docId: doc.id,
        sectionHeading: section.heading.slice(0, 120),
        type,
        category,
        hasQuantitativeValue: hasQuantitative,
        ...(quantSummary ? { quantitativeValueSummary: quantSummary } : {}),
        ...(linkedNorm ? { linkedNorm } : {}),
        ...(linkedFikb ? { linkedFikb } : {}),
        isSafetyRelevant: safety,
        source: "regex" as const, // GAP-09: track origin of requirement
      });

      // Collect samples for LLM validation
      if (section.text.length > 200) {
        if (!samplePoolByType.has(docType)) samplePoolByType.set(docType, []);
        const pool = samplePoolByType.get(docType)!;
        if (pool.length < 50) { // cap per type
          pool.push({ docId: doc.id, docType, heading: section.heading, text: section.text });
        }
      }
    }

    regexCountsByDoc.set(doc.id, rawCount);

    // IMP-07: Store requirement quality counters on the doc
    doc.requirementQuality = { confirmed: confirmedCount, negated: negatedCount, uncertain: uncertainCount, raw: rawCount };
  }

  // IMP-04: Stratified sampling — min(2, count_in_bucket) per type, total = max(10%, sum of mins)
  if (ollamaAvailable && samplePoolByType.size > 0) {
    const stratifiedSample: Array<{ docId: string; docType: string; heading: string; text: string }> = [];
    const totalPool = [...samplePoolByType.values()].reduce((s, a) => s + a.length, 0);
    const flatTarget = Math.max(1, Math.ceil(totalPool * 0.10));

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

    const validation = await validateWithLlm(stratifiedSample, regexCountsByDoc);
    state.llmValidation = {
      sampledDocIds: validation.sampledDocIds,
      regexVsLlmDelta: validation.regexVsLlmDelta,
      confidenceInterval: validation.confidenceInterval,
      byDocumentType: validation.byDocumentType,
      // GAP-09: track LLM recovery/rejection for report
      ...(validation.llmRecoveredCount > 0 ? { llmRecoveredCount: validation.llmRecoveredCount } : {}),
      ...(validation.llmRejectedCount > 0 ? { llmRejectedCount: validation.llmRejectedCount } : {}),
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

  logger.phaseEnd("6-requirements", t, {
    totalRequirements: state.requirements.length,
    byType,
    safetyFlagged: safetyCount,
    llmDelta: state.llmValidation.regexVsLlmDelta,
  });
}
