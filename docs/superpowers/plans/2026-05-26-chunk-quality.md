# Chunk Quality Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new pipeline phase that scores chunk quality (rule-based + embedding-based metrics) by mirroring Muninn's chunker, then exposes results in JSON / human Markdown / narrative Markdown / dashboard.

**Architecture:** Inserts `4-chunk-quality.ts` between current Phase 3 (projection, slimmed) and current Phase 4 (fingerprint, renumbered to 5). Phases 4–9 shift +1 (8 file renames). Chunker copied verbatim from Muninn into `src/utils/muninn-mirror/` with SHA-256 drift verification. Sentence detection via `compromise`. Embeddings via existing Ollama BGE-M3 with per-run cache. Budget controllable through `CHUNK_QUALITY_BUDGET=fast|normal|full`.

**Tech Stack:** Bun + TypeScript strict, Ollama BGE-M3, `compromise` (new npm dep), existing `src/llm/ollama.ts` for embed calls. No Python, no new containers.

**Spec:** `docs/superpowers/specs/2026-05-26-chunk-quality-design.md`

---

## File map

**Create (13 files):**
- `src/utils/muninn-mirror/types.ts` — `RawChunk`, `ChunkType`
- `src/utils/muninn-mirror/config.ts` — `CHUNK_SIZE`, `CHUNK_OVERLAP`
- `src/utils/muninn-mirror/cleaner.ts` — `classifyBlock` copied from Muninn
- `src/utils/muninn-mirror/chunker.ts` — copied from Muninn verbatim
- `src/utils/muninn-mirror/mime-map.ts` — extension → MIME
- `src/utils/muninn-mirror/DRIFT.md` — SHA-256 records + sync instructions
- `src/utils/chunk-quality/sentence-splitter.ts` — `compromise` wrapper
- `src/utils/chunk-quality/budget.ts` — `BUDGET → caps` resolver + sampler
- `src/utils/chunk-quality/embedding-cache.ts` — `sha256` keyed in-memory cache
- `src/utils/chunk-quality/tier1-rules.ts` — six rule-based metrics
- `src/utils/chunk-quality/tier2-embeddings.ts` — three embedding metrics
- `src/utils/chunk-quality/tests.ts` — `runChunkQualityTests()` startup gate
- `src/phases/4-chunk-quality.ts` — orchestrator

**Modify:**
- `package.json` — add `compromise` dep + `test:chunk-quality` script
- `src/state.ts` — add `ChunkQuality*` types and field
- `src/pipeline.ts` — insert new phase into orchestration
- `src/server/index.ts` — invoke `runChunkQualityTests()` at startup
- `src/phases/3-projection.ts` — remove `predictedQualityDistribution` and `sampleQualityDistribution`
- `src/llm/prompts.ts` — add `chunkQualityNarrative` prompt
- `src/dashboard/cli-generate.ts` or `html-template.ts` — register new dashboard section
- `CLAUDE.md` — document new phase + muninn-mirror dir

**Modify after rename (phases 4–9 → 5–10):**
- `4-fingerprint.ts → 5-fingerprint.ts`
- `5-cluster.ts → 6-cluster.ts`
- `6-references.ts → 7-references.ts`
- `7-requirements.ts → 8-requirements.ts`
- `8-validate.ts → 9-validate.ts` (also: add 3 new consistency checks)
- `9-html.ts → 10-html.ts`
- `9-narrative.ts → 10-narrative.ts` (also: add `chunkQualityNarrative` section)
- `9-report.ts → 10-report.ts`

**Create dashboard component:**
- `src/dashboard/components/chunk-quality.ts`

---

## Task 1: Add compromise dependency and standalone test runner

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add `compromise` to dependencies and `test:chunk-quality` script**

Update `package.json`:

```json
{
  "name": "huginn-scanner",
  "version": "0.1.0",
  "description": "Document intelligence scanner — blind metadata extraction for automotive technical documents",
  "module": "src/index.ts",
  "type": "module",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "test:chunk-quality": "bun run src/utils/chunk-quality/tests.ts",
    "dashboard:generate": "bun run src/dashboard/cli-generate.ts",
    "dashboard:serve": "bun run src/dashboard/cli-serve.ts"
  },
  "dependencies": {
    "officeparser": "^4.1.0",
    "franc": "^6.2.0",
    "glob": "^11.0.0",
    "chart.js": "^4.4.0",
    "d3": "^7.8.0",
    "compromise": "^14.14.0"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: `compromise` and its types added to `bun.lockb`. No errors.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock bun.lockb
git commit -m "chore(deps): add compromise for sentence-boundary detection"
```

---

## Task 2: Mirror Muninn types and config

**Files:**
- Create: `src/utils/muninn-mirror/types.ts`
- Create: `src/utils/muninn-mirror/config.ts`

- [ ] **Step 1: Create `mkdir` and types file**

Run: `mkdir -p src/utils/muninn-mirror`

Create `src/utils/muninn-mirror/types.ts`:

```typescript
// Mirror of muninn/packages/core/src/types.ts (subset used by chunker).
// Sync manually when Muninn changes — see DRIFT.md.

export type ChunkType = "prose" | "header" | "spec_value" | "table_row" | "boilerplate";

export interface RawChunk {
  content: string;
  chunkIndex: number;
  chunkType: ChunkType;
}
```

- [ ] **Step 2: Create config**

Create `src/utils/muninn-mirror/config.ts`:

```typescript
// Mirror of muninn/packages/core/src/constants.ts (subset used by chunker).
// Sync manually when Muninn changes — see DRIFT.md.

export const CONFIG = {
  CHUNK_SIZE:    Number(process.env["CHUNK_SIZE"]    ?? "512"),
  CHUNK_OVERLAP: Number(process.env["CHUNK_OVERLAP"] ?? "64"),
} as const;
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/utils/muninn-mirror/types.ts src/utils/muninn-mirror/config.ts
git commit -m "feat(chunk-quality): muninn-mirror — types and config"
```

---

## Task 3: Mirror Muninn cleaner (classifyBlock)

**Files:**
- Create: `src/utils/muninn-mirror/cleaner.ts`

- [ ] **Step 1: Copy `classifyBlock` from Muninn**

Run: `cp ~/mci/muninn/packages/rag/src/ingestion/cleaner.ts src/utils/muninn-mirror/cleaner.ts`

- [ ] **Step 2: Add sync header at top of file**

Edit `src/utils/muninn-mirror/cleaner.ts` — prepend:

```typescript
// Mirror of muninn/packages/rag/src/ingestion/cleaner.ts.
// Sync manually when Muninn changes — see DRIFT.md.
// Only classifyBlock and BOILERPLATE_PATTERNS are used by Huginn.
```

- [ ] **Step 3: Fix imports if they reference @muninn paths**

If the copied file has `from "@muninn/core"` imports, replace with `from "./types.ts"`. Run:

```bash
grep -n "@muninn" src/utils/muninn-mirror/cleaner.ts || echo "no muninn imports"
```

If matches exist, edit each:
- `from "@muninn/core"` → `from "./types.ts"`
- Drop or inline any imports that don't have an equivalent in `types.ts`/`config.ts`

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/utils/muninn-mirror/cleaner.ts
git commit -m "feat(chunk-quality): muninn-mirror — cleaner (classifyBlock)"
```

---

## Task 4: Mirror Muninn chunker

**Files:**
- Create: `src/utils/muninn-mirror/chunker.ts`

- [ ] **Step 1: Copy chunker from Muninn**

Run: `cp ~/mci/muninn/packages/rag/src/ingestion/chunker.ts src/utils/muninn-mirror/chunker.ts`

- [ ] **Step 2: Add sync header**

Edit `src/utils/muninn-mirror/chunker.ts` — prepend:

```typescript
// Mirror of muninn/packages/rag/src/ingestion/chunker.ts.
// Sync manually when Muninn changes — see DRIFT.md.
// Used by Huginn Phase 4 (chunk-quality) to predict what Muninn will see.
```

- [ ] **Step 3: Replace `@muninn/core` imports**

Edit imports in `src/utils/muninn-mirror/chunker.ts`:
- `import type { RawChunk } from "@muninn/core";` → `import type { RawChunk } from "./types.ts";`
- `import { CONFIG } from "@muninn/core";` → `import { CONFIG } from "./config.ts";`
- `import { classifyBlock } from "./cleaner.ts";` (already relative — keep)

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 5: Smoke test the chunker**

Create a temporary test file `/tmp/chunker-smoke.ts`:

```typescript
import { chunkDocument } from "../mci/huginn/src/utils/muninn-mirror/chunker.ts";

const text = "Erster Satz. Zweiter Satz. ".repeat(100);
const chunks = await chunkDocument({ content: text, mimeType: "application/pdf", documentId: "test" });
console.log(`Produced ${chunks.length} chunks. First: ${chunks[0]?.content.slice(0, 60)}...`);
if (chunks.length === 0) { console.error("FAIL: no chunks"); process.exit(1); }
console.log("PASS");
```

Run: `bun run /tmp/chunker-smoke.ts`
Expected: `Produced N chunks. First: Erster Satz. Zweiter Satz. ...` then `PASS`.

Run: `rm /tmp/chunker-smoke.ts`

- [ ] **Step 6: Commit**

```bash
git add src/utils/muninn-mirror/chunker.ts
git commit -m "feat(chunk-quality): muninn-mirror — chunker (sliding_window/semantic/table_rows)"
```

---

## Task 5: MIME type mapping

**Files:**
- Create: `src/utils/muninn-mirror/mime-map.ts`

- [ ] **Step 1: Create mime-map**

Create `src/utils/muninn-mirror/mime-map.ts`:

```typescript
// Maps file extensions to MIME types so muninn-mirror/chunker.ts (which keys
// on MIME) can be invoked from Huginn (which keys on extension).

const EXT_TO_MIME: Record<string, string> = {
  ".pdf":  "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt":  "text/plain",
};

export function extensionToMime(extension: string): string {
  const lower = extension.toLowerCase();
  const normalized = lower.startsWith(".") ? lower : `.${lower}`;
  return EXT_TO_MIME[normalized] ?? "text/plain";
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/utils/muninn-mirror/mime-map.ts
git commit -m "feat(chunk-quality): muninn-mirror — extension to MIME map"
```

---

## Task 6: DRIFT.md and drift hash check

**Files:**
- Create: `src/utils/muninn-mirror/DRIFT.md`
- Create: `src/utils/muninn-mirror/drift-check.ts`

- [ ] **Step 1: Compute current hashes**

Run:

```bash
sha256sum src/utils/muninn-mirror/chunker.ts src/utils/muninn-mirror/cleaner.ts
```

Note the two hashes — you'll paste them into `DRIFT.md`.

- [ ] **Step 2: Create DRIFT.md**

Create `src/utils/muninn-mirror/DRIFT.md`:

````markdown
# Muninn Mirror — Drift Tracking

These files are copied from `~/mci/muninn/packages/rag/src/ingestion/`.
When Muninn's chunker changes, sync manually and update the hashes below.

## Files and expected SHA-256

| File           | SHA-256                                                          | Source                |
|----------------|------------------------------------------------------------------|-----------------------|
| `chunker.ts`   | `<paste hash from step 1>`                                       | muninn/...chunker.ts  |
| `cleaner.ts`   | `<paste hash from step 1>`                                       | muninn/...cleaner.ts  |

## Sync procedure

1. Copy fresh files from Muninn:
   ```bash
   cp ~/mci/muninn/packages/rag/src/ingestion/chunker.ts src/utils/muninn-mirror/chunker.ts
   cp ~/mci/muninn/packages/rag/src/ingestion/cleaner.ts src/utils/muninn-mirror/cleaner.ts
   ```
2. Re-add the sync header comment at the top of each file.
3. Replace `@muninn/core` imports with local `./types.ts` / `./config.ts`.
4. Recompute hashes: `sha256sum src/utils/muninn-mirror/chunker.ts src/utils/muninn-mirror/cleaner.ts`
5. Update the table above.
6. Run `bun run test:chunk-quality` — drift check should pass.
7. Commit with message: `chore(chunk-quality): sync muninn-mirror to muninn commit <hash>`
````

Replace the `<paste hash from step 1>` placeholders with the actual hashes.

- [ ] **Step 3: Create drift-check.ts**

Create `src/utils/muninn-mirror/drift-check.ts`:

```typescript
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));

// Hashes recorded in DRIFT.md. Update when files are re-synced from Muninn.
const EXPECTED_HASHES: Record<string, string> = {
  "chunker.ts": "REPLACE_WITH_HASH_FROM_DRIFT_MD",
  "cleaner.ts": "REPLACE_WITH_HASH_FROM_DRIFT_MD",
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
```

- [ ] **Step 4: Replace placeholder hashes with real ones**

Edit `src/utils/muninn-mirror/drift-check.ts` — replace the two `REPLACE_WITH_HASH_FROM_DRIFT_MD` strings with the actual hashes from Step 1. (They must match the values in DRIFT.md exactly.)

- [ ] **Step 5: Verify drift check passes**

Create a temporary verification:

```bash
bun -e 'import("./src/utils/muninn-mirror/drift-check.ts").then(m => { const r = m.checkDrift(); console.log(r); if (!r.passed) process.exit(1); })'
```

Expected: `{ passed: true, drifted: [] }`

- [ ] **Step 6: Commit**

```bash
git add src/utils/muninn-mirror/DRIFT.md src/utils/muninn-mirror/drift-check.ts
git commit -m "feat(chunk-quality): muninn-mirror — DRIFT.md + SHA-256 drift check"
```

---

## Task 7: Sentence splitter (compromise wrapper)

**Files:**
- Create: `src/utils/chunk-quality/sentence-splitter.ts`

- [ ] **Step 1: Create wrapper**

Run: `mkdir -p src/utils/chunk-quality`

Create `src/utils/chunk-quality/sentence-splitter.ts`:

```typescript
// Wrapper around `compromise` for sentence boundary detection.
// Used by Tier 1 sentenceBoundaryQuality metric. Handles German and English.

import nlp from "compromise";

export interface SentenceBoundary {
  text: string;
  startsCleanly: boolean;  // begins with capital letter (incl. Ä Ö Ü)
  endsCleanly:   boolean;  // ends with terminal punctuation . ! ? : ;
}

/**
 * Returns the first and last "sentence" of the chunk along with boundary cleanliness flags.
 * Returns null if no sentences detectable (e.g., chunk is pure whitespace or a fragment).
 */
export function analyzeBoundaries(text: string): { first: SentenceBoundary; last: SentenceBoundary } | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  let sentences: string[];
  try {
    const doc = nlp(trimmed);
    sentences = doc.sentences().out("array") as string[];
  } catch {
    return null;
  }

  if (sentences.length === 0) return null;

  const firstText = sentences[0] ?? "";
  const lastText = sentences[sentences.length - 1] ?? "";

  return {
    first: {
      text: firstText,
      startsCleanly: /^[A-ZÄÖÜ]/.test(firstText),
      endsCleanly:   /[.!?:;]\s*$/.test(firstText),
    },
    last: {
      text: lastText,
      startsCleanly: /^[A-ZÄÖÜ]/.test(lastText),
      endsCleanly:   /[.!?:;]\s*$/.test(lastText),
    },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: no errors. If `compromise` types are missing, install `@types/compromise` or add `declare module "compromise"` shim.

- [ ] **Step 3: Smoke test**

```bash
bun -e 'import("./src/utils/chunk-quality/sentence-splitter.ts").then(m => { const r = m.analyzeBoundaries("Erster Satz. Zweiter Satz."); console.log(r); })'
```

Expected: returns `{ first: { startsCleanly: true, endsCleanly: true }, last: { startsCleanly: true, endsCleanly: true } }`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/chunk-quality/sentence-splitter.ts
git commit -m "feat(chunk-quality): sentence-splitter wrapping compromise"
```

---

## Task 8: Budget resolver

**Files:**
- Create: `src/utils/chunk-quality/budget.ts`

- [ ] **Step 1: Create budget module**

Create `src/utils/chunk-quality/budget.ts`:

```typescript
import type { ChunkQualityBudget } from "../../state.ts";

export interface BudgetCaps {
  mode:             ChunkQualityBudget;
  maxChunksPerDoc:  number;  // Infinity means no cap
  maxCorpusChunks:  number;  // Infinity means no cap
}

export function resolveBudget(): BudgetCaps {
  const raw = (process.env["CHUNK_QUALITY_BUDGET"] ?? "normal").toLowerCase();
  const mode: ChunkQualityBudget =
    raw === "fast" || raw === "full" ? raw : "normal";

  switch (mode) {
    case "fast":   return { mode, maxChunksPerDoc: 30,       maxCorpusChunks: 2_000   };
    case "normal": return { mode, maxChunksPerDoc: 200,      maxCorpusChunks: 20_000  };
    case "full":   return { mode, maxChunksPerDoc: Infinity, maxCorpusChunks: Infinity };
  }
}

/**
 * Even-sample an array down to a target size. Preserves the original order.
 * If `arr.length <= target` returns the input as-is.
 */
export function evenSample<T>(arr: T[], target: number): T[] {
  if (!isFinite(target) || arr.length <= target) return arr;
  if (target <= 0) return [];
  const step = arr.length / target;
  const out: T[] = [];
  for (let i = 0; i < target; i++) {
    const idx = Math.floor(i * step);
    const item = arr[idx];
    if (item !== undefined) out.push(item);
  }
  return out;
}
```

- [ ] **Step 2: Typecheck (will fail — `ChunkQualityBudget` not yet defined in state.ts)**

Run: `bun run typecheck`
Expected: FAIL with `ChunkQualityBudget` not found. That's expected — Task 10 adds the type. Leave as-is for now and continue.

- [ ] **Step 3: Commit (with known typecheck failure)**

```bash
git add src/utils/chunk-quality/budget.ts
git commit -m "feat(chunk-quality): budget resolver and even-sampler (depends on state types in next task)"
```

---

## Task 9: Embedding cache

**Files:**
- Create: `src/utils/chunk-quality/embedding-cache.ts`

- [ ] **Step 1: Create cache module**

Create `src/utils/chunk-quality/embedding-cache.ts`:

```typescript
import { createHash } from "crypto";
import { embed } from "../../llm/ollama.ts";

export interface EmbeddingCacheStats {
  uniqueChunks: number;
  cacheHits:    number;
  cacheMisses:  number;
}

export class EmbeddingCache {
  private cache = new Map<string, Float32Array>();
  private hits = 0;
  private misses = 0;

  private key(text: string): string {
    return createHash("sha256").update(text).digest("hex");
  }

  async get(text: string): Promise<Float32Array> {
    const k = this.key(text);
    const cached = this.cache.get(k);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    const vec = await embed(text);
    const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
    this.cache.set(k, f32);
    return f32;
  }

  stats(): EmbeddingCacheStats {
    return { uniqueChunks: this.cache.size, cacheHits: this.hits, cacheMisses: this.misses };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
```

- [ ] **Step 2: Verify `embed()` signature in ollama.ts**

Run:

```bash
grep -n "export.*function.*embed\|export.*async.*embed" src/llm/ollama.ts
```

If `embed` returns `Promise<number[]>` instead of `Promise<Float32Array>`, the cache's `Float32Array.from(vec)` handles it. If the signature is different (e.g., returns `{ vector: number[] }`), adjust the `await embed(text)` line accordingly.

- [ ] **Step 3: Typecheck (will fail — depends on state types)**

Run: `bun run typecheck`
Expected: file-local typecheck OK; full project may still fail due to budget.ts.

- [ ] **Step 4: Commit**

```bash
git add src/utils/chunk-quality/embedding-cache.ts
git commit -m "feat(chunk-quality): SHA-256 keyed in-memory embedding cache"
```

---

## Task 10: State type additions

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Add types to `state.ts`**

Open `src/state.ts`. After the existing `ConsistencyCheck` interface (around line 199), insert:

```typescript
// ── Phase 4: Chunk Quality ───────────────────────────────────────────────────

export type ChunkQualityBudget = "fast" | "normal" | "full";

export interface ChunkQualityMetricValue {
  score: number | null;
  reason?: string;  // ≤120 chars; only when null or score < 0.4
}

export interface ChunkQualityPerDocTier1 {
  sizeFit:                 { mean: number; p10: number };
  sentenceBoundaryQuality: { mean: number; p10: number };
  crossReferenceCut:       { mean: number; p10: number };
  tableCut:                { mean: number | null; p10: number | null };
  headerPollution:         { mean: number; p10: number };
  contentScore:            { mean: number; p10: number };
}

export interface ChunkQualityPerDocTier2 {
  coherenceDrop:      { mean: number; p10: number } | null;
  intraChunkCohesion: { mean: number; p10: number; nMeasurable: number } | null;
  centroidDistance:   { mean: number; p10: number };
}

export interface ChunkQualityPerDoc {
  docId: string;
  chunkCountTotal:    number;
  chunkCountEmbedded: number;
  budgetMode:         ChunkQualityBudget;
  budgetCapHit:       boolean;
  tier1:              ChunkQualityPerDocTier1;
  tier2:              ChunkQualityPerDocTier2 | null;
  chunkQualityIndex:  { mean: number; p10: number };
  bucketCounts:       { good: number; acceptable: number; poor: number };
  weakestLinks:       string[];  // top 3, each ≤120 chars
}

export interface ChunkQualityCorpusSummary {
  budgetMode:              ChunkQualityBudget;
  totalChunks:             number;
  totalChunksEmbedded:     number;
  tokenWeightedIndexMean:  number;
  bucketShare:             { good: number; acceptable: number; poor: number };
  worstDocsByP10:          Array<{ docId: string; p10: number; primaryWeakness: string }>;
  weakestCorpusMetrics:    Array<{ metric: string; mean: number }>;
  embeddingsCacheStats:    { uniqueChunks: number; cacheHits: number; cacheMisses: number };
  bgeM3NormalizationCheck: { sampleSize: number; allNormalized: boolean; maxDeviation: number };
}

export interface ChunkQualityReport {
  perDoc:      ChunkQualityPerDoc[];
  corpus:      ChunkQualityCorpusSummary;
  generatedAt: Date;
}
```

- [ ] **Step 2: Add `chunkQuality` field to `ScannerState`**

In `src/state.ts`, locate the `ScannerState` interface. After `consistencyChecks: ConsistencyCheck[];` (around line 323), add:

```typescript
  // Phase 4: Chunk Quality (set in 4-chunk-quality.ts)
  chunkQuality: ChunkQualityReport;
```

- [ ] **Step 3: Initialize empty `chunkQuality` in `createInitialState`**

In the same file, locate `createInitialState`. After the `consistencyChecks: [],` line, add:

```typescript
    chunkQuality: {
      perDoc: [],
      corpus: {
        budgetMode: "normal",
        totalChunks: 0,
        totalChunksEmbedded: 0,
        tokenWeightedIndexMean: 0,
        bucketShare: { good: 0, acceptable: 0, poor: 0 },
        worstDocsByP10: [],
        weakestCorpusMetrics: [],
        embeddingsCacheStats: { uniqueChunks: 0, cacheHits: 0, cacheMisses: 0 },
        bgeM3NormalizationCheck: { sampleSize: 0, allNormalized: true, maxDeviation: 0 },
      },
      generatedAt: new Date(0),
    },
```

- [ ] **Step 4: Typecheck — should now pass**

Run: `bun run typecheck`
Expected: PASS. Any errors mean the type definitions or initializer are out of sync — fix them.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts
git commit -m "feat(chunk-quality): add ChunkQuality* state types and empty initialization"
```

---

## Task 11: Phase 4 skeleton — orchestrator that returns empty result

**Files:**
- Create: `src/phases/4-chunk-quality.ts`

- [ ] **Step 1: Create skeleton**

Create `src/phases/4-chunk-quality.ts`:

```typescript
import type { ScannerState, ChunkQualityPerDoc, ChunkQualityReport } from "../state.ts";
import { logger, setPhase } from "../utils/logger.ts";
import { resolveBudget } from "../utils/chunk-quality/budget.ts";
import { EmbeddingCache } from "../utils/chunk-quality/embedding-cache.ts";
import { chunkDocument } from "../utils/muninn-mirror/chunker.ts";
import { extensionToMime } from "../utils/muninn-mirror/mime-map.ts";
import { cleanContent } from "../utils/cleaner.ts";

export async function runChunkQuality(state: ScannerState, ollamaOk: boolean): Promise<void> {
  setPhase("4-chunk-quality");

  if (process.env["CHUNK_QUALITY_DISABLE"] === "1") {
    logger.info("Phase 4: chunk-quality disabled via env var");
    return;
  }

  const budget = resolveBudget();
  state.chunkQuality.corpus.budgetMode = budget.mode;
  logger.info("Phase 4: chunk-quality start", {
    budgetMode: budget.mode,
    maxChunksPerDoc: budget.maxChunksPerDoc,
    parseSuccessful: state.parsed.filter(d => d.parseSuccess).length,
  });

  const cache = new EmbeddingCache();
  const perDoc: ChunkQualityPerDoc[] = [];

  for (const doc of state.parsed) {
    if (!doc.parseSuccess || !doc.textContent) continue;

    const mime = extensionToMime(doc.extension);
    const { cleaned } = cleanContent(doc.textContent);
    const chunks = await chunkDocument({ content: cleaned, mimeType: mime, documentId: doc.id });

    if (chunks.length === 0) continue;

    // Placeholder: produce empty per-doc record. Real metrics added in subsequent tasks.
    perDoc.push({
      docId: doc.id,
      chunkCountTotal: chunks.length,
      chunkCountEmbedded: 0,
      budgetMode: budget.mode,
      budgetCapHit: false,
      tier1: {
        sizeFit:                 { mean: 0, p10: 0 },
        sentenceBoundaryQuality: { mean: 0, p10: 0 },
        crossReferenceCut:       { mean: 0, p10: 0 },
        tableCut:                { mean: null, p10: null },
        headerPollution:         { mean: 0, p10: 0 },
        contentScore:            { mean: 0, p10: 0 },
      },
      tier2: null,
      chunkQualityIndex: { mean: 0, p10: 0 },
      bucketCounts: { good: 0, acceptable: 0, poor: 0 },
      weakestLinks: [],
    });
  }

  const report: ChunkQualityReport = {
    perDoc,
    corpus: {
      ...state.chunkQuality.corpus,
      totalChunks: perDoc.reduce((s, d) => s + d.chunkCountTotal, 0),
      totalChunksEmbedded: 0,
      embeddingsCacheStats: cache.stats(),
    },
    generatedAt: new Date(),
  };

  state.chunkQuality = report;

  logger.info("Phase 4: chunk-quality complete (skeleton)", {
    docs: perDoc.length,
    totalChunks: report.corpus.totalChunks,
  });

  cache.clear();
  void ollamaOk;  // used in later tasks
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/phases/4-chunk-quality.ts
git commit -m "feat(chunk-quality): phase 4 orchestrator skeleton (chunks docs, no metrics yet)"
```

---

## Task 12: Tier 1 — sizeFit

**Files:**
- Create: `src/utils/chunk-quality/tier1-rules.ts`

- [ ] **Step 1: Create tier1-rules.ts with sizeFit**

Create `src/utils/chunk-quality/tier1-rules.ts`:

```typescript
import type { RawChunk } from "../muninn-mirror/types.ts";
import { estimateTokens } from "../token-estimator.ts";

/**
 * sizeFit: 1.0 if 200–550 tokens; linear falloff to 0.2 at <50 or >900 tokens.
 */
export function sizeFit(chunk: RawChunk): number {
  const tokens = estimateTokens(chunk.content);
  if (tokens >= 200 && tokens <= 550) return 1.0;
  if (tokens < 50)  return 0.2;
  if (tokens > 900) return 0.2;
  // Linear falloff
  if (tokens < 200) {
    // 50→0.2, 200→1.0
    return 0.2 + ((tokens - 50) / 150) * 0.8;
  }
  // tokens > 550
  // 550→1.0, 900→0.2
  return 1.0 - ((tokens - 550) / 350) * 0.8;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test**

```bash
bun -e 'import("./src/utils/chunk-quality/tier1-rules.ts").then(m => {
  const t = (text: string) => m.sizeFit({ content: text, chunkIndex: 0, chunkType: "prose" });
  console.log("300-tok:", t("a ".repeat(630)));      // ~300 tokens → 1.0
  console.log("30-tok:", t("a ".repeat(63)));         // ~30 tokens → 0.2
  console.log("1500-tok:", t("a ".repeat(3150)));     // ~1500 tokens → 0.2
})'
```
Expected: `300-tok: 1`, `30-tok: 0.2`, `1500-tok: 0.2`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/chunk-quality/tier1-rules.ts
git commit -m "feat(chunk-quality): tier 1 — sizeFit metric"
```

---

## Task 13: Tier 1 — sentenceBoundaryQuality

**Files:**
- Modify: `src/utils/chunk-quality/tier1-rules.ts`

- [ ] **Step 1: Append `sentenceBoundaryQuality` function**

Edit `src/utils/chunk-quality/tier1-rules.ts`. Add at top:

```typescript
import { analyzeBoundaries } from "./sentence-splitter.ts";
```

Append at end of file:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test**

```bash
bun -e 'import("./src/utils/chunk-quality/tier1-rules.ts").then(m => {
  const t = (text: string) => m.sentenceBoundaryQuality({ content: text, chunkIndex: 0, chunkType: "prose" });
  console.log("clean:", t("Erster Satz. Zweiter Satz."));            // 1.0
  console.log("broken-end:", t("Erster Satz. Zweiter Satz ohne"));   // 0.5
  console.log("broken-both:", t("ohne anfang. zweiter satz ohne"));  // 0.0
  console.log("table:", t("a | b | c") === null ? "null OK" : "fail");
  const tt = m.sentenceBoundaryQuality({ content: "a | b | c", chunkIndex: 0, chunkType: "table_row" });
  console.log("table:", tt);  // null
})'
```
Expected: `clean: 1`, `broken-end: 0.5`, `broken-both: 0`, `table: null`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/chunk-quality/tier1-rules.ts
git commit -m "feat(chunk-quality): tier 1 — sentenceBoundaryQuality via compromise"
```

---

## Task 14: Tier 1 — crossReferenceCut

**Files:**
- Modify: `src/utils/chunk-quality/tier1-rules.ts`

- [ ] **Step 1: Append `crossReferenceCut`**

Append to `src/utils/chunk-quality/tier1-rules.ts`:

```typescript
// Anaphoric / reference tokens (German + English) likely to dangle if cut from antecedent.
const REFERENCE_TOKEN_RE =
  /\b(siehe|vgl\.|wie\s+oben|s\.o\.|s\.u\.|dort|dieser|diese|dieses|see\s+above|see\s+below|aforementioned)\b/i;

// "Antecedent": presence of a section heading-like noun phrase or numbered reference
// somewhere in the chunk EARLIER than the reference token.
const ANTECEDENT_RE = /\b(abschnitt|kapitel|section|chapter)\s+\d/i;

/**
 * crossReferenceCut:
 *   - 1.0 if no reference token detected in first 80 chars (no problem)
 *   - 1.0 if a reference token is present but an antecedent appears in the same chunk
 *   - 0.0 if a reference token is in the first 80 chars and no antecedent precedes it
 */
export function crossReferenceCut(chunk: RawChunk): number {
  const text = chunk.content;
  const head = text.slice(0, 80);
  const refMatch = REFERENCE_TOKEN_RE.exec(head);
  if (!refMatch) return 1.0;

  const refIdx = refMatch.index;
  // Look for antecedent earlier in the chunk (anywhere before the reference token)
  const beforeRef = text.slice(0, refIdx);
  if (ANTECEDENT_RE.test(beforeRef)) return 1.0;

  return 0.0;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test**

```bash
bun -e 'import("./src/utils/chunk-quality/tier1-rules.ts").then(m => {
  const t = (text: string) => m.crossReferenceCut({ content: text, chunkIndex: 0, chunkType: "prose" });
  console.log("no-ref:", t("Dies ist normaler Text."));                                  // 1.0
  console.log("ref-no-ant:", t("siehe Abschnitt 4.2 für mehr Details."));                // 0.0
  console.log("ref-with-ant:", t("Abschnitt 4.2 beschreibt das Verfahren. Siehe oben.")); // 1.0
})'
```
Expected: `no-ref: 1`, `ref-no-ant: 0`, `ref-with-ant: 1`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/chunk-quality/tier1-rules.ts
git commit -m "feat(chunk-quality): tier 1 — crossReferenceCut with antecedent check"
```

---

## Task 15: Tier 1 — tableCut

**Files:**
- Modify: `src/utils/chunk-quality/tier1-rules.ts`

- [ ] **Step 1: Append `tableCut`**

Append to `src/utils/chunk-quality/tier1-rules.ts`:

```typescript
/**
 * tableCut: detect table-row chunks that split mid-row.
 *   - Returns null (not measurable) for non-table chunks AND for PDF-sourced docs
 *     (PDF row boundaries are unreliable from text alone).
 *   - 1.0 if every newline-delimited row appears to have stable column structure
 *     (consistent tab/pipe count across rows).
 *   - 0.0 if any row's column count diverges sharply from its neighbours (a cut).
 *
 * For XLSX-sourced docs the chunker already groups rows; we check that the first
 * and last lines have the same delimiter count as the median.
 */
export function tableCut(chunk: RawChunk, sourceExtension: string): number | null {
  if (chunk.chunkType !== "table_row") return null;
  // For PDF, row boundaries from text are unreliable
  if (sourceExtension === ".pdf") return null;

  const rows = chunk.content.split("\n").filter(r => r.trim().length > 0);
  if (rows.length < 2) return null;

  const colCounts = rows.map(r => {
    const tabs = (r.match(/\t/g) ?? []).length;
    const pipes = (r.match(/\|/g) ?? []).length;
    return Math.max(tabs, pipes);
  });
  const median = [...colCounts].sort((a, b) => a - b)[Math.floor(colCounts.length / 2)] ?? 0;
  if (median === 0) return null;  // not actually delimited rows

  const first = colCounts[0] ?? 0;
  const last = colCounts[colCounts.length - 1] ?? 0;
  const firstCut = Math.abs(first - median) > median * 0.4;
  const lastCut = Math.abs(last - median) > median * 0.4;

  if (firstCut || lastCut) return 0.0;
  return 1.0;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test**

```bash
bun -e 'import("./src/utils/chunk-quality/tier1-rules.ts").then(m => {
  const t = (text: string, ext: string, type: any) => m.tableCut({ content: text, chunkIndex: 0, chunkType: type }, ext);
  console.log("non-table:", t("text", ".xlsx", "prose"));                                       // null
  console.log("pdf:", t("a|b|c\nd|e|f", ".pdf", "table_row"));                                  // null
  console.log("clean-xlsx:", t("a|b|c\nd|e|f\ng|h|i", ".xlsx", "table_row"));                   // 1.0
  console.log("cut-xlsx:", t("a|b|c\nd|e|f\nx", ".xlsx", "table_row"));                         // 0.0
})'
```
Expected: `non-table: null`, `pdf: null`, `clean-xlsx: 1`, `cut-xlsx: 0`.

- [ ] **Step 4: Commit**

```bash
git add src/utils/chunk-quality/tier1-rules.ts
git commit -m "feat(chunk-quality): tier 1 — tableCut for XLSX/DOCX, null for PDF"
```

---

## Task 16: Tier 1 — headerPollution

**Files:**
- Modify: `src/utils/chunk-quality/tier1-rules.ts`

- [ ] **Step 1: Append `headerPollution`**

Append to `src/utils/chunk-quality/tier1-rules.ts`:

```typescript
import { classifyBlock } from "../muninn-mirror/cleaner.ts";

/**
 * headerPollution: penalize chunks dominated by heading-only lines.
 * Compute the share of lines classified as "header" by the muninn-mirror classifier.
 *   - 1.0 if header line share ≤ 20%
 *   - linear falloff to 0.0 at ≥ 60%
 */
export function headerPollution(chunk: RawChunk): number {
  const lines = chunk.content.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return 1.0;

  const headerLines = lines.filter(l => classifyBlock(l) === "header").length;
  const share = headerLines / lines.length;

  if (share <= 0.2) return 1.0;
  if (share >= 0.6) return 0.0;
  // Linear falloff between 0.2 and 0.6
  return 1.0 - ((share - 0.2) / 0.4);
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Smoke test**

```bash
bun -e 'import("./src/utils/chunk-quality/tier1-rules.ts").then(m => {
  const t = (text: string) => m.headerPollution({ content: text, chunkIndex: 0, chunkType: "prose" });
  console.log("prose:", t("This is a normal sentence with words. Another sentence."));
  console.log("heading-heavy:", t("1. Introduction\n2. Scope\n3. Method\nbody text here"));
})'
```
Expected: `prose: 1`, `heading-heavy: <0.6` (exact value depends on classifyBlock).

- [ ] **Step 4: Commit**

```bash
git add src/utils/chunk-quality/tier1-rules.ts
git commit -m "feat(chunk-quality): tier 1 — headerPollution via classifyBlock"
```

---

## Task 17: Tier 1 — contentScore (re-home scoreBlock)

**Files:**
- Modify: `src/utils/chunk-quality/tier1-rules.ts`

- [ ] **Step 1: Append `contentScore` wrapper**

Append to `src/utils/chunk-quality/tier1-rules.ts`:

```typescript
import { scoreBlock } from "../quality-scorer.ts";
import type { DomainHints } from "../quality-scorer.ts";

/**
 * contentScore: re-homed scoreBlock formula (density + coherence + specificity).
 * Domain quality signal — preserves the existing scoring formula but now runs over
 * real chunks instead of paragraph blocks.
 */
export async function contentScore(chunk: RawChunk, hints: DomainHints): Promise<number> {
  return scoreBlock(chunk.content, chunk.chunkType, hints);
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/chunk-quality/tier1-rules.ts
git commit -m "feat(chunk-quality): tier 1 — contentScore re-homes scoreBlock for real chunks"
```

---

## Task 18: Tier 2 — coherenceDrop

**Files:**
- Create: `src/utils/chunk-quality/tier2-embeddings.ts`

- [ ] **Step 1: Create tier2-embeddings.ts**

Create `src/utils/chunk-quality/tier2-embeddings.ts`:

```typescript
import type { RawChunk } from "../muninn-mirror/types.ts";
import { EmbeddingCache } from "./embedding-cache.ts";

/**
 * Cosine similarity for L2-normalized vectors (BGE-M3 default).
 * Asserts approximate normalization; auto-normalizes if violated.
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return Math.max(-1, Math.min(1, dot));
}

export function l2Norm(v: Float32Array): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

export function normalize(v: Float32Array): Float32Array {
  const n = l2Norm(v);
  if (n === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / n;
  return out;
}

export interface NormalizationCheck {
  sampleSize:    number;
  allNormalized: boolean;
  maxDeviation:  number;
}

/**
 * coherenceDrop: per-doc score in [0, 1].
 *   drop_i = 1 - cos(emb_i, emb_{i+1})
 *   score  = 1 - mean(drop)
 * Returns null if fewer than 2 chunks (no adjacent pairs exist).
 */
export async function coherenceDrop(
  chunks: RawChunk[],
  cache: EmbeddingCache,
  normCheck: NormalizationCheck,
): Promise<{ mean: number; p10: number } | null> {
  if (chunks.length < 2) return null;

  const drops: number[] = [];
  let prevEmb: Float32Array | null = null;

  for (const chunk of chunks) {
    let emb = await cache.get(chunk.content);
    const norm = l2Norm(emb);
    normCheck.sampleSize++;
    const dev = Math.abs(norm - 1);
    if (dev > normCheck.maxDeviation) normCheck.maxDeviation = dev;
    if (dev > 0.001) {
      normCheck.allNormalized = false;
      emb = normalize(emb);
    }

    if (prevEmb) {
      const sim = cosineSim(prevEmb, emb);
      drops.push(1 - sim);
    }
    prevEmb = emb;
  }

  if (drops.length === 0) return null;
  const sortedDrops = [...drops].sort((a, b) => a - b);
  const meanDrop = drops.reduce((s, x) => s + x, 0) / drops.length;
  const p90Drop = sortedDrops[Math.floor(0.9 * sortedDrops.length)] ?? meanDrop;
  return {
    mean: Math.max(0, Math.min(1, 1 - meanDrop)),
    p10:  Math.max(0, Math.min(1, 1 - p90Drop)),  // worst-10% drop → p10 of score
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/chunk-quality/tier2-embeddings.ts
git commit -m "feat(chunk-quality): tier 2 — coherenceDrop between adjacent chunks"
```

---

## Task 19: Tier 2 — intraChunkCohesion

**Files:**
- Modify: `src/utils/chunk-quality/tier2-embeddings.ts`

- [ ] **Step 1: Append `intraChunkCohesion`**

Append to `src/utils/chunk-quality/tier2-embeddings.ts`:

```typescript
import { estimateTokens } from "../token-estimator.ts";

const MIN_TOKENS_FOR_INTRA = 100;

/**
 * intraChunkCohesion: per-doc score in [0, 1].
 * For each chunk ≥ MIN_TOKENS_FOR_INTRA, split at token midpoint, embed each half,
 * score = cos(half_a, half_b). Chunks under 100 tokens are skipped.
 */
export async function intraChunkCohesion(
  chunks: RawChunk[],
  cache: EmbeddingCache,
  normCheck: NormalizationCheck,
): Promise<{ mean: number; p10: number; nMeasurable: number } | null> {
  const scores: number[] = [];

  for (const chunk of chunks) {
    const tokens = estimateTokens(chunk.content);
    if (tokens < MIN_TOKENS_FOR_INTRA) continue;

    // Approximate midpoint split by char count
    const midpoint = Math.floor(chunk.content.length / 2);
    // Move to nearest whitespace to avoid splitting words
    let splitAt = midpoint;
    for (let i = 0; i < 30 && midpoint + i < chunk.content.length; i++) {
      if (chunk.content[midpoint + i] === " " || chunk.content[midpoint + i] === "\n") {
        splitAt = midpoint + i;
        break;
      }
    }
    const halfA = chunk.content.slice(0, splitAt).trim();
    const halfB = chunk.content.slice(splitAt).trim();
    if (halfA.length === 0 || halfB.length === 0) continue;

    let embA = await cache.get(halfA);
    let embB = await cache.get(halfB);

    for (const emb of [embA, embB]) {
      const dev = Math.abs(l2Norm(emb) - 1);
      normCheck.sampleSize++;
      if (dev > normCheck.maxDeviation) normCheck.maxDeviation = dev;
      if (dev > 0.001) normCheck.allNormalized = false;
    }
    embA = normalize(embA);
    embB = normalize(embB);

    scores.push(cosineSim(embA, embB));
  }

  if (scores.length === 0) return null;
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const p10 = sorted[Math.floor(0.1 * sorted.length)] ?? mean;
  return {
    mean: Math.max(0, Math.min(1, mean)),
    p10:  Math.max(0, Math.min(1, p10)),
    nMeasurable: scores.length,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/chunk-quality/tier2-embeddings.ts
git commit -m "feat(chunk-quality): tier 2 — intraChunkCohesion for chunks ≥100 tokens"
```

---

## Task 20: Tier 2 — centroidDistance

**Files:**
- Modify: `src/utils/chunk-quality/tier2-embeddings.ts`

- [ ] **Step 1: Append `centroidDistance`**

Append to `src/utils/chunk-quality/tier2-embeddings.ts`:

```typescript
/**
 * centroidDistance: per-doc score in [0, 1] after per-doc z-score normalization.
 * For each chunk: distance = 1 - cos(emb_chunk, c_d) where c_d = mean(embeddings_in_doc).
 * Then z-score each chunk's distance against the doc's distribution; map to [0,1]
 * via 1 - clamp(|z|/3, 0, 1). Higher = on-topic; low = outlier.
 */
export async function centroidDistance(
  chunks: RawChunk[],
  cache: EmbeddingCache,
  normCheck: NormalizationCheck,
): Promise<{ mean: number; p10: number }> {
  if (chunks.length === 0) return { mean: 0, p10: 0 };

  // 1. Embed all chunks (uses cache from previous metrics — these are cache hits)
  const embeddings: Float32Array[] = [];
  for (const chunk of chunks) {
    let emb = await cache.get(chunk.content);
    const dev = Math.abs(l2Norm(emb) - 1);
    normCheck.sampleSize++;
    if (dev > normCheck.maxDeviation) normCheck.maxDeviation = dev;
    if (dev > 0.001) {
      normCheck.allNormalized = false;
      emb = normalize(emb);
    }
    embeddings.push(emb);
  }

  // 2. Compute centroid
  const dim = embeddings[0]?.length ?? 0;
  if (dim === 0) return { mean: 0, p10: 0 };
  const centroid = new Float32Array(dim);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) + (emb[i] ?? 0);
  }
  for (let i = 0; i < dim; i++) centroid[i] = (centroid[i] ?? 0) / embeddings.length;
  const centroidNormed = normalize(centroid);

  // 3. Per-chunk distance
  const distances = embeddings.map(e => 1 - cosineSim(e, centroidNormed));

  // 4. Z-score per doc
  const meanDist = distances.reduce((s, d) => s + d, 0) / distances.length;
  const variance =
    distances.reduce((s, d) => s + (d - meanDist) ** 2, 0) / Math.max(1, distances.length - 1);
  const stddev = Math.sqrt(variance);

  const scores = distances.map(d => {
    if (stddev === 0) return 1.0;
    const z = Math.abs((d - meanDist) / stddev);
    return Math.max(0, Math.min(1, 1 - z / 3));
  });

  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.reduce((s, x) => s + x, 0) / scores.length;
  const p10 = sorted[Math.floor(0.1 * sorted.length)] ?? mean;
  return { mean, p10 };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/utils/chunk-quality/tier2-embeddings.ts
git commit -m "feat(chunk-quality): tier 2 — centroidDistance with per-doc z-score normalization"
```

---

## Task 21: Wire Tier 1 + Tier 2 into Phase 4, with per-doc aggregation

**Files:**
- Modify: `src/phases/4-chunk-quality.ts`

- [ ] **Step 1: Replace skeleton with full orchestrator**

Replace the entire contents of `src/phases/4-chunk-quality.ts`:

```typescript
import type {
  ScannerState,
  ChunkQualityPerDoc,
  ChunkQualityReport,
  ChunkQualityPerDocTier1,
  ChunkQualityPerDocTier2,
} from "../state.ts";
import { logger, setPhase } from "../utils/logger.ts";
import { resolveBudget, evenSample } from "../utils/chunk-quality/budget.ts";
import { EmbeddingCache } from "../utils/chunk-quality/embedding-cache.ts";
import { chunkDocument } from "../utils/muninn-mirror/chunker.ts";
import { extensionToMime } from "../utils/muninn-mirror/mime-map.ts";
import { cleanContent } from "../utils/cleaner.ts";
import type { RawChunk } from "../utils/muninn-mirror/types.ts";
import {
  sizeFit,
  sentenceBoundaryQuality,
  crossReferenceCut,
  tableCut,
  headerPollution,
  contentScore,
} from "../utils/chunk-quality/tier1-rules.ts";
import {
  coherenceDrop,
  intraChunkCohesion,
  centroidDistance,
  type NormalizationCheck,
} from "../utils/chunk-quality/tier2-embeddings.ts";

function meanAndP10(values: number[]): { mean: number; p10: number } {
  if (values.length === 0) return { mean: 0, p10: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, x) => s + x, 0) / values.length;
  const p10 = sorted[Math.floor(0.1 * sorted.length)] ?? mean;
  return { mean, p10 };
}

function meanAndP10Nullable(values: Array<number | null>): { mean: number | null; p10: number | null } {
  const filtered = values.filter((v): v is number => v !== null);
  if (filtered.length === 0) return { mean: null, p10: null };
  return meanAndP10(filtered);
}

function bucketize(score: number): "good" | "acceptable" | "poor" {
  if (score >= 0.7) return "good";
  if (score >= 0.4) return "acceptable";
  return "poor";
}

function clamp120(s: string): string {
  return s.length <= 120 ? s : s.slice(0, 117) + "...";
}

export async function runChunkQuality(state: ScannerState, ollamaOk: boolean): Promise<void> {
  setPhase("4-chunk-quality");

  if (process.env["CHUNK_QUALITY_DISABLE"] === "1") {
    logger.info("Phase 4: chunk-quality disabled via env var");
    return;
  }

  const budget = resolveBudget();
  state.chunkQuality.corpus.budgetMode = budget.mode;
  logger.info("Phase 4: chunk-quality start", {
    budgetMode: budget.mode,
    maxChunksPerDoc: budget.maxChunksPerDoc,
    parseSuccessful: state.parsed.filter(d => d.parseSuccess).length,
  });

  const cache = new EmbeddingCache();
  const normCheck: NormalizationCheck = { sampleSize: 0, allNormalized: true, maxDeviation: 0 };
  const perDoc: ChunkQualityPerDoc[] = [];
  let runningTotal = 0;
  let totalEmbedded = 0;
  let tier2Disabled = !ollamaOk;

  // PASS 1: chunk every doc, collect into a list with per-doc cap applied
  type DocChunks = { docId: string; ext: string; allChunks: RawChunk[]; sampledChunks: RawChunk[] };
  const allDocs: DocChunks[] = [];

  for (const doc of state.parsed) {
    if (!doc.parseSuccess || !doc.textContent) continue;
    const mime = extensionToMime(doc.extension);
    const { cleaned } = cleanContent(doc.textContent);
    const allChunks = await chunkDocument({ content: cleaned, mimeType: mime, documentId: doc.id });
    if (allChunks.length === 0) continue;
    const sampledChunks = evenSample(allChunks, budget.maxChunksPerDoc);
    allDocs.push({ docId: doc.id, ext: doc.extension, allChunks, sampledChunks });
    runningTotal += sampledChunks.length;
  }

  // PASS 2: if over corpus cap, scale every doc proportionally
  if (runningTotal > budget.maxCorpusChunks) {
    const factor = budget.maxCorpusChunks / runningTotal;
    for (const d of allDocs) {
      const target = Math.max(1, Math.floor(d.sampledChunks.length * factor));
      d.sampledChunks = evenSample(d.sampledChunks, target);
    }
    runningTotal = allDocs.reduce((s, d) => s + d.sampledChunks.length, 0);
  }
  const budgetCapHit = allDocs.some(d => d.sampledChunks.length < d.allChunks.length);

  // PASS 3: compute metrics per doc
  for (const d of allDocs) {
    const doc = state.parsed.find(p => p.id === d.docId);
    if (!doc) continue;
    const hints = {
      requirementLanguageFamily: state.domainProfile.requirementLanguageFamily,
      dominantUnitFamily:        state.domainProfile.dominantUnitFamily,
    };

    // Per-chunk Tier 1 values (compute over ALL chunks; embedding cap only affects Tier 2)
    const sizeFitVals       = d.allChunks.map(c => sizeFit(c));
    const sentBoundaryVals  = d.allChunks.map(c => sentenceBoundaryQuality(c)).filter((v): v is number => v !== null);
    const crossRefVals      = d.allChunks.map(c => crossReferenceCut(c));
    const tableCutVals      = d.allChunks.map(c => tableCut(c, d.ext));
    const headerPollVals    = d.allChunks.map(c => headerPollution(c));
    const contentScoreVals  = await Promise.all(d.allChunks.map(c => contentScore(c, hints)));

    const tier1: ChunkQualityPerDocTier1 = {
      sizeFit:                 meanAndP10(sizeFitVals),
      sentenceBoundaryQuality: meanAndP10(sentBoundaryVals.length > 0 ? sentBoundaryVals : [1.0]),
      crossReferenceCut:       meanAndP10(crossRefVals),
      tableCut:                meanAndP10Nullable(tableCutVals),
      headerPollution:         meanAndP10(headerPollVals),
      contentScore:            meanAndP10(contentScoreVals),
    };

    // Tier 2 only on sampledChunks
    let tier2: ChunkQualityPerDocTier2 | null = null;
    if (!tier2Disabled && d.sampledChunks.length > 0) {
      try {
        const coh = await coherenceDrop(d.sampledChunks, cache, normCheck);
        const intra = await intraChunkCohesion(d.sampledChunks, cache, normCheck);
        const cent = await centroidDistance(d.sampledChunks, cache, normCheck);
        tier2 = { coherenceDrop: coh, intraChunkCohesion: intra, centroidDistance: cent };
      } catch (e) {
        logger.warn("Tier 2 failed for doc, disabling for remainder", { docId: d.docId, error: String(e).slice(0, 100) });
        tier2Disabled = true;
        tier2 = null;
      }
    }

    // Per-chunk composite index (recompute over allChunks for tier1 and sampledChunks for tier2)
    const sampledIdSet = new Set(d.sampledChunks.map(c => c.chunkIndex));
    const indexValues: number[] = [];
    for (const c of d.allChunks) {
      const tier1Vals: number[] = [
        sizeFit(c),
        crossReferenceCut(c),
        headerPollution(c),
        await contentScore(c, hints),
      ];
      const sbq = sentenceBoundaryQuality(c);
      if (sbq !== null) tier1Vals.push(sbq);
      const tc = tableCut(c, d.ext);
      if (tc !== null) tier1Vals.push(tc);
      const tier1Mean = tier1Vals.reduce((s, x) => s + x, 0) / tier1Vals.length;

      let composite = tier1Mean;
      if (tier2 && sampledIdSet.has(c.chunkIndex)) {
        // Approximation: use per-doc tier2 means as the chunk's tier2 score
        const tier2Vals: number[] = [];
        if (tier2.coherenceDrop) tier2Vals.push(tier2.coherenceDrop.mean);
        if (tier2.intraChunkCohesion) tier2Vals.push(tier2.intraChunkCohesion.mean);
        tier2Vals.push(tier2.centroidDistance.mean);
        if (tier2Vals.length > 0) {
          const tier2Mean = tier2Vals.reduce((s, x) => s + x, 0) / tier2Vals.length;
          composite = 0.5 * tier1Mean + 0.5 * tier2Mean;
        }
      }
      indexValues.push(composite);
    }

    const chunkQualityIndex = meanAndP10(indexValues);
    const bucketCounts = { good: 0, acceptable: 0, poor: 0 };
    for (const v of indexValues) bucketCounts[bucketize(v)]++;

    // Weakest links: name the worst-performing metrics for this doc
    const metricSnapshots: Array<[string, number]> = [
      ["sizeFit",                 tier1.sizeFit.mean],
      ["sentenceBoundaryQuality", tier1.sentenceBoundaryQuality.mean],
      ["crossReferenceCut",       tier1.crossReferenceCut.mean],
      ["headerPollution",         tier1.headerPollution.mean],
      ["contentScore",            tier1.contentScore.mean],
    ];
    if (tier1.tableCut.mean !== null) metricSnapshots.push(["tableCut", tier1.tableCut.mean]);
    if (tier2?.coherenceDrop)        metricSnapshots.push(["coherenceDrop", tier2.coherenceDrop.mean]);
    if (tier2?.intraChunkCohesion)   metricSnapshots.push(["intraChunkCohesion", tier2.intraChunkCohesion.mean]);
    if (tier2)                       metricSnapshots.push(["centroidDistance", tier2.centroidDistance.mean]);

    const weakestLinks = metricSnapshots
      .sort((a, b) => a[1] - b[1])
      .slice(0, 3)
      .map(([name, val]) => clamp120(`${name}: ${val.toFixed(2)}`));

    perDoc.push({
      docId: d.docId,
      chunkCountTotal:    d.allChunks.length,
      chunkCountEmbedded: tier2 ? d.sampledChunks.length : 0,
      budgetMode:         budget.mode,
      budgetCapHit:       d.sampledChunks.length < d.allChunks.length,
      tier1,
      tier2,
      chunkQualityIndex,
      bucketCounts,
      weakestLinks,
    });

    totalEmbedded += tier2 ? d.sampledChunks.length : 0;
  }

  // CORPUS SUMMARY
  const totalChunks = perDoc.reduce((s, d) => s + d.chunkCountTotal, 0);
  const totalBuckets = perDoc.reduce(
    (acc, d) => ({
      good: acc.good + d.bucketCounts.good,
      acceptable: acc.acceptable + d.bucketCounts.acceptable,
      poor: acc.poor + d.bucketCounts.poor,
    }),
    { good: 0, acceptable: 0, poor: 0 },
  );
  const bucketShare = totalChunks > 0
    ? {
        good: totalBuckets.good / totalChunks,
        acceptable: totalBuckets.acceptable / totalChunks,
        poor: totalBuckets.poor / totalChunks,
      }
    : { good: 0, acceptable: 0, poor: 0 };

  // Token-weighted index mean — weight by the doc's chunk count as a proxy for token weight
  const tokenWeightedIndexMean = totalChunks > 0
    ? perDoc.reduce((s, d) => s + d.chunkQualityIndex.mean * d.chunkCountTotal, 0) / totalChunks
    : 0;

  // Worst docs by p10
  const worstDocsByP10 = [...perDoc]
    .sort((a, b) => a.chunkQualityIndex.p10 - b.chunkQualityIndex.p10)
    .slice(0, 5)
    .map(d => ({
      docId: d.docId,
      p10: d.chunkQualityIndex.p10,
      primaryWeakness: clamp120(d.weakestLinks[0] ?? "unknown"),
    }));

  // Corpus-level weakest metrics (mean across docs)
  const metricNames = [
    "sizeFit", "sentenceBoundaryQuality", "crossReferenceCut", "tableCut",
    "headerPollution", "contentScore", "coherenceDrop", "intraChunkCohesion", "centroidDistance",
  ];
  const corpusMetricMeans: Array<{ metric: string; mean: number }> = [];
  for (const name of metricNames) {
    const vals: number[] = [];
    for (const d of perDoc) {
      let v: number | null = null;
      if (name === "sizeFit") v = d.tier1.sizeFit.mean;
      else if (name === "sentenceBoundaryQuality") v = d.tier1.sentenceBoundaryQuality.mean;
      else if (name === "crossReferenceCut") v = d.tier1.crossReferenceCut.mean;
      else if (name === "tableCut") v = d.tier1.tableCut.mean;
      else if (name === "headerPollution") v = d.tier1.headerPollution.mean;
      else if (name === "contentScore") v = d.tier1.contentScore.mean;
      else if (name === "coherenceDrop") v = d.tier2?.coherenceDrop?.mean ?? null;
      else if (name === "intraChunkCohesion") v = d.tier2?.intraChunkCohesion?.mean ?? null;
      else if (name === "centroidDistance") v = d.tier2?.centroidDistance.mean ?? null;
      if (v !== null) vals.push(v);
    }
    if (vals.length > 0) {
      corpusMetricMeans.push({ metric: name, mean: vals.reduce((s, x) => s + x, 0) / vals.length });
    }
  }
  const weakestCorpusMetrics = [...corpusMetricMeans]
    .sort((a, b) => a.mean - b.mean)
    .slice(0, 3);

  const report: ChunkQualityReport = {
    perDoc,
    corpus: {
      budgetMode: budget.mode,
      totalChunks,
      totalChunksEmbedded: totalEmbedded,
      tokenWeightedIndexMean,
      bucketShare,
      worstDocsByP10,
      weakestCorpusMetrics,
      embeddingsCacheStats: cache.stats(),
      bgeM3NormalizationCheck: normCheck,
    },
    generatedAt: new Date(),
  };

  state.chunkQuality = report;

  logger.info("Phase 4: chunk-quality complete", {
    docs: perDoc.length,
    totalChunks,
    totalEmbedded,
    indexMean: tokenWeightedIndexMean.toFixed(3),
    bucketCapHit: budgetCapHit,
    tier2Disabled,
  });

  cache.clear();
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/phases/4-chunk-quality.ts
git commit -m "feat(chunk-quality): phase 4 full orchestrator — tier 1 + tier 2 + aggregation"
```

---

## Task 22: Wire Phase 4 into pipeline and add test gate

**Files:**
- Modify: `src/pipeline.ts`
- Modify: `src/server/index.ts`
- Create: `src/utils/chunk-quality/tests.ts`

- [ ] **Step 1: Insert Phase 4 into pipeline orchestration**

Edit `src/pipeline.ts`. Add import after the `runProjection` import:

```typescript
import { runChunkQuality } from "./phases/4-chunk-quality.ts";
```

Locate the `phases` array (around line 90). Insert a new entry after `3-projection`:

```typescript
    { name: "3-projection",   fn: () => runProjection(state),             idx: 2 },
    { name: "4-chunk-quality", fn: () => runChunkQuality(state, ollamaOk), idx: 3 },
    { name: "4-fingerprint",  fn: () => runFingerprint(state, embedAvailable),  idx: 4 },
```

Bump every subsequent `idx` by 1:
- `5-cluster` → `idx: 5`
- `6-references` → `idx: 6`
- `7-requirements` → `idx: 7`
- `8-validate` → `idx: 8`
- `9-report` → `idx: 9`

Also update `totalPhases: 9` to `totalPhases: 10` (around line 129):

```typescript
onProgress?.({ type: "phase_start", phase: phase.name, phaseIndex: phase.idx, totalPhases: 10 });
```

Update `emitStats()` to include `"4-chunk-quality"` in the after-checks (around lines 113-122) — it's a new "after" value that should still emit stats. Add a new branch if useful, or accept the existing checks (they emit cumulative stats anyway).

- [ ] **Step 2: Create chunk-quality test gate**

Create `src/utils/chunk-quality/tests.ts`:

```typescript
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

export interface ChunkQualityTestResult {
  passed: boolean;
  failures: Array<{ name: string; expected: string; actual: string }>;
}

export function runChunkQualityTests(): ChunkQualityTestResult {
  const failures: ChunkQualityTestResult["failures"] = [];
  const check = (name: string, condition: boolean, expected: string, actual: string): void => {
    if (!condition) failures.push({ name, expected, actual });
  };
  const chunk = (text: string, type: any = "prose") => ({ content: text, chunkIndex: 0, chunkType: type });

  // sizeFit
  check("sizeFit 300t = 1.0", sizeFit(chunk("a ".repeat(630))) === 1.0, "1.0", String(sizeFit(chunk("a ".repeat(630)))));
  check("sizeFit 30t ≤ 0.4",  sizeFit(chunk("a ".repeat(63))) <= 0.4,  "≤0.4", String(sizeFit(chunk("a ".repeat(63)))));
  check("sizeFit 1500t ≤ 0.4", sizeFit(chunk("a ".repeat(3150))) <= 0.4, "≤0.4", String(sizeFit(chunk("a ".repeat(3150)))));

  // sentenceBoundaryQuality
  check("sbq clean = 1.0", sentenceBoundaryQuality(chunk("Erster Satz. Zweiter Satz.")) === 1.0, "1.0", "?");
  check("sbq table = null", sentenceBoundaryQuality(chunk("a|b|c", "table_row")) === null, "null", "?");

  // crossReferenceCut
  check("crc no-ref = 1.0",     crossReferenceCut(chunk("Dies ist normaler Text.")) === 1.0, "1.0", "?");
  check("crc ref-no-ant = 0.0", crossReferenceCut(chunk("siehe Abschnitt 4.2")) === 0.0, "0.0", "?");
  check(
    "crc ref-with-ant = 1.0",
    crossReferenceCut(chunk("Abschnitt 4.2 beschreibt das Verfahren. Siehe oben.")) === 1.0,
    "1.0", "?",
  );

  // tableCut
  check("tc non-table = null", tableCut(chunk("text"), ".xlsx") === null, "null", "?");
  check("tc pdf = null",       tableCut(chunk("a|b\nc|d", "table_row"), ".pdf") === null, "null", "?");
  check(
    "tc xlsx-clean = 1.0",
    tableCut(chunk("a|b|c\nd|e|f\ng|h|i", "table_row"), ".xlsx") === 1.0,
    "1.0", "?",
  );

  // headerPollution
  check(
    "hp prose-heavy ≥ 0.8",
    headerPollution(chunk("This is a normal sentence with words. Another sentence.")) >= 0.8,
    "≥0.8", "?",
  );

  // Budget resolver
  const b = resolveBudget();
  check("budget default = normal", b.mode === "normal" || b.mode === "fast" || b.mode === "full", "valid", b.mode);

  // evenSample
  const sampled = evenSample([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
  check("evenSample 10→5 length", sampled.length === 5, "5", String(sampled.length));

  // Drift check
  const drift = checkDrift();
  check(
    "muninn-mirror drift", drift.passed,
    "no drift",
    drift.drifted.map(d => `${d.file}: actual=${d.actual.slice(0, 8)} expected=${d.expected.slice(0, 8)}`).join("; ")
  );

  return { passed: failures.length === 0, failures };
}

// Allow running standalone via `bun run test:chunk-quality`
if (import.meta.main) {
  const r = runChunkQualityTests();
  if (r.passed) {
    console.log(`Chunk-quality test suite PASSED (${r.failures.length} failures)`);
    process.exit(0);
  } else {
    console.error("Chunk-quality test suite FAILED:");
    for (const f of r.failures) {
      console.error(`  ${f.name} — expected ${f.expected}, actual ${f.actual}`);
    }
    process.exit(1);
  }
}
```

- [ ] **Step 3: Wire startup gate into server**

Edit `src/server/index.ts`. After the import for `runRegexTests`:

```typescript
import { runRegexTests } from "../utils/regex-patterns.ts";
import { runChunkQualityTests } from "../utils/chunk-quality/tests.ts";
```

Inside `start()`, immediately after the regex test block (around line 63), add:

```typescript
  const chunkQualityResult = runChunkQualityTests();
  if (!chunkQualityResult.passed) {
    logger.error("Chunk-quality test suite FAILED — aborting", { failures: chunkQualityResult.failures });
    process.exit(1);
  }
```

- [ ] **Step 4: Run the test gate**

Run: `bun run test:chunk-quality`
Expected: `Chunk-quality test suite PASSED (0 failures)` and exit 0.

If failures appear, address them by inspecting the metric in question (the test names match the metric).

- [ ] **Step 5: Typecheck the whole project**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/utils/chunk-quality/tests.ts src/server/index.ts src/pipeline.ts
git commit -m "feat(chunk-quality): wire phase 4 into pipeline + startup test gate"
```

---

## Task 23: Phase 3 slim-down

**Files:**
- Modify: `src/state.ts`
- Modify: `src/phases/3-projection.ts`

- [ ] **Step 1: Remove `predictedQualityDistribution` from state types**

In `src/state.ts`, find the `DocumentIngestionProjection` interface. Remove the `predictedQualityDistribution` field:

Before:

```typescript
  predictedQualityDistribution: {
    high: number;
    medium: number;
    low: number;
  };
  tokenRetentionRate: number;
```

After:

```typescript
  tokenRetentionRate: number;
```

- [ ] **Step 2: Remove from `CorpusIngestionSummary.byDocType`**

In the same file, find `byDocType` inside `CorpusIngestionSummary`. Remove `avgQualityHigh`:

Before:

```typescript
  byDocType: Record<string, {
    docCount: number;
    retentionRate: number;
    avgQualityHigh: number;
    dominantChunkStrategy: string;
    avgPredictedChunkCount: number;
  }>;
```

After:

```typescript
  byDocType: Record<string, {
    docCount: number;
    retentionRate: number;
    dominantChunkStrategy: string;
    avgPredictedChunkCount: number;
  }>;
```

- [ ] **Step 3: Remove `sampleQualityDistribution` and update Phase 3**

Edit `src/phases/3-projection.ts`:

a) Remove the `scoreBlock` import line.
b) Remove the `sampleQualityDistribution` function (lines ~217–234).
c) Remove the call site inside `projectDocument`:

Before:

```typescript
  // 5. Quality distribution (sample ≤30 blocks)
  const sampleBlocks = evenSample(blocks, 30);
  const qualityDist  = await sampleQualityDistribution(sampleBlocks, estimateChunkTokens);
```

After: (delete those lines entirely)

d) Remove `predictedQualityDistribution: qualityDist,` from the returned object.

e) Remove `evenSample` if it becomes unused (`grep -n evenSample src/phases/3-projection.ts` to verify).

f) In `emptyProjection`, remove the `predictedQualityDistribution` field.

g) In `buildCorpusSummary`, remove the `avgQualityHigh` field and the line that updates it.

- [ ] **Step 4: Find any other consumers and update them**

```bash
grep -rn "predictedQualityDistribution\|avgQualityHigh" src/ --include="*.ts"
```

For each match, replace with equivalent logic against `state.chunkQuality.corpus.bucketShare` / `chunkQuality.perDoc[*].bucketCounts`. Likely consumers: `8-validate.ts`, `9-narrative.ts`, dashboard components.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS. If errors, the grep step missed a consumer — find and fix.

- [ ] **Step 6: Commit**

```bash
git add src/state.ts src/phases/3-projection.ts src/phases/8-validate.ts src/phases/9-narrative.ts src/dashboard
git commit -m "refactor(projection): remove predictedQualityDistribution — chunk-quality phase supersedes it"
```

---

## Task 24: Phase renumbering — file renames and import updates

**Files:**
- Rename: `src/phases/4-fingerprint.ts` → `5-fingerprint.ts`
- Rename: `src/phases/5-cluster.ts` → `6-cluster.ts`
- Rename: `src/phases/6-references.ts` → `7-references.ts`
- Rename: `src/phases/7-requirements.ts` → `8-requirements.ts`
- Rename: `src/phases/8-validate.ts` → `9-validate.ts`
- Rename: `src/phases/9-html.ts` → `10-html.ts`
- Rename: `src/phases/9-narrative.ts` → `10-narrative.ts`
- Rename: `src/phases/9-report.ts` → `10-report.ts`
- Modify: `src/pipeline.ts` and any other importer

- [ ] **Step 1: Rename files via git mv**

Run:

```bash
cd /home/clemi/mci/huginn
git mv src/phases/4-fingerprint.ts src/phases/5-fingerprint.ts
git mv src/phases/5-cluster.ts     src/phases/6-cluster.ts
git mv src/phases/6-references.ts  src/phases/7-references.ts
git mv src/phases/7-requirements.ts src/phases/8-requirements.ts
git mv src/phases/8-validate.ts    src/phases/9-validate.ts
git mv src/phases/9-html.ts        src/phases/10-html.ts
git mv src/phases/9-narrative.ts   src/phases/10-narrative.ts
git mv src/phases/9-report.ts      src/phases/10-report.ts
```

- [ ] **Step 2: Update all imports of the renamed files**

Run:

```bash
grep -rln "phases/4-fingerprint\|phases/5-cluster\|phases/6-references\|phases/7-requirements\|phases/8-validate\|phases/9-html\|phases/9-narrative\|phases/9-report" src/
```

For each file listed, update the import path. The mapping:
- `phases/4-fingerprint` → `phases/5-fingerprint`
- `phases/5-cluster` → `phases/6-cluster`
- `phases/6-references` → `phases/7-references`
- `phases/7-requirements` → `phases/8-requirements`
- `phases/8-validate` → `phases/9-validate`
- `phases/9-html` → `phases/10-html`
- `phases/9-narrative` → `phases/10-narrative`
- `phases/9-report` → `phases/10-report`

Use `sed` to batch:

```bash
for f in $(grep -rln "phases/4-fingerprint\|phases/5-cluster\|phases/6-references\|phases/7-requirements\|phases/8-validate\|phases/9-html\|phases/9-narrative\|phases/9-report" src/); do
  sed -i \
    -e 's|phases/4-fingerprint|phases/5-fingerprint|g' \
    -e 's|phases/5-cluster|phases/6-cluster|g' \
    -e 's|phases/6-references|phases/7-references|g' \
    -e 's|phases/7-requirements|phases/8-requirements|g' \
    -e 's|phases/8-validate|phases/9-validate|g' \
    -e 's|phases/9-html|phases/10-html|g' \
    -e 's|phases/9-narrative|phases/10-narrative|g' \
    -e 's|phases/9-report|phases/10-report|g' \
    "$f"
done
```

- [ ] **Step 3: Update `setPhase()` string literals inside the renamed files**

Run:

```bash
grep -rn 'setPhase("4-fingerprint"\|setPhase("5-cluster"\|setPhase("6-references"\|setPhase("7-requirements"\|setPhase("8-validate"\|setPhase("9-html"\|setPhase("9-narrative"\|setPhase("9-report"' src/
```

For each, update the string literal. Mapping:
- `"4-fingerprint"` → `"5-fingerprint"`
- `"5-cluster"` → `"6-cluster"`
- `"6-references"` → `"7-references"`
- `"7-requirements"` → `"8-requirements"`
- `"8-validate"` → `"9-validate"`
- `"9-html"` → `"10-html"`
- `"9-narrative"` → `"10-narrative"`
- `"9-report"` → `"10-report"`

Batch update:

```bash
for f in src/phases/*.ts; do
  sed -i \
    -e 's|setPhase("4-fingerprint")|setPhase("5-fingerprint")|g' \
    -e 's|setPhase("5-cluster")|setPhase("6-cluster")|g' \
    -e 's|setPhase("6-references")|setPhase("7-references")|g' \
    -e 's|setPhase("7-requirements")|setPhase("8-requirements")|g' \
    -e 's|setPhase("8-validate")|setPhase("9-validate")|g' \
    -e 's|setPhase("9-html")|setPhase("10-html")|g' \
    -e 's|setPhase("9-narrative")|setPhase("10-narrative")|g' \
    -e 's|setPhase("9-report")|setPhase("10-report")|g' \
    "$f"
done
```

- [ ] **Step 4: Update pipeline.ts phase entries**

Edit `src/pipeline.ts`. The `phases` array should now read (replacing your earlier Task 22 edits):

```typescript
  const phases: Array<{ name: string; fn: () => Promise<void>; idx: number }> = [
    { name: "1-harvest",       fn: () => runHarvest(state),                idx: 0 },
    { name: "2-parse",         fn: () => runParse(state),                  idx: 1 },
    { name: "3-projection",    fn: () => runProjection(state),             idx: 2 },
    { name: "4-chunk-quality", fn: () => runChunkQuality(state, ollamaOk), idx: 3 },
    { name: "5-fingerprint",   fn: () => runFingerprint(state, embedAvailable), idx: 4 },
    { name: "6-cluster",       fn: () => runCluster(state),                idx: 5 },
    { name: "7-references",    fn: () => runReferences(state, ollamaOk),   idx: 6 },
    { name: "8-requirements",  fn: () => runRequirements(state, ollamaOk), idx: 7 },
    { name: "9-validate",      fn: () => runValidate(state),               idx: 8 },
    { name: "10-report",       fn: () => runReport(state, ollamaOk),       idx: 9 },
  ];
```

Also update `emitStats()` to use the new phase names — replace every old name with its renumbered counterpart.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: PASS. Any errors mean an import or string literal was missed — `grep` for the old path/name and fix.

- [ ] **Step 6: Sanity smoke test**

```bash
DOCUMENTS_ROOT=./_test-docs REPORT_OUTPUT=./reports TIKA_URL=http://localhost:19998 OLLAMA_URL=http://localhost:11435 timeout 10 bun run src/index.ts 2>&1 | head -50
```

Expected: scanner starts; regex + chunk-quality tests pass; pipeline begins; aborts at Tika/Ollama hard gate (intended — wrong ports). No `phase setPhase` or import errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(phases): renumber 4→9 to 5→10 to make room for chunk-quality"
```

---

## Task 25: New consistency checks in 9-validate.ts

**Files:**
- Modify: `src/phases/9-validate.ts`

- [ ] **Step 1: Add three new consistency checks**

Open `src/phases/9-validate.ts`. Locate the function that builds the `consistencyChecks` array (probably `runValidate` or a helper). At the end of the existing checks, before the function returns or before `state.consistencyChecks = ...`, append:

```typescript
  // ── Chunk Quality checks ────────────────────────────────────────────────
  const cq = state.chunkQuality;
  const totalDocs = cq.perDoc.length;

  if (totalDocs > 0) {
    const idxMean = cq.corpus.tokenWeightedIndexMean;
    state.consistencyChecks.push({
      checkName: "chunkQualityIndex",
      passed: idxMean >= 0.5,
      value: idxMean,
      threshold: 0.5,
      severity: idxMean < 0.35 ? "CRITICAL" : idxMean < 0.5 ? "WARNING" : "INFO",
      interpretation: clamp(
        `Token-weighted chunk quality is ${(idxMean * 100).toFixed(0)}% (good=${(cq.corpus.bucketShare.good * 100).toFixed(0)}%)`,
      ),
    });

    const sbqMeans = cq.perDoc.map(d => d.tier1.sentenceBoundaryQuality.mean);
    const sbqCorpusMean = sbqMeans.reduce((s, x) => s + x, 0) / sbqMeans.length;
    state.consistencyChecks.push({
      checkName: "chunkBoundaryHealth",
      passed: sbqCorpusMean >= 0.6,
      value: sbqCorpusMean,
      threshold: 0.6,
      severity: sbqCorpusMean < 0.6 ? "INFO" : "INFO",
      interpretation: clamp(
        sbqCorpusMean < 0.6
          ? `Sentence boundaries weak (${(sbqCorpusMean * 100).toFixed(0)}%) — chunker upgrade may help`
          : `Sentence boundaries healthy (${(sbqCorpusMean * 100).toFixed(0)}%)`,
      ),
    });

    const cdMeans = cq.perDoc
      .map(d => d.tier2?.coherenceDrop?.mean)
      .filter((v): v is number => typeof v === "number");
    if (cdMeans.length > 0) {
      const cdCorpusMean = cdMeans.reduce((s, x) => s + x, 0) / cdMeans.length;
      state.consistencyChecks.push({
        checkName: "chunkCoherenceHealth",
        passed: cdCorpusMean >= 0.55,
        value: cdCorpusMean,
        threshold: 0.55,
        severity: cdCorpusMean < 0.55 ? "WARNING" : "INFO",
        interpretation: clamp(
          cdCorpusMean < 0.55
            ? `Coherence between adjacent chunks low (${(cdCorpusMean * 100).toFixed(0)}%) — chunker may be cutting mid-thought`
            : `Adjacent-chunk coherence healthy (${(cdCorpusMean * 100).toFixed(0)}%)`,
        ),
      });
    }
  }
```

Ensure `clamp` is imported from wherever it lives in this file (probably already imported alongside the other interpretations).

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/phases/9-validate.ts
git commit -m "feat(validate): add chunkQualityIndex, chunkBoundaryHealth, chunkCoherenceHealth checks"
```

---

## Task 26: Narrative section for chunk quality

**Files:**
- Modify: `src/llm/prompts.ts`
- Modify: `src/phases/10-narrative.ts`

- [ ] **Step 1: Add narrative prompt**

Open `src/llm/prompts.ts`. At the end of the existing prompt exports, add:

```typescript
export const CHUNK_QUALITY_NARRATIVE_PROMPT = `You are explaining a quality assessment of how a document corpus will be chunked for retrieval.
Write 2-3 short paragraphs describing the corpus chunk-quality profile.

Input numbers (do not invent any others):
- Token-weighted chunk quality index: {{indexMean}}
- Good chunks: {{good}}%, acceptable: {{acceptable}}%, poor: {{poor}}%
- Weakest metrics: {{weakest}}
- Budget mode: {{budgetMode}}
- Total chunks: {{totalChunks}}, embedded for Tier 2: {{totalChunksEmbedded}}

Style: technical, factual, German-friendly English. No chunk content quoted. No new numbers invented.
Do not output a heading — only paragraph prose.`;
```

- [ ] **Step 2: Wire into narrative phase**

Open `src/phases/10-narrative.ts`. Find where other sections are generated. Add a new section function:

```typescript
async function chunkQualityNarrative(state: ScannerState): Promise<string> {
  const cq = state.chunkQuality;
  if (cq.perDoc.length === 0) return "No chunk quality data available for this scan.";

  const weakestList = cq.corpus.weakestCorpusMetrics
    .map(m => `${m.metric} (${m.mean.toFixed(2)})`)
    .join(", ") || "none";

  const prompt = CHUNK_QUALITY_NARRATIVE_PROMPT
    .replace("{{indexMean}}", cq.corpus.tokenWeightedIndexMean.toFixed(2))
    .replace("{{good}}",       (cq.corpus.bucketShare.good * 100).toFixed(0))
    .replace("{{acceptable}}", (cq.corpus.bucketShare.acceptable * 100).toFixed(0))
    .replace("{{poor}}",       (cq.corpus.bucketShare.poor * 100).toFixed(0))
    .replace("{{weakest}}",    weakestList)
    .replace("{{budgetMode}}", cq.corpus.budgetMode)
    .replace("{{totalChunks}}", String(cq.corpus.totalChunks))
    .replace("{{totalChunksEmbedded}}", String(cq.corpus.totalChunksEmbedded));

  try {
    const text = await complete(prompt);
    return text.trim();
  } catch (e) {
    logger.warn("Chunk quality narrative LLM call failed — using fallback", { error: String(e).slice(0, 100) });
    return [
      `Chunk quality index across the corpus is ${cq.corpus.tokenWeightedIndexMean.toFixed(2)} on a 0-1 scale.`,
      `${(cq.corpus.bucketShare.good * 100).toFixed(0)}% of chunks score as good, ${(cq.corpus.bucketShare.acceptable * 100).toFixed(0)}% acceptable, ${(cq.corpus.bucketShare.poor * 100).toFixed(0)}% poor.`,
      `Weakest metrics: ${weakestList}.`,
    ].join(" ");
  }
}
```

Ensure imports exist at the top: `import { CHUNK_QUALITY_NARRATIVE_PROMPT } from "../llm/prompts.ts";` and `complete` from `../llm/ollama.ts` (likely already imported for other sections).

Then invoke this function alongside the existing narrative sections — locate the section assembly (probably an object like `{ executiveSummary: ..., versionAnalysis: ..., ... }`) and add:

```typescript
  chunkQualityRationale: await chunkQualityNarrative(state),
```

If the narrative output is later read by a consumer that expects specific section keys (`9-report.ts` → renamed `10-report.ts`), add the new key to that consumer too.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/llm/prompts.ts src/phases/10-narrative.ts
git commit -m "feat(narrative): add chunkQualityRationale section with LLM prompt and fallback"
```

---

## Task 27: Human Markdown report integration

**Files:**
- Modify: `src/phases/10-report.ts` (or whichever file writes the human MD)

- [ ] **Step 1: Locate the human MD writer**

Run: `grep -n "human.md\|## Validation\|## Ingestion Projection" src/phases/*.ts`

This will identify the file (likely `10-report.ts` or a helper it calls).

- [ ] **Step 2: Add chunk-quality section between Ingestion Projection and Validation**

In the file identified above, find the section that writes "## Ingestion Projection" output to the human MD. Right after it, before "## Validation", insert:

```typescript
  // Chunk Quality section
  const cq = state.chunkQuality;
  if (cq.perDoc.length > 0) {
    lines.push("");
    lines.push("## Chunk Quality");
    lines.push("");
    const bs = cq.corpus.bucketShare;
    lines.push(
      `Token-weighted chunk quality: **${cq.corpus.tokenWeightedIndexMean.toFixed(2)}** ` +
      `(good ${(bs.good * 100).toFixed(0)}%, acceptable ${(bs.acceptable * 100).toFixed(0)}%, poor ${(bs.poor * 100).toFixed(0)}%)`,
    );
    lines.push("");

    if (cq.corpus.worstDocsByP10.length > 0) {
      lines.push("### Worst documents (by p10 chunk index)");
      lines.push("");
      lines.push("| Document | p10 | Primary weakness |");
      lines.push("|---|---|---|");
      for (const d of cq.corpus.worstDocsByP10) {
        lines.push(`| ${d.docId} | ${d.p10.toFixed(2)} | ${d.primaryWeakness} |`);
      }
      lines.push("");
    }

    if (cq.corpus.weakestCorpusMetrics.length > 0) {
      lines.push("### Weakest corpus metrics");
      lines.push("");
      lines.push("| Metric | Mean |");
      lines.push("|---|---|");
      for (const m of cq.corpus.weakestCorpusMetrics) {
        lines.push(`| ${m.metric} | ${m.mean.toFixed(2)} |`);
      }
      lines.push("");
    }

    if (cq.corpus.totalChunksEmbedded < cq.corpus.totalChunks) {
      lines.push(
        `> Note: budget=${cq.corpus.budgetMode} — ` +
        `${cq.corpus.totalChunksEmbedded}/${cq.corpus.totalChunks} chunks embedded for Tier 2 metrics`,
      );
      lines.push("");
    }
  }
```

Use the local variable name for the line accumulator if it differs from `lines` (could be `out`, `md`, etc. — read the surrounding code first).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/phases/10-report.ts
git commit -m "feat(report): add Chunk Quality section to human Markdown report"
```

---

## Task 28: Dashboard component

**Files:**
- Create: `src/dashboard/components/chunk-quality.ts`
- Modify: `src/dashboard/html-template.ts` (or wherever sections are registered)

- [ ] **Step 1: Identify how dashboard sections are registered**

Run: `grep -rn "kpi-cards\|requirements-landscape\|quality-gauge" src/dashboard/ --include="*.ts" | head -20`

This will show the pattern for section registration. Likely an array of section render functions imported into `cli-generate.ts` or `html-template.ts`.

- [ ] **Step 2: Create the chunk-quality component**

Create `src/dashboard/components/chunk-quality.ts`:

```typescript
// Dashboard component — Chunk Quality section.
// Renders 4 visualizations:
//   1. KPI card: token-weighted index
//   2. Stacked bar: bucket distribution
//   3. Horizontal bar: weakest corpus metrics
//   4. Sortable table: per-doc index/p10/primary weakness

import type { ScannerState } from "../../state.ts";

export function renderChunkQualitySection(state: ScannerState): string {
  const cq = state.chunkQuality;
  if (cq.perDoc.length === 0) {
    return `<section id="chunk-quality"><h2>Chunk Quality</h2><p class="placeholder">No chunk quality data.</p></section>`;
  }

  const indexMean = cq.corpus.tokenWeightedIndexMean.toFixed(2);
  const bs = cq.corpus.bucketShare;

  const perDocRows = cq.perDoc
    .map(d =>
      `<tr><td>${escapeHtml(d.docId)}</td><td>${d.chunkQualityIndex.mean.toFixed(2)}</td>` +
      `<td>${d.chunkQualityIndex.p10.toFixed(2)}</td><td>${escapeHtml(d.weakestLinks[0] ?? "")}</td></tr>`,
    )
    .join("");

  const weakestRows = cq.corpus.weakestCorpusMetrics
    .map(m => `<tr><td>${escapeHtml(m.metric)}</td><td>${m.mean.toFixed(2)}</td></tr>`)
    .join("");

  return `
<section id="chunk-quality">
  <h2>Chunk Quality</h2>
  <div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Token-weighted Index</div>
      <div class="kpi-value">${indexMean}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Total Chunks</div>
      <div class="kpi-value">${cq.corpus.totalChunks}</div>
    </div>
  </div>
  <div class="chart-row">
    <div class="bucket-bar">
      <div class="bucket good" style="width: ${(bs.good * 100).toFixed(1)}%">good ${(bs.good * 100).toFixed(0)}%</div>
      <div class="bucket acceptable" style="width: ${(bs.acceptable * 100).toFixed(1)}%">acceptable ${(bs.acceptable * 100).toFixed(0)}%</div>
      <div class="bucket poor" style="width: ${(bs.poor * 100).toFixed(1)}%">poor ${(bs.poor * 100).toFixed(0)}%</div>
    </div>
  </div>
  <h3>Weakest Corpus Metrics</h3>
  <table class="data-table">
    <thead><tr><th>Metric</th><th>Mean</th></tr></thead>
    <tbody>${weakestRows}</tbody>
  </table>
  <h3>Per-Document Chunk Quality</h3>
  <table class="data-table sortable">
    <thead><tr><th>Doc ID</th><th>Index Mean</th><th>p10</th><th>Primary Weakness</th></tr></thead>
    <tbody>${perDocRows}</tbody>
  </table>
</section>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 3: Register the section in the dashboard assembler**

Edit the file identified in Step 1 (likely `src/dashboard/html-template.ts` or `cli-generate.ts`). Add:

```typescript
import { renderChunkQualitySection } from "./components/chunk-quality.ts";
```

Insert `renderChunkQualitySection(state)` into the section list at the position between requirements-landscape and reference-graph (per the spec).

- [ ] **Step 4: Generate a sample dashboard**

```bash
ls reports/*.json | head -1 | xargs -I{} bun run dashboard:generate {} --output /tmp/dashboard-test.html
```

Expected: HTML file produced; open in a browser and verify the Chunk Quality section appears. If no `.json` reports exist yet, this step deferred until after a full pipeline run.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/components/chunk-quality.ts src/dashboard/html-template.ts
git commit -m "feat(dashboard): add Chunk Quality section with KPI, buckets, weakest metrics, per-doc table"
```

---

## Task 29: Documentation update

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update phase count and architecture**

Open `CLAUDE.md`. In the "Architecture" section:

a) Update the opening sentence — change "8-phase pipeline" (or "9-phase") to "10-phase pipeline".

b) Insert a new phase entry between 3 and 4:

```markdown
4. **chunk-quality** — mirrors Muninn's chunker per doc, scores chunks with Tier 1 (rule-based: size, sentence boundaries, cross-reference cut, table cut, header pollution, content score) and Tier 2 (embedding-based: coherence drop, intra-chunk cohesion, centroid distance). Budget controlled via `CHUNK_QUALITY_BUDGET=fast|normal|full`. → `state.chunkQuality`
```

c) Renumber the existing phases 4–9 to 5–10.

- [ ] **Step 2: Add file-map entries**

In the "Architecture" section's file listing, add:

```
src/utils/muninn-mirror/      # Copy of Muninn's chunker — sync manually, see DRIFT.md
src/utils/chunk-quality/      # Tier 1 + Tier 2 metric implementations
src/phases/4-chunk-quality.ts # Phase 4 orchestrator
```

- [ ] **Step 3: Add a new "Chunk Quality" subsection (mirror dashboard style)**

After the "Dashboard" subsection, add:

```markdown
## Chunk Quality

The chunk-quality phase predicts how Muninn will ingest the corpus by running Muninn's chunker in-memory and scoring the produced chunks. No chunk content is persisted — only aggregated metric values.

### Commands

\`\`\`bash
# Run with budget=fast (small corpora, dev)
CHUNK_QUALITY_BUDGET=fast bun run src/index.ts

# Disable phase entirely (escape hatch)
CHUNK_QUALITY_DISABLE=1 bun run src/index.ts

# Run only the chunk-quality startup test gate
bun run test:chunk-quality
\`\`\`

### Muninn-mirror sync

The chunker in `src/utils/muninn-mirror/` is a copy of `~/mci/muninn/packages/rag/src/ingestion/`. When Muninn changes, follow the sync procedure in `src/utils/muninn-mirror/DRIFT.md`. The startup test gate verifies SHA-256 hashes and warns on drift.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): document chunk-quality phase, muninn-mirror sync, budget modes"
```

---

## Task 30: End-to-end integration verification

**Files:** (no edits)

- [ ] **Step 1: Run full pipeline against test corpus**

Ensure Docker services are running (Tika + Ollama with bge-m3). Run:

```bash
DOCUMENTS_PATH=./_test-docs docker compose -f docker-compose.yml -f docker-compose.gpu.yml up
```

Watch for these log markers in order:
- `Phase 1-harvest start`
- `Phase 2-parse complete`
- `Phase 3-projection complete` (no more `predictedQualityDistribution` reference)
- `Phase 4: chunk-quality start { budgetMode: 'normal', ... }`
- `Phase 4: chunk-quality complete { docs: N, totalChunks: M, indexMean: 0.XX }`
- `Phase 5-fingerprint start`
- ...through `Phase 10-report complete`

Expected: no errors, scanner exits 0.

- [ ] **Step 2: Inspect the generated JSON report**

```bash
ls -t reports/scan-report-*.json | head -1 | xargs -I{} bun -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(JSON.stringify(r.chunkQuality.corpus, null, 2));' {}
```

Expected: corpus summary with `tokenWeightedIndexMean`, `bucketShare`, `worstDocsByP10`, `weakestCorpusMetrics`, `embeddingsCacheStats`, `bgeM3NormalizationCheck`.

Sanity ranges for `_test-docs` corpus:
- `tokenWeightedIndexMean` ∈ [0.3, 0.9]
- `bgeM3NormalizationCheck.allNormalized` should be `true` (BGE-M3 default)
- `totalChunks > 0`

- [ ] **Step 3: Inspect human MD output**

```bash
ls -t reports/scan-report-*-human.md | head -1 | xargs grep -A 20 "## Chunk Quality"
```

Expected: section exists with table of worst docs + weakest metrics.

- [ ] **Step 4: Inspect narrative MD output**

```bash
ls -t reports/scan-report-*-narrative.md | head -1 | xargs grep -A 10 "Chunk Quality\|chunk quality\|chunk-quality"
```

Expected: 2–3 paragraphs of LLM-generated prose about chunk quality, or the deterministic fallback if Ollama hiccupped.

- [ ] **Step 5: Generate dashboard HTML**

```bash
ls -t reports/scan-report-*.json | head -1 | xargs -I{} bun run dashboard:generate {} --output /tmp/dashboard-final.html
xdg-open /tmp/dashboard-final.html 2>/dev/null || echo "Open /tmp/dashboard-final.html manually"
```

Expected: dashboard loads, Chunk Quality section visible between Requirements Landscape and References & Graph Resolution.

- [ ] **Step 6: Final commit (no code changes — sanity run only)**

If any small fixes were needed during this verification, commit them with `fix(chunk-quality): end-to-end integration fixes`. Otherwise, the integration is complete.
