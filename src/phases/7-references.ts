import type { ScannerState, ExtractedReference } from "../state.ts";
import type { SectorProfile } from "../profiles/types.ts";
import { logger } from "../utils/logger.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { complete, parseJsonFromLlm } from "../llm/ollama.ts";
import { referenceNormalizationPrompt } from "../llm/prompts.ts";

const MAX_RAW_REF_LENGTH = 80; // hard cap on stored ref strings

function clampString(s: string): string {
  return s.slice(0, MAX_RAW_REF_LENGTH);
}

// Static lookup using profile's normCanonical table. Resolution order: static table → fuzzy match → LLM
function staticNormLookup(rawNorm: string, profile: SectorProfile): string | undefined {
  const normalized = rawNorm.trim();
  if (profile.normCanonical[normalized]) return profile.normCanonical[normalized];
  for (const [key, canonical] of Object.entries(profile.normCanonical)) {
    if (normalized.toLowerCase().startsWith(key.toLowerCase())) return canonical;
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

// "VDA 4.1" → { base: "VDA", version: "4.1" };  "ISO 9001:2015" → { base: "ISO 9001", version: "2015" }
function splitNormParts(normRef: string): { base: string; version: string | null } {
  // Year version: "ISO 9001:2015"
  const yearMatch = normRef.match(/^(.+?):\s*(\d{4})$/);
  if (yearMatch) return { base: yearMatch[1]!.trim(), version: yearMatch[2]! };
  // Numeric suffix after space: "VDA 4.1"
  const numSuffixMatch = normRef.match(/^([A-Za-z/\s]+)\s+(\d[\d.]*\d)$/);
  if (numSuffixMatch) return { base: numSuffixMatch[1]!.trim(), version: numSuffixMatch[2]! };
  return { base: normRef.trim(), version: null };
}

// Returns true only if norms could be the same — mismatched version parts are never a match
function normFuzzyMatch(a: string, b: string): boolean {
  const partA = splitNormParts(a);
  const partB = splitNormParts(b);
  // If both have versions and they differ → NOT a match
  if (partA.version && partB.version && partA.version !== partB.version) return false;
  // Fuzzy match on base parts only
  return editDistance(partA.base.toLowerCase(), partB.base.toLowerCase()) < 3;
}

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

// exclude norm prefixes from intraCorpusId results (ISO-xxx-yyy patterns are norms, not doc IDs)
const NORM_PREFIXES = new Set(["ISO", "DIN", "EN", "VDA", "IATF", "IEC"]);

function extractRawRefs(text: string, profile: SectorProfile): RawRefExtractions {
  const normPat = new RegExp(profile.normPattern.source, "gi");
  const entityMatches: Record<string, string[]> = {};
  if (profile.entityIdPatterns) {
    for (const { pattern, type } of profile.entityIdPatterns) {
      const pat = new RegExp(pattern.source, "gi");
      entityMatches[type] = findAllMatches(pat, text).map(clampString);
    }
  }
  return {
    norms: findAllMatches(normPat, text).map(clampString),
    qualitySpecs: entityMatches["quality_spec"] ?? [],
    fikbs: entityMatches["fikb"] ?? [],
    kbMasters: entityMatches["kb_master"] ?? [],
    chapterRefs: findAllMatches(PATTERNS.chapterRef, text).map(clampString),
    docRefs: findAllMatches(PATTERNS.docRef, text).map(clampString),
    versionMarkers: findAllMatches(PATTERNS.versionMarker, text).map(clampString),
    intraCorpusIds: findAllMatches(PATTERNS.intraCorpusId, text)
      .filter((m) => !NORM_PREFIXES.has((m.split("-")[0] ?? "").toUpperCase()))
      .map(clampString),
    requirementIds: findAllMatches(PATTERNS.requirementId, text).map(clampString),
  };
}

interface NormEntry {
  normalized: string;
  confidence: "certain" | "uncertain";
}

// Normalize norms — static lookup first ("certain"), LLM fallback ("uncertain")
async function normalizeLlm(
  rawNorms: string[],
  ollamaAvailable: boolean,
  profile: SectorProfile,
): Promise<Map<string, NormEntry>> {
  const normMap = new Map<string, NormEntry>();
  if (rawNorms.length === 0) return normMap;

  const unique = [...new Set(rawNorms)];

  // Step 1: Static lookup — high confidence
  const needsLlm: string[] = [];
  let staticHits = 0;
  for (const norm of unique) {
    const canonical = staticNormLookup(norm, profile);
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

  // Step 2: LLM for remaining norms — batched to avoid timeout
  if (!ollamaAvailable || needsLlm.length === 0) return normMap;

  const NORM_BATCH_SIZE = 20;
  let llmResolved = 0;
  for (let i = 0; i < needsLlm.length; i += NORM_BATCH_SIZE) {
    const batch = needsLlm.slice(i, i + NORM_BATCH_SIZE);
    try {
      const prompt = referenceNormalizationPrompt(batch);
      const response = await complete(prompt, { temperature: 0.0, maxTokens: 1000 });
      const parsed = parseJsonFromLlm<Record<string, string>>(response);
      for (const [orig, normalized] of Object.entries(parsed)) {
        if (typeof normalized === "string" && normalized.length <= MAX_RAW_REF_LENGTH) {
          normMap.set(orig, { normalized, confidence: "uncertain" });
          llmResolved++;
        }
      }
    } catch (e) {
      logger.warn("Norm normalization LLM batch failed, skipping batch", { batchStart: i, error: String(e) });
    }
  }
  logger.info("Norm LLM normalization completed", { sent: needsLlm.length, resolved: llmResolved });

  return normMap;
}

const EXTERNAL_NORM_TYPES = new Set<ExtractedReference["type"]>([
  "iso_norm", "din_norm", "en_norm", "vda_norm", "iatf_norm",
]);

const INTERNAL_REF_TYPES = new Set<ExtractedReference["type"]>([
  "doc_ref", "chapter_ref", "fikb", "kb_master",
]);

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

  for (const doc of allDocs) {
    if (doc.filename.toLowerCase().includes(searchText.toLowerCase())) {
      return { resolvedToDocId: doc.id, resolutionMethod: "exact" };
    }
  }

  // version-aware fuzzy match — pins numeric suffix to prevent VDA 4.1 ↔ VDA 4.2 false matches
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

  if (INTERNAL_REF_TYPES.has(refType)) {
    const resolutionClassification = classifyUnresolvedRef(rawText, allDocs);
    return { resolutionMethod: "unresolved", resolutionClassification };
  }

  return { resolutionMethod: "unresolved" };
}

export async function runReferences(state: ScannerState, ollamaAvailable: boolean): Promise<void> {
  const t = logger.phaseStart("6-references");

  const allRawNorms: string[] = [];
  const docRawRefs = new Map<string, RawRefExtractions>();

  for (const doc of state.parsed) {
    const text = doc.textContent ?? "";
    if (!text) continue;

    const refs = extractRawRefs(text, state.sectorProfile);
    docRawRefs.set(doc.id, refs);
    allRawNorms.push(...refs.norms, ...refs.qualitySpecs);
  }

  const normMap = await normalizeLlm(allRawNorms, ollamaAvailable, state.sectorProfile);
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
          ...(normEntry ? { normalizationConfidence: normEntry.confidence } : {}),
          resolutionMethod: resolution.resolutionMethod,
          ...(resolution.resolvedToDocId !== undefined ? { resolvedToDocId: resolution.resolvedToDocId } : {}),
          ...(resolution.resolutionClassification !== undefined ? { resolutionClassification: resolution.resolutionClassification } : {}),
        });
        if (resolution.resolvedToDocId) {
          graphMap.get(doc.id)!.push(resolution.resolvedToDocId);
        }
      }
    };

    const classifier = state.sectorProfile.classifyNormType ?? (() => "iso_norm" as const);
    const normsByType = new Map<ExtractedReference["type"], string[]>();
    for (const rawNorm of refs.norms) {
      const t = classifier(rawNorm);
      const arr = normsByType.get(t) ?? [];
      arr.push(rawNorm);
      normsByType.set(t, arr);
    }
    for (const [type, norms] of normsByType) {
      pushRef(type, norms);
    }
    pushRef("quality_spec", refs.qualitySpecs);
    pushRef("fikb", refs.fikbs);
    pushRef("kb_master", refs.kbMasters);
    pushRef("chapter_ref", refs.chapterRefs);
    pushRef("doc_ref", refs.docRefs);
    // intra-corpus document IDs (e.g. NOVA-SRS-001)
    pushRef("doc_ref", refs.intraCorpusIds);
    // requirement cross-reference IDs (e.g. REQ-001, ABW-042)
    pushRef("chapter_ref", refs.requirementIds);
  }

  state.referenceGraph = graphMap;

  const normUsageByProject = new Map<string, Set<string>>();
  for (const ref of state.references) {
    if (!["iso_norm", "din_norm", "en_norm", "vda_norm", "iatf_norm", "quality_spec"].includes(ref.type)) continue;
    const doc = allDocs.find((d) => d.id === ref.docId);
    const project = doc?.inferredProject ?? "unknown";
    const normKey = ref.normalized ?? ref.rawText;
    if (!normUsageByProject.has(project)) normUsageByProject.set(project, new Set());
    normUsageByProject.get(project)!.add(normKey);
  }

  const normProjectCount = new Map<string, number>();
  for (const [, norms] of normUsageByProject) {
    for (const norm of norms) {
      normProjectCount.set(norm, (normProjectCount.get(norm) ?? 0) + 1);
    }
  }
  const uniqueToOneProject = [...normProjectCount.entries()]
    .filter(([, count]) => count === 1)
    .map(([norm]) => norm)
    .slice(0, 20);

  const resolvedCount = state.references.filter((r) => r.resolutionMethod !== "unresolved").length;

  logger.phaseEnd("6-references", t, {
    totalRefs: state.references.length,
    resolved: resolvedCount,
    unresolved: state.references.length - resolvedCount,
    uniqueNorms: normProjectCount.size,
    normsUniqueToOneProject: uniqueToOneProject.length,
  });
}
