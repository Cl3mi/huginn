import type { RawChunk } from "../muninn-mirror/types.ts";
import { estimateTokens } from "../token-estimator.ts";
import { analyzeBoundaries } from "./sentence-splitter.ts";
import { classifyBlock } from "../muninn-mirror/cleaner.ts";
import { scoreBlock } from "../quality-scorer.ts";
import type { DomainHints } from "../quality-scorer.ts";

/**
 * sizeFit: 1.0 if 200–550 tokens; linear falloff to 0.2 at <50 or >900 tokens.
 */
export function sizeFit(chunk: RawChunk): number {
  const tokens = estimateTokens(chunk.content);
  if (tokens >= 200 && tokens <= 550) return 1.0;
  if (tokens < 50)  return 0.2;
  if (tokens > 900) return 0.2;
  if (tokens < 200) {
    return 0.2 + ((tokens - 50) / 150) * 0.8;
  }
  return 1.0 - ((tokens - 550) / 350) * 0.8;
}

/**
 * sentenceBoundaryQuality: cleanliness of first/last sentence boundaries.
 * Returns null for table_row chunks (boundaries don't apply).
 */
export function sentenceBoundaryQuality(chunk: RawChunk): number | null {
  if (chunk.chunkType === "table_row") return null;
  const b = analyzeBoundaries(chunk.content);
  if (!b) return null;
  const startsOk = b.first.startsCleanly;
  const endsOk = b.last.endsCleanly;
  if (startsOk && endsOk) return 1.0;
  if (startsOk || endsOk) return 0.5;
  return 0.0;
}

/**
 * tableCut: detect table-row chunks that split mid-row.
 * Returns null for non-table chunks AND for PDF-sourced docs.
 * 1.0 if rows have stable column structure; 0.0 if first/last row diverges sharply from median.
 */
export function tableCut(chunk: RawChunk, sourceExtension: string): number | null {
  if (chunk.chunkType !== "table_row") return null;
  if (sourceExtension === ".pdf") return null;

  const rows = chunk.content.split("\n").filter(r => r.trim().length > 0);
  if (rows.length < 2) return null;

  const colCounts = rows.map(r => {
    const tabs = (r.match(/\t/g) ?? []).length;
    const pipes = (r.match(/\|/g) ?? []).length;
    return Math.max(tabs, pipes);
  });
  const median = [...colCounts].sort((a, b) => a - b)[Math.floor(colCounts.length / 2)] ?? 0;
  if (median === 0) return null;

  const first = colCounts[0] ?? 0;
  const last = colCounts[colCounts.length - 1] ?? 0;
  const firstCut = Math.abs(first - median) > median * 0.4;
  const lastCut = Math.abs(last - median) > median * 0.4;

  if (firstCut || lastCut) return 0.0;
  return 1.0;
}

const REFERENCE_TOKEN_RE =
  /\b(siehe|vgl\.|wie\s+oben|s\.o\.|s\.u\.|dort|dieser|diese|dieses|see\s+above|see\s+below|aforementioned)\b/i;

const ANTECEDENT_RE = /\b(abschnitt|kapitel|section|chapter)\s+\d/i;

/**
 * crossReferenceCut:
 *   - 1.0 if no reference token detected in first 80 chars
 *   - 1.0 if a reference token is present but an antecedent appears earlier in the chunk
 *   - 0.0 if a reference token is in the first 80 chars and no antecedent precedes it
 */
export function crossReferenceCut(chunk: RawChunk): number {
  const text = chunk.content;
  const head = text.slice(0, 80);
  const refMatch = REFERENCE_TOKEN_RE.exec(head);
  if (!refMatch) return 1.0;

  const refIdx = refMatch.index;
  const beforeRef = text.slice(0, refIdx);
  if (ANTECEDENT_RE.test(beforeRef)) return 1.0;

  return 0.0;
}

/**
 * headerPollution: penalize chunks dominated by heading-only lines.
 * 1.0 if header line share ≤ 20%; linear falloff to 0.0 at ≥ 60%.
 */
export function headerPollution(chunk: RawChunk): number {
  const lines = chunk.content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return 1.0;

  const headerLines = lines.filter(l => classifyBlock(l) === "header").length;
  const share = headerLines / lines.length;

  if (share <= 0.2) return 1.0;
  if (share >= 0.6) return 0.0;
  return 1.0 - ((share - 0.2) / 0.4);
}

/**
 * contentScore: re-homed scoreBlock formula (density + coherence + specificity).
 */
export async function contentScore(chunk: RawChunk, hints: DomainHints): Promise<number> {
  return scoreBlock(chunk.content, chunk.chunkType, hints);
}
