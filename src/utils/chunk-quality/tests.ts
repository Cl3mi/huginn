// Startup test gate for Phase 4 chunk-quality. Aborts the scanner on failure,
// matching the runRegexTests() pattern in src/utils/regex-patterns.ts.

import {
  sizeFit,
  sentenceBoundaryQuality,
  crossReferenceCut,
  tableCut,
  headerPollution,
} from "./tier1-rules.ts";
import { resolveBudget, evenSample } from "./budget.ts";
import { checkDrift } from "../muninn-mirror/drift-check.ts";
import type { ChunkType, RawChunk } from "../muninn-mirror/types.ts";

export interface ChunkQualityTestResult {
  passed: boolean;
  failures: Array<{ name: string; expected: string; actual: string }>;
}

export function runChunkQualityTests(): ChunkQualityTestResult {
  const failures: ChunkQualityTestResult["failures"] = [];
  const check = (name: string, condition: boolean, expected: string, actual: string): void => {
    if (!condition) failures.push({ name, expected, actual });
  };
  const chunk = (text: string, type: ChunkType = "prose"): RawChunk => ({ content: text, chunkIndex: 0, chunkType: type });

  check("sizeFit 300t = 1.0", sizeFit(chunk("a ".repeat(630))) === 1.0, "1.0", String(sizeFit(chunk("a ".repeat(630)))));
  check("sizeFit 30t <= 0.4",  sizeFit(chunk("a ".repeat(63))) <= 0.4,  "<=0.4", String(sizeFit(chunk("a ".repeat(63)))));
  check("sizeFit 1500t <= 0.4", sizeFit(chunk("a ".repeat(3150))) <= 0.4, "<=0.4", String(sizeFit(chunk("a ".repeat(3150)))));

  check("sbq clean = 1.0", sentenceBoundaryQuality(chunk("Erster Satz. Zweiter Satz.")) === 1.0, "1.0", "?");
  check("sbq table = null", sentenceBoundaryQuality(chunk("a|b|c", "table_row")) === null, "null", "?");

  check("crc no-ref = 1.0",     crossReferenceCut(chunk("Dies ist normaler Text.")) === 1.0, "1.0", "?");
  check("crc ref-no-ant = 0.0", crossReferenceCut(chunk("siehe Abschnitt 4.2")) === 0.0, "0.0", "?");
  check(
    "crc ref-with-ant = 1.0",
    crossReferenceCut(chunk("Abschnitt 4.2 beschreibt das Verfahren. Siehe oben.")) === 1.0,
    "1.0", "?",
  );

  check("tc non-table = null", tableCut(chunk("text"), ".xlsx") === null, "null", "?");
  check("tc pdf = null",       tableCut(chunk("a|b\nc|d", "table_row"), ".pdf") === null, "null", "?");
  check(
    "tc xlsx-clean = 1.0",
    tableCut(chunk("a|b|c\nd|e|f\ng|h|i", "table_row"), ".xlsx") === 1.0,
    "1.0", "?",
  );

  check(
    "hp prose-heavy >= 0.8",
    headerPollution(chunk("This is a normal sentence with words. Another sentence.")) >= 0.8,
    ">=0.8", "?",
  );

  const b = resolveBudget();
  check("budget valid", b.mode === "normal" || b.mode === "fast" || b.mode === "full", "valid", b.mode);

  const sampled = evenSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  check("evenSample 10->5 length", sampled.length === 5, "5", String(sampled.length));

  const drift = checkDrift();
  check(
    "muninn-mirror drift", drift.passed,
    "no drift",
    drift.drifted.map(d => `${d.file}: actual=${d.actual.slice(0, 8)} expected=${d.expected.slice(0, 8)}`).join("; ")
  );

  return { passed: failures.length === 0, failures };
}

if (import.meta.main) {
  const r = runChunkQualityTests();
  if (r.passed) {
    console.log(`Chunk-quality test suite PASSED (${r.failures.length} failures)`);
    process.exit(0);
  } else {
    console.error("Chunk-quality test suite FAILED:");
    for (const f of r.failures) {
      console.error(`  ${f.name} - expected ${f.expected}, actual ${f.actual}`);
    }
    process.exit(1);
  }
}
