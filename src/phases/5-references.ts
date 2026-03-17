import { readFile } from "fs/promises";
import type { ScannerState, ExtractedReference } from "../state.ts";
import { logger } from "../utils/logger.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { complete, parseJsonFromLlm } from "../llm/ollama.ts";
import { referenceNormalizationPrompt } from "../llm/prompts.ts";

const MAX_RAW_REF_LENGTH = 80; // hard cap on stored ref strings

function clampString(s: string): string {
  return s.slice(0, MAX_RAW_REF_LENGTH);
}

// IMP-06: Static lookup table for common norms in automotive supplier docs
// GAP-10: Expanded with additional variants and aliases
// Resolution order: static table → fuzzy match → LLM
const AUTOMOTIVE_NORM_CANONICAL: Record<string, string> = {
  // ISO quality / management
  "ISO 9001": "ISO 9001:2015",
  "ISO 9001:2015": "ISO 9001:2015",
  "DIN EN ISO 9001": "ISO 9001:2015",
  "EN ISO 9001": "ISO 9001:2015",
  "ISO 14001": "ISO 14001:2015",
  "ISO 14001:2015": "ISO 14001:2015",
  "ISO 45001": "ISO 45001:2018",
  "ISO 45001:2018": "ISO 45001:2018",
  // Automotive IATF
  "IATF 16949": "IATF 16949:2016",
  "IATF 16949:2016": "IATF 16949:2016",
  "ISO/TS 16949": "IATF 16949:2016",
  "ISO TS 16949": "IATF 16949:2016",
  "TS 16949": "IATF 16949:2016",
  // Functional safety
  "ISO 26262": "ISO 26262:2018",
  "ISO 26262:2018": "ISO 26262:2018",
  "ISO 26262-2": "ISO 26262-2:2018",
  "IEC 61508": "IEC 61508:2010",
  "IEC 61508:2010": "IEC 61508:2010",
  "ISO/IEC 61508": "IEC 61508:2010",
  "ISO 13849": "ISO 13849-1:2015",
  "ISO 13849-1": "ISO 13849-1:2015",
  // VDA
  "VDA 6.3": "VDA 6.3:2016",
  "VDA 6.3:2016": "VDA 6.3:2016",
  "VDA 6.1": "VDA 6.1:2016",
  "VDA 6.5": "VDA 6.5:2012",
  "VDA 4": "VDA 4:2020",
  "VDA 4.1": "VDA 4.1",
  "VDA 4.2": "VDA 4.2",
  "VDA 2": "VDA 2:2020",
  "VDA 19": "VDA 19:2010",
  "VDA 19.1": "VDA 19.1:2010",
  // ASPICE
  "ASPICE": "Automotive SPICE PAM 3.1",
  "Automotive SPICE": "Automotive SPICE PAM 3.1",
  "A-SPICE": "Automotive SPICE PAM 3.1",
  // AIAG
  "AIAG FMEA": "AIAG & VDA FMEA Handbook 1st Edition",
  "AIAG MSA": "AIAG MSA 4th Edition",
  "AIAG APQP": "AIAG APQP 2nd Edition",
  "AIAG PPAP": "AIAG PPAP 4th Edition",
  // Material / testing
  "ISO 10204": "ISO 10204:2004",
  "DIN EN 10204": "ISO 10204:2004",
  "EN 10204": "ISO 10204:2004",
  "DIN EN 1090": "DIN EN 1090-2:2018",
  "ISO 1101": "ISO 1101:2017",
  "ISO 286": "ISO 286-1:2010",
  // Environmental
  "REACH": "REACH Regulation (EC) 1907/2006",
  "RoHS": "RoHS Directive 2011/65/EU",
};

function staticNormLookup(rawNorm: string): string | undefined {
  const normalized = rawNorm.trim();
  // Exact match
  if (AUTOMOTIVE_NORM_CANONICAL[normalized]) return AUTOMOTIVE_NORM_CANONICAL[normalized];
  // Match by base part (strip trailing colon+year variants from lookup key)
  for (const [key, canonical] of Object.entries(AUTOMOTIVE_NORM_CANONICAL)) {
    if (normalized.toLowerCase().startsWith(key.toLowerCase())) {
      return canonical;
    }
  }
  return undefined;
}

// Levenshtein edit distance (for fuzzy matching)
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[m]![n]!;
}

// IMP-06: Extract base and version parts from a norm reference
// "VDA 4.1" → { base: "VDA", version: "4.1" }
// "ISO 9001:2015" → { base: "ISO 9001", version: "2015" }
function splitNormParts(normRef: string): { base: string; version: string | null } {
  // Year version: "ISO 9001:2015"
  const yearMatch = normRef.match(/^(.+?):\s*(\d{4})$/);
  if (yearMatch) return { base: yearMatch[1]!.trim(), version: yearMatch[2]! };
  // Numeric suffix after space: "VDA 4.1"
  const numSuffixMatch = normRef.match(/^([A-Za-z/\s]+)\s+(\d[\d.]*\d)$/);
  if (numSuffixMatch) return { base: numSuffixMatch[1]!.trim(), version: numSuffixMatch[2]! };
  return { base: normRef.trim(), version: null };
}

// IMP-06: Fuzzy match with version pinning
// Returns true only if norms could be the same (version parts must match or one must be absent)
function normFuzzyMatch(a: string, b: string): boolean {
  const partA = splitNormParts(a);
  const partB = splitNormParts(b);
  // If both have versions and they differ → NOT a match
  if (partA.version && partB.version && partA.version !== partB.version) return false;
  // Fuzzy match on base parts only
  return editDistance(partA.base.toLowerCase(), partB.base.toLowerCase()) < 3;
}

// Extract references from text (ephemeral)
interface RawRefExtractions {
  norms: string[];
  qualitySpecs: string[];
  fikbs: string[];
  kbMasters: string[];
  chapterRefs: string[];
  docRefs: string[];
  versionMarkers: string[];
  intraCorpusIds: string[];  // P1: e.g. NOVA-SRS-001
  requirementIds: string[];  // P1: e.g. REQ-001, ABW-042
}

// P1: norm prefixes — exclude from intraCorpusId results (ISO-xxx-yyy patterns are norms, not doc IDs)
const NORM_PREFIXES = new Set(["ISO", "DIN", "EN", "VDA", "IATF", "IEC"]);

function extractRawRefs(text: string): RawRefExtractions {
  return {
    norms: findAllMatches(PATTERNS.norm, text).map(clampString),
    qualitySpecs: findAllMatches(PATTERNS.qualitySpec, text).map(clampString),
    fikbs: findAllMatches(PATTERNS.fikb, text).map(clampString),
    kbMasters: findAllMatches(PATTERNS.kbMaster, text).map(clampString),
    chapterRefs: findAllMatches(PATTERNS.chapterRef, text).map(clampString),
    docRefs: findAllMatches(PATTERNS.docRef, text).map(clampString),
    versionMarkers: findAllMatches(PATTERNS.versionMarker, text).map(clampString),
    intraCorpusIds: findAllMatches(PATTERNS.intraCorpusId, text)
      .filter((m) => !NORM_PREFIXES.has((m.split("-")[0] ?? "").toUpperCase()))
      .map(clampString),
    requirementIds: findAllMatches(PATTERNS.requirementId, text).map(clampString),
  };
}

function getCurrentHeading(text: string, matchIndex: number, headings: string[]): string {
  // Return the nearest heading name — we use the doc's heading list as context
  return headings.length > 0 ? (headings[0] ?? "unknown") : "unknown";
}

// GAP-10: Norm normalization result with confidence tracking
interface NormEntry {
  normalized: string;
  confidence: "certain" | "uncertain";
}

// IMP-06: Normalize raw norm strings — static lookup first, then LLM
// GAP-10: Returns confidence: "certain" for static hits, "uncertain" for LLM hits
async function normalizeLlm(rawNorms: string[], ollamaAvailable: boolean): Promise<Map<string, NormEntry>> {
  const normMap = new Map<string, NormEntry>();
  if (rawNorms.length === 0) return normMap;

  const unique = [...new Set(rawNorms)];

  // Step 1: Static lookup — high confidence
  const needsLlm: string[] = [];
  let staticHits = 0;
  for (const norm of unique) {
    const canonical = staticNormLookup(norm);
    if (canonical) {
      normMap.set(norm, { normalized: canonical, confidence: "certain" });
      staticHits++;
    } else {
      needsLlm.push(norm);
    }
  }

  if (staticHits > 0) {
    logger.info("Norm static lookup", { staticHits, remaining: needsLlm.length });
  }

  // Step 2: LLM for remaining norms — uncertain confidence
  if (!ollamaAvailable || needsLlm.length === 0) return normMap;

  try {
    const prompt = referenceNormalizationPrompt(needsLlm);
    const response = await complete(prompt, { temperature: 0.0, maxTokens: 2000 });
    const parsed = parseJsonFromLlm<Record<string, string>>(response);
    for (const [orig, normalized] of Object.entries(parsed)) {
      if (typeof normalized === "string" && normalized.length <= MAX_RAW_REF_LENGTH) {
        normMap.set(orig, { normalized, confidence: "uncertain" });
      }
    }
    logger.info("Norm LLM normalization completed", { sent: needsLlm.length, resolved: normMap.size - staticHits });
  } catch (e) {
    logger.warn("Norm normalization LLM call failed, skipping", { error: String(e) });
  }

  return normMap;
}

const EXTERNAL_NORM_TYPES = new Set<ExtractedReference["type"]>([
  "iso_norm", "din_norm", "en_norm", "vda_norm", "iatf_norm",
]);

const INTERNAL_REF_TYPES = new Set<ExtractedReference["type"]>([
  "doc_ref", "chapter_ref", "fikb", "kb_master",
]);

// GAP-04: Classify why an internal reference could not be resolved
function classifyUnresolvedRef(
  rawText: string,
  allDocs: ScannerState["parsed"]
): ExtractedReference["resolutionClassification"] {
  const needle = rawText.toLowerCase();
  // If any doc filename has moderate similarity → matcher failure, not missing corpus entry
  for (const doc of allDocs) {
    const haystack = doc.filename.toLowerCase();
    // Partial token overlap (any significant word from rawText appears in filename)
    const words = needle.split(/[-_\s]+/).filter((w) => w.length > 2);
    if (words.some((w) => haystack.includes(w))) {
      return "likely_matcher_failure";
    }
    // Edit distance on short refs (< 20 chars)
    if (needle.length < 20 && editDistance(haystack.slice(0, 30), needle) < 6) {
      return "likely_matcher_failure";
    }
  }
  // No overlap found — ref targets something not in the corpus
  return "likely_missing_from_corpus";
}

// Try to resolve a norm string to another document in the corpus
// Returns resolutionMethod and optional GAP-04 classification for unresolved internal refs
function resolveReference(
  rawText: string,
  normalized: string | undefined,
  refType: ExtractedReference["type"],
  allDocs: ScannerState["parsed"]
): {
  resolvedToDocId?: string;
  resolutionMethod: NonNullable<ExtractedReference["resolutionMethod"]>;
  resolutionClassification?: ExtractedReference["resolutionClassification"];
} {
  const searchText = normalized ?? rawText;

  // Exact match on filename
  for (const doc of allDocs) {
    if (doc.filename.toLowerCase().includes(searchText.toLowerCase())) {
      return { resolvedToDocId: doc.id, resolutionMethod: "exact" };
    }
  }

  // IMP-06: Version-aware fuzzy match — pins numeric suffix to prevent VDA 4.1 ↔ VDA 4.2 false matches
  for (const doc of allDocs) {
    if (normFuzzyMatch(doc.filename.toLowerCase(), searchText.toLowerCase())) {
      return { resolvedToDocId: doc.id, resolutionMethod: "fuzzy" };
    }
  }

  // External norms (ISO, VDA, DIN, EN, IATF) will never resolve to corpus docs —
  // classify separately so they don't pollute the referenceResolutionRate metric.
  if (EXTERNAL_NORM_TYPES.has(refType)) {
    return { resolutionMethod: "external_norm" };
  }

  // GAP-04: Classify unresolved internal references
  if (INTERNAL_REF_TYPES.has(refType)) {
    const resolutionClassification = classifyUnresolvedRef(rawText, allDocs);
    return { resolutionMethod: "unresolved", resolutionClassification };
  }

  return { resolutionMethod: "unresolved" };
}

export async function runReferences(state: ScannerState, ollamaAvailable: boolean): Promise<void> {
  const t = logger.phaseStart("5-references");

  const allRawNorms: string[] = [];
  const docRawRefs = new Map<string, RawRefExtractions>();

  // Read each doc's text ephemerally
  for (const doc of state.parsed) {
    let text = "";
    try {
      const buf = await readFile(doc.absolutePath);
      text = buf.toString("utf-8", 0, Math.min(buf.length, 1_000_000));
    } catch {
      continue;
    }

    const refs = extractRawRefs(text);
    docRawRefs.set(doc.id, refs);
    allRawNorms.push(...refs.norms, ...refs.qualitySpecs);
  }

  // Normalize norms with single LLM call
  const normMap = await normalizeLlm(allRawNorms, ollamaAvailable);

  // Build ExtractedReference entries and reference graph
  const allDocs = state.parsed;
  const graphMap = new Map<string, string[]>();

  for (const doc of state.parsed) {
    const refs = docRawRefs.get(doc.id);
    if (!refs) continue;
    graphMap.set(doc.id, []);

    const headingTexts = doc.headings.map((h) => h.text);
    const primaryHeading = headingTexts[0] ?? "unknown";

    const pushRef = (
      type: ExtractedReference["type"],
      rawTexts: string[]
    ) => {
      for (const rawText of [...new Set(rawTexts)]) {
        const normEntry = normMap.get(rawText);
        const resolution = resolveReference(rawText, normEntry?.normalized, type, allDocs);
        state.references.push({
          docId: doc.id,
          type,
          rawText,
          ...(normEntry ? { normalized: normEntry.normalized } : {}),
          sectionContext: clampString(primaryHeading),
          ...(normEntry ? { normalizationConfidence: normEntry.confidence } : {}), // GAP-10
          resolutionMethod: resolution.resolutionMethod,
          ...(resolution.resolvedToDocId !== undefined ? { resolvedToDocId: resolution.resolvedToDocId } : {}),
          ...(resolution.resolutionClassification !== undefined ? { resolutionClassification: resolution.resolutionClassification } : {}), // GAP-04
        });
        if (resolution.resolvedToDocId) {
          graphMap.get(doc.id)!.push(resolution.resolvedToDocId);
        }
      }
    };

    pushRef("iso_norm", refs.norms.filter((n) => /^\s*ISO/i.test(n)));
    pushRef("din_norm", refs.norms.filter((n) => /^\s*DIN/i.test(n)));
    pushRef("en_norm", refs.norms.filter((n) => /^\s*EN/i.test(n)));
    pushRef("vda_norm", refs.norms.filter((n) => /^\s*VDA/i.test(n)));
    pushRef("iatf_norm", refs.norms.filter((n) => /^\s*IATF/i.test(n)));
    pushRef("quality_spec", refs.qualitySpecs);
    pushRef("fikb", refs.fikbs);
    pushRef("kb_master", refs.kbMasters);
    pushRef("chapter_ref", refs.chapterRefs);
    pushRef("doc_ref", refs.docRefs);
    // P1: intra-corpus document IDs (e.g. NOVA-SRS-001) → "doc_ref" type
    pushRef("doc_ref", refs.intraCorpusIds);
    // P1: requirement cross-reference IDs (e.g. REQ-001, ABW-042) → "chapter_ref" type
    pushRef("chapter_ref", refs.requirementIds);
  }

  state.referenceGraph = graphMap;

  // Cross-project norm tracking
  const normUsageByProject = new Map<string, Set<string>>();
  for (const ref of state.references) {
    if (!["iso_norm", "din_norm", "en_norm", "vda_norm", "iatf_norm", "quality_spec"].includes(ref.type)) continue;
    const doc = allDocs.find((d) => d.id === ref.docId);
    const project = doc?.inferredProject ?? "unknown";
    const normKey = ref.normalized ?? ref.rawText;
    if (!normUsageByProject.has(project)) normUsageByProject.set(project, new Set());
    normUsageByProject.get(project)!.add(normKey);
  }

  // Log norms appearing in only one project (potentially new/unique)
  const normProjectCount = new Map<string, number>();
  for (const [, norms] of normUsageByProject) {
    for (const norm of norms) {
      normProjectCount.set(norm, (normProjectCount.get(norm) ?? 0) + 1);
    }
  }
  const uniqueToOneProject = [...normProjectCount.entries()]
    .filter(([, count]) => count === 1)
    .map(([norm]) => norm)
    .slice(0, 20); // cap for logging

  const resolvedCount = state.references.filter((r) => r.resolutionMethod !== "unresolved").length;

  logger.phaseEnd("5-references", t, {
    totalRefs: state.references.length,
    resolved: resolvedCount,
    unresolved: state.references.length - resolvedCount,
    uniqueNorms: normProjectCount.size,
    normsUniqueToOneProject: uniqueToOneProject.length,
  });
}
