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
  skipped?: boolean;
}

// Detect the standalone-binary filesystem produced by `bun build --compile`.
// In compiled mode, .ts source files are not on disk — they're bundled into
// the JS. The drift check only catches dev-time mistakes (forgetting to bump
// EXPECTED_HASHES after editing chunker/cleaner); in a compiled binary the
// sources are already baked in and immutable, so the runtime check has no
// signal to add. The same check still runs at build time via `bun typecheck`
// and `bun run test:chunk-quality` in CI.
const IS_COMPILED_BINARY = HERE.startsWith("/$bunfs");

export function checkDrift(): DriftCheckResult {
  if (IS_COMPILED_BINARY) {
    return { passed: true, drifted: [], skipped: true };
  }
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
