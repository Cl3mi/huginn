import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

const EXPECTED_HASHES: Record<string, string> = {
  "chunker.ts": "190e5b52afa0e6874b7ab78803abfc5792d5febed64cb69b5ac69c889304941d",
  "cleaner.ts": "82baeb85a196bda641cfdc037b350d3089911fd736b694b0886c811526b534bb",
};

export interface DriftCheckResult {
  passed: boolean;
  drifted: Array<{ file: string; expected: string; actual: string }>;
}

export function checkDrift(): DriftCheckResult {
  const drifted: DriftCheckResult["drifted"] = [];
  for (const [file, expected] of Object.entries(EXPECTED_HASHES)) {
    const path = join(HERE, file);
    const content = readFileSync(path);
    const actual = createHash("sha256").update(content).digest("hex");
    if (actual !== expected) {
      drifted.push({ file, expected, actual });
    }
  }
  return { passed: drifted.length === 0, drifted };
}
