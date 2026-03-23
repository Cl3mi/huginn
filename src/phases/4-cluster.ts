import type { ScannerState, VersionPair, ParsedDocument, DocumentFingerprint, ExtractedReference } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { jaccardFromMinHash, cosineSimilarity } from "../utils/minhash.ts";

function normalizeFilename(filename: string): string {
  return filename
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[_\-.\s]+/g, " ")
    .replace(/v?\d+(\.\d+)*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function filenameSimilarity(a: string, b: string): number {
  const na = normalizeFilename(a);
  const nb = normalizeFilename(b);
  if (na === nb) return 1.0;
  // Simple character trigram overlap
  const trigramsA = new Set(trigrams(na));
  const trigramsB = new Set(trigrams(nb));
  const intersection = [...trigramsA].filter((t) => trigramsB.has(t)).length;
  const union = new Set([...trigramsA, ...trigramsB]).size;
  return union === 0 ? 0 : intersection / union;
}

function trigrams(s: string): string[] {
  const result: string[] = [];
  for (let i = 0; i < s.length - 2; i++) {
    result.push(s.slice(i, i + 3));
  }
  return result;
}

function structuralMatch(fpA: DocumentFingerprint, fpB: DocumentFingerprint): boolean {
  const a = fpA.structural;
  const b = fpB.structural;
  if (a.hasNumberedHeadings !== b.hasNumberedHeadings) return false;

  // zero-heading docs have no structure to compare — never match
  const totalA = a.h1Count + a.h2Count + a.h3Count + a.h4PlusCount;
  const totalB = b.h1Count + b.h2Count + b.h3Count + b.h4PlusCount;
  if (totalA === 0 || totalB === 0) return false;

  // Heading counts must be within 40% of each other
  const h2ratio = safeDivRatio(a.h2Count, b.h2Count);
  const totalRatio = safeDivRatio(totalA, totalB);

  return h2ratio >= 0.6 && totalRatio >= 0.6;
}

function safeDivRatio(a: number, b: number): number {
  if (a === 0 && b === 0) return 1.0;
  if (a === 0 || b === 0) return 0.0;
  return Math.min(a, b) / Math.max(a, b);
}

function daysDelta(dateA: Date, dateB: Date): number {
  return Math.abs(dateA.getTime() - dateB.getTime()) / (1000 * 60 * 60 * 24);
}

function sameDirectory(pathA: string, pathB: string): boolean {
  const dirA = pathA.split("/").slice(0, -1).join("/");
  const dirB = pathB.split("/").slice(0, -1).join("/");
  return dirA === dirB;
}

function scoreVersionPair(
  docA: ParsedDocument,
  docB: ParsedDocument,
  fpA: DocumentFingerprint,
  fpB: DocumentFingerprint,
  fikbsA: Set<string>,
  fikbsB: Set<string>
): VersionPair {
  const fnSim = filenameSimilarity(docA.filename, docB.filename);
  const structMatch = structuralMatch(fpA, fpB);
  const mhJaccard = jaccardFromMinHash(fpA.headingMinHash, fpB.headingMinHash);
  const semanticSim =
    fpA.semanticEmbedding && fpB.semanticEmbedding
      ? cosineSimilarity(fpA.semanticEmbedding, fpB.semanticEmbedding)
      : 0;
  const samedir = sameDirectory(docA.path, docB.path);
  const deltaDays = daysDelta(new Date(docA.dateSignals.bestDate), new Date(docB.dateSignals.bestDate));

  // Scoring matrix (0-12 points)
  let score = 0;
  score += fnSim >= 0.8 ? 2 : fnSim >= 0.5 ? 1 : 0;               // filename: 0-2
  score += structMatch ? 2 : 0;                                       // structural: 0-2
  score += mhJaccard >= 0.7 ? 3 : mhJaccard >= 0.4 ? 2 : mhJaccard >= 0.2 ? 1 : 0; // minhash: 0-3
  score += semanticSim >= 0.85 ? 3 : semanticSim >= 0.7 ? 2 : semanticSim >= 0.5 ? 1 : 0; // semantic: 0-3
  score += samedir ? 1 : 0;                                           // same dir: 0-1
  // date delta contributes 0 points if both docs rely on unreliable mtime
  const dateBothMtime = docA.dateSource === "mtime" && docB.dateSource === "mtime";
  score += !dateBothMtime && deltaDays <= 365 ? 1 : 0;              // date delta: 0-1

  // template reuse penalty: same type + same OEM + disjoint FIKB sets → -3
  let versionPairFlag: VersionPair["versionPairFlag"];
  const sameDocType = docA.detectedDocType && docB.detectedDocType && docA.detectedDocType === docB.detectedDocType;
  const sameOem = docA.detectedOem && docB.detectedOem && docA.detectedOem === docB.detectedOem && docA.detectedOem !== "unknown";
  const fikbsDisjoint = fikbsA.size > 0 && fikbsB.size > 0 &&
    [...fikbsA].every((f) => !fikbsB.has(f));
  if (sameDocType && sameOem && fikbsDisjoint) {
    score = Math.max(0, score - 3);
    versionPairFlag = "template_reuse_suspected";
  }

  let confidence: VersionPair["confidence"];
  if (score >= CONFIG.versionPairMinScore) confidence = "HIGH";
  else if (score >= 5) confidence = "MEDIUM";
  else if (score >= 3) confidence = "LOW";
  else confidence = "NOT_A_PAIR";

  let likelyNewer: VersionPair["likelyNewer"] = "UNKNOWN";
  if (!dateBothMtime && deltaDays > 1) {
    likelyNewer = new Date(docA.dateSignals.bestDate) > new Date(docB.dateSignals.bestDate) ? "A" : "B";
  } else {
    // Fallback: more requirement density = likely newer
    const densA = fpA.requirementDensity.mussPerPage + fpA.requirementDensity.sollPerPage;
    const densB = fpB.requirementDensity.mussPerPage + fpB.requirementDensity.sollPerPage;
    if (Math.abs(densA - densB) > 0.5) likelyNewer = densA > densB ? "A" : "B";
  }

  return {
    docA: docA.id,
    docB: docB.id,
    signals: {
      filenameNormalizedSimilarity: fnSim,
      structuralMatch: structMatch,
      headingMinHashJaccard: mhJaccard,
      semanticCosineSimilarity: semanticSim,
      sameDirectory: samedir,
      modifiedDateDeltaDays: deltaDays,
    },
    score,
    confidence,
    likelyNewer,
    ...(versionPairFlag ? { versionPairFlag } : {}),
  };
}

function buildVersionChains(pairs: VersionPair[], docs: ParsedDocument[]): string[][] {
  const adj = new Map<string, Set<string>>();
  for (const pair of pairs) {
    if (pair.confidence !== "HIGH") continue;
    if (!adj.has(pair.docA)) adj.set(pair.docA, new Set());
    if (!adj.has(pair.docB)) adj.set(pair.docB, new Set());
    adj.get(pair.docA)!.add(pair.docB);
    adj.get(pair.docB)!.add(pair.docA);
  }

  const visited = new Set<string>();
  const chains: string[][] = [];

  for (const [docId] of adj) {
    if (visited.has(docId)) continue;
    // BFS to collect connected component
    const component: string[] = [];
    const queue = [docId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (visited.has(curr)) continue;
      visited.add(curr);
      component.push(curr);
      for (const neighbor of (adj.get(curr) ?? [])) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }

    if (component.length > 1) {
      // Sort by modified date (ascending = oldest first)
        // guard against NaN from invalid date strings
      const sorted = component.sort((a, b) => {
        const docA = docs.find((d) => d.id === a);
        const docB = docs.find((d) => d.id === b);
        if (!docA || !docB) return 0;
        const timeA = new Date(docA.dateSignals.bestDate).getTime();
        const timeB = new Date(docB.dateSignals.bestDate).getTime();
        if (isNaN(timeA) || isNaN(timeB)) return 0;
        return timeA - timeB;
      });
      chains.push(sorted);
    }
  }

  return chains;
}

export async function runCluster(state: ScannerState): Promise<void> {
  const t = logger.phaseStart("4-cluster");

  // exclude empty/failed docs — zero-valued fingerprints produce spurious HIGH pairs
  const docs = state.parsed.filter((d) => d.parseSuccess && d.charCount >= 200);
  const fps = state.fingerprints;
  const n = docs.length;

  const docFikbSets = new Map<string, Set<string>>();
  for (const ref of state.references) {
    if (ref.type === "fikb" || ref.type === "kb_master") {
      if (!docFikbSets.has(ref.docId)) docFikbSets.set(ref.docId, new Set());
      docFikbSets.get(ref.docId)!.add(ref.rawText);
    }
  }

  let pairsEvaluated = 0;
  let highConfidencePairs = 0;

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const docA = docs[i]!;
      const docB = docs[j]!;
      const fpA = fps.find((f) => f.docId === docA.id);
      const fpB = fps.find((f) => f.docId === docB.id);
      if (!fpA || !fpB) continue;

      // Pre-filter: only score pairs with same extension OR same inferred customer
      const sameExt = docA.extension === docB.extension;
      const sameCustomer =
        docA.inferredCustomer &&
        docB.inferredCustomer &&
        docA.inferredCustomer === docB.inferredCustomer;
      const structSim = safeDivRatio(
        fpA.structural.h1Count + fpA.structural.h2Count,
        fpB.structural.h1Count + fpB.structural.h2Count
      );

      if (!sameExt && !sameCustomer && structSim < 0.4) continue;

      pairsEvaluated++;
      const fikbsA = docFikbSets.get(docA.id) ?? new Set<string>();
      const fikbsB = docFikbSets.get(docB.id) ?? new Set<string>();
      const pair = scoreVersionPair(docA, docB, fpA, fpB, fikbsA, fikbsB);

      if (pair.confidence !== "NOT_A_PAIR") {
        state.versionPairs.push(pair);
        if (pair.confidence === "HIGH") highConfidencePairs++;
      }
    }
  }

  state.versionChains = buildVersionChains(state.versionPairs, docs);

  logger.phaseEnd("4-cluster", t, {
    docPairs: (n * (n - 1)) / 2,
    pairsEvaluated,
    versionPairsFound: state.versionPairs.length,
    highConfidencePairs,
    versionChains: state.versionChains.length,
  });
}
