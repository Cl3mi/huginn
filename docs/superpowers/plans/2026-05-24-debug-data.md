# Debug Data Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable `scan-report-<ts>-debug.json` output that captures per-document decision signals, regex pattern coverage, LLM per-doc trace, and zero-output document analysis — controlled by `debug-settings.json` and toggleable from the server UI.

**Architecture:** Four optional fields on `ScannerState` (`decisionAudit`, `patternCoverage`, `llmTrace`, `zeroOutputDocs`) are initialised by `pipeline.ts` when a category is enabled. Phases write to these fields only when they are defined. Phase 9 calls `writeDebugReport()` which computes pattern coverage + zero-output entries from state, then writes the debug JSON. The server exposes GET/PATCH `/api/debug-settings` to read and update `debug-settings.json`.

**Tech Stack:** Bun, TypeScript strict (`exactOptionalPropertyTypes: true`), `bun:test`, existing `src/server/routes.ts` pattern

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/debug/types.ts` | Create | All debug type interfaces |
| `src/debug/settings.ts` | Create | Load / save / merge `DebugSettings` |
| `src/debug/settings.test.ts` | Create | Tests for settings helpers |
| `src/debug/report.ts` | Create | `writeDebugReport()`, `computePatternCoverage()`, `computeZeroOutputEntries()`, `sanitizeDebugReport()` |
| `src/state.ts` | Modify | Add 4 optional debug fields to `ScannerState` |
| `src/pipeline.ts` | Modify | Load debug settings; initialize optional state fields |
| `src/phases/2-parse.ts` | Modify | Emit `DecisionRecord` per doc after classification |
| `src/phases/5-cluster.ts` | Modify | Emit `versionPairContributions` for score ≥ 5 pairs |
| `src/phases/7-requirements.ts` | Modify | Return per-doc LLM verdict stats; push to `state.llmTrace` |
| `src/phases/9-report.ts` | Modify | Call `writeDebugReport()` at end of phase |
| `src/server/routes.ts` | Modify | Add `GET /api/debug-settings` and `PATCH /api/debug-settings` |

---

## Task 1: Debug types and settings

**Files:**
- Create: `src/debug/types.ts`
- Create: `src/debug/settings.ts`
- Create: `src/debug/settings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/debug/settings.test.ts
import { expect, test } from "bun:test";
import { mergeDebugSettings } from "./settings.ts";
import type { DebugSettings } from "./settings.ts";

const base: DebugSettings = {
  enabled: false,
  decisionAudit: false,
  patternCoverage: false,
  llmTrace: false,
  zeroOutputDocs: false,
};

test("mergeDebugSettings applies boolean patches", () => {
  const result = mergeDebugSettings(base, { enabled: true, decisionAudit: true });
  expect(result.enabled).toBe(true);
  expect(result.decisionAudit).toBe(true);
  expect(result.patternCoverage).toBe(false);
});

test("mergeDebugSettings ignores non-boolean values", () => {
  // @ts-expect-error testing invalid input
  const result = mergeDebugSettings(base, { enabled: "yes" });
  expect(result.enabled).toBe(false);
});

test("mergeDebugSettings does not mutate original", () => {
  mergeDebugSettings(base, { enabled: true });
  expect(base.enabled).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/clemi/mci/huginn && bun test src/debug/settings.test.ts
```
Expected: error — `src/debug/settings.ts` does not exist yet.

- [ ] **Step 3: Create `src/debug/types.ts`**

```ts
// src/debug/types.ts

export interface DecisionRecord {
  docId: string;
  // docType classification signals — all values are counts or booleans, no text content
  docTypeSignals: Record<string, number | boolean>;
  docTypeChosen: string;
  // OEM detection
  oemDetected: string;
  oemSource: string;
  // Chunk strategy (mirrors chunkStrategyReasoning.signals — no new data, surfaced for debug)
  chunkStrategyChosen: string;
  chunkStrategyConfidence: number;
  chunkStrategySignals: {
    headingCount: number;
    headingDepth: number;
    tableCount: number;
    isXlsx: boolean;
    pdfClassification: string;
  };
  // Version pair contributions: only pairs with score >= 5 (MEDIUM or HIGH)
  versionPairContributions?: Array<{
    partnerDocId: string;
    score: number;
    filenameNormalizedSimilarity: number;
    headingMinHashJaccard: number;
    semanticCosineSimilarity: number;
    structuralMatch: boolean;
    sameDirectory: boolean;
  }>;
}

export interface PatternCoverageEntry {
  patternName: string;   // source-code identifier, exempt from 60-char guard
  phase: "references" | "requirements";
  matchCount: number;
  matchedDocIds: string[];
  zeroMatch: boolean;
}

export interface LlmSampleRecord {
  docId: string;
  docType: string;
  regexCount: number;          // confirmed requirements from regex for this doc
  llmConfirmedCount: number;   // PLAUSIBLE verdicts from LLM for sampled sections
  llmRejectedCount: number;    // HIGH verdicts (LLM rejects regex count)
  llmRecoveredCount: number;   // LOW verdicts (LLM finds more than regex)
  delta: number;               // (rejected + recovered) / (confirmed + rejected + recovered)
  llmCallDurationMs: number;   // cumulative LLM time for this doc's sections
}

export interface ZeroOutputEntry {
  docId: string;
  docType: string;
  parseSuccess: boolean;
  requirementCount: number;
  referenceCount: number;
  tokenRetentionRate: number;
  likelyCause: "parse_failure" | "scanned_pdf" | "wrong_doc_type" | "regex_miss" | "unknown";
}
```

- [ ] **Step 4: Create `src/debug/settings.ts`**

```ts
// src/debug/settings.ts
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { CONFIG } from "../config.ts";

export interface DebugSettings {
  enabled: boolean;
  decisionAudit: boolean;    // medium privacy: heading fragment keys used as signal labels
  patternCoverage: boolean;  // low privacy: pattern names + match counts + doc IDs only
  llmTrace: boolean;         // low privacy: counts + doc IDs only, no content
  zeroOutputDocs: boolean;   // low privacy: doc IDs, counts, and inferred cause only
}

const DEFAULT: DebugSettings = {
  enabled: false,
  decisionAudit: false,
  patternCoverage: false,
  llmTrace: false,
  zeroOutputDocs: false,
};

function settingsPath(): string {
  return join(CONFIG.reportOutput, "debug-settings.json");
}

export function loadDebugSettings(): DebugSettings {
  try {
    const raw = readFileSync(settingsPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<DebugSettings>;
    return { ...DEFAULT, ...parsed };
  } catch {
    return { ...DEFAULT };
  }
}

export function saveDebugSettings(settings: DebugSettings): void {
  const path = settingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(settings, null, 2), "utf-8");
}

export function mergeDebugSettings(
  current: DebugSettings,
  patch: Partial<DebugSettings>,
): DebugSettings {
  const result = { ...current };
  for (const key of Object.keys(patch) as Array<keyof DebugSettings>) {
    if (typeof patch[key] === "boolean") {
      (result as Record<string, boolean>)[key] = patch[key] as boolean;
    }
  }
  return result;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /home/clemi/mci/huginn && bun test src/debug/settings.test.ts
```
Expected: 3 pass, 0 fail.

- [ ] **Step 6: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/debug/types.ts src/debug/settings.ts src/debug/settings.test.ts
git commit -m "feat(debug): add debug types, settings load/save, and tests"
```

---

## Task 2: State additions and pipeline initialization

**Files:**
- Modify: `src/state.ts`
- Modify: `src/pipeline.ts`

- [ ] **Step 1: Add optional debug fields to `ScannerState` in `src/state.ts`**

Add these imports at the top of `src/state.ts` (after existing imports):

```ts
import type { DecisionRecord, PatternCoverageEntry, LlmSampleRecord, ZeroOutputEntry } from "./debug/types.ts";
```

Add these four optional fields to the `ScannerState` interface, after the `domainProfile` field:

```ts
  // Optional debug fields — undefined = category disabled for this scan
  decisionAudit?: Map<string, DecisionRecord>;
  patternCoverage?: PatternCoverageEntry[];
  llmTrace?: LlmSampleRecord[];
  zeroOutputDocs?: ZeroOutputEntry[];
```

No changes to `createInitialState()` — `pipeline.ts` initialises these fields after creation.

- [ ] **Step 2: Initialise debug fields in `src/pipeline.ts`**

Add this import at the top of `src/pipeline.ts` (after existing imports):

```ts
import { loadDebugSettings } from "./debug/settings.ts";
```

Replace this line in `runPipeline`:
```ts
  const state = createInitialState(scanId, folder, profile, companyIdentity);
```
with:
```ts
  const debugSettings = loadDebugSettings();
  const state = createInitialState(scanId, folder, profile, companyIdentity);
  if (debugSettings.enabled) {
    if (debugSettings.decisionAudit)  state.decisionAudit  = new Map();
    if (debugSettings.patternCoverage) state.patternCoverage = [];
    if (debugSettings.llmTrace)        state.llmTrace        = [];
    if (debugSettings.zeroOutputDocs)  state.zeroOutputDocs  = [];
  }
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/state.ts src/pipeline.ts
git commit -m "feat(debug): add optional debug fields to ScannerState; init in pipeline"
```

---

## Task 3: Phase 2 — DecisionRecord emission

**Files:**
- Modify: `src/phases/2-parse.ts`

Phase 2 classifies each doc's type, OEM, and chunk strategy. We add two private helpers and a post-parse emission block.

- [ ] **Step 1: Add debug signal helpers to `src/phases/2-parse.ts`**

Insert this block just before the `export async function runParse` declaration (around line 427):

```ts
// ── Debug helpers (no-op when state.decisionAudit is undefined) ──────────────

function buildDocTypeDebugSignals(
  filename: string,
  headings: string[],
  sample: string,
): Record<string, number | boolean> {
  const fn = filename.toLowerCase();
  const content = [...headings.map((h) => h.toLowerCase()), sample.toLowerCase()].join(" ");
  return {
    headingCount: headings.length,
    filenameMatchFired:
      /\bfmea\b|\baudit\b|\bsrs\b|\birs\b|\blastenheft\b|\btestbericht\b|\babweichliste\b|\bpruefspec\b|\bprüfspec\b|\bmilestones?\b|\brisk\b|\bplanning\b|\bangebot\b|\b8d\b|\bempb\b|\bkontrollplan\b|\bserienfreigabe\b|\breklamation\b|\barbeitsanweisung\b|\bprotokoll\b|\bhandbuch\b|\bsla\b|\blessons?\b/i.test(fn),
    hasFmeaSignal:   /\bfmea\b/i.test(fn) || /\bfmea\b/i.test(content),
    hasLastenheftSignal: /\b(srs|irs|lastenheft|anforderung|requirement)\b/i.test(fn) || /lastenheft|anforderung|requirement/i.test(content),
    hasTestberichtSignal: /testbericht|ergebnisbericht|prüfbericht/i.test(fn) || /testbericht|ergebnisbericht/i.test(content),
    hasAbweichlisteSignal: /abweichliste/i.test(fn) || /abweichliste|abweichungsliste/i.test(content),
    hasNormSignal: /iso\s*\d|din\s*\d|en\s*\d|\bnorm\b/i.test(content),
  };
}

function buildOemDebugSignals(
  sample: string,
  headings: string[],
  pathSegments: string[],
): Record<string, boolean> {
  const text = [sample, ...headings, pathSegments.join(" ")].join(" ");
  const hasFikb = PATTERNS.fikb.test(text); PATTERNS.fikb.lastIndex = 0;
  const hasKbMaster = PATTERNS.kbMaster.test(text); PATTERNS.kbMaster.lastIndex = 0;
  const hasQv = PATTERNS.qualitySpec.test(text); PATTERNS.qualitySpec.lastIndex = 0;
  return {
    hasFikbPattern: hasFikb,
    hasKbMasterPattern: hasKbMaster,
    hasQvPattern: hasQv,
    hasMercedesKeyword: /\bmerced(es|benz)\b/i.test(text),
    hasBmwKeyword: /\bbmw\b/i.test(text),
    hasAudiKeyword: /\baudi\b/i.test(text),
  };
}
```

- [ ] **Step 2: Emit DecisionRecord inside `runParse` loop**

In `runParse`, find the line:
```ts
    state.parsed.push(parsed);
```
Add this block immediately after it:
```ts
    if (state.decisionAudit !== undefined) {
      const sample = (parsed.textContent ?? "").slice(0, 2000);
      const headingTexts = parsed.headings.map((h) => h.text);
      state.decisionAudit.set(parsed.id, {
        docId: parsed.id,
        docTypeSignals: {
          ...buildDocTypeDebugSignals(parsed.filename, headingTexts, sample),
          ...buildOemDebugSignals(sample, headingTexts, parsed.pathSegments),
        },
        docTypeChosen: parsed.detectedDocType ?? "other",
        oemDetected: parsed.detectedOem ?? "unknown",
        oemSource: parsed.oemSource ?? "folder",
        chunkStrategyChosen: parsed.recommendedChunkStrategy,
        chunkStrategyConfidence: parsed.chunkStrategyReasoning.confidence,
        chunkStrategySignals: {
          headingCount: parsed.chunkStrategyReasoning.signals.headingCount,
          headingDepth: parsed.chunkStrategyReasoning.signals.headingDepth,
          tableCount: parsed.chunkStrategyReasoning.signals.tableCount,
          isXlsx: parsed.chunkStrategyReasoning.signals.isXlsx,
          pdfClassification: parsed.chunkStrategyReasoning.signals.pdfClassification,
        },
      });
    }
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/phases/2-parse.ts
git commit -m "feat(debug): emit DecisionRecord per doc in Phase 2"
```

---

## Task 4: Phase 5 — version pair contributions

**Files:**
- Modify: `src/phases/5-cluster.ts`

Phase 5 scores all pairs. We add version pair signal contributions to the `DecisionRecord` for pairs with score ≥ 5.

- [ ] **Step 1: Add contribution emission in `runCluster`**

In `src/phases/5-cluster.ts`, find the block:
```ts
      if (pair.confidence !== "NOT_A_PAIR") {
        state.versionPairs.push(pair);
        if (pair.confidence === "HIGH") highConfidencePairs++;
      }
```
Replace it with:
```ts
      if (pair.confidence !== "NOT_A_PAIR") {
        state.versionPairs.push(pair);
        if (pair.confidence === "HIGH") highConfidencePairs++;
      }

      // Debug: record signal breakdown for MEDIUM (≥5) and HIGH pairs
      if (pair.score >= 5 && state.decisionAudit !== undefined) {
        const contribution = {
          partnerDocId: docB.id,
          score: pair.score,
          filenameNormalizedSimilarity: pair.signals.filenameNormalizedSimilarity,
          headingMinHashJaccard: pair.signals.headingMinHashJaccard,
          semanticCosineSimilarity: pair.signals.semanticCosineSimilarity,
          structuralMatch: pair.signals.structuralMatch,
          sameDirectory: pair.signals.sameDirectory,
        };
        const recA = state.decisionAudit.get(docA.id);
        if (recA !== undefined) {
          if (recA.versionPairContributions === undefined) {
            recA.versionPairContributions = [];
          }
          recA.versionPairContributions.push(contribution);
        }
      }
```

Note: the `state.decisionAudit` import is already available via `ScannerState` — no new imports needed.

- [ ] **Step 2: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/phases/5-cluster.ts
git commit -m "feat(debug): emit versionPairContributions (score >= 5) in Phase 5"
```

---

## Task 5: Phase 7 — per-doc LLM trace

**Files:**
- Modify: `src/phases/7-requirements.ts`

The `validateWithLlm` function currently aggregates all section verdicts. We extend its return type with per-doc stats and emit `LlmSampleRecord` entries when `state.llmTrace` is defined.

- [ ] **Step 1: Add `perDocStats` to `validateWithLlm` return**

In `src/phases/7-requirements.ts`, find the `validateWithLlm` function. At the top of its body, add:

```ts
  const perDocStats = new Map<string, { confirmed: number; rejected: number; recovered: number; durationMs: number }>();
```

In the loop body, find the line:
```ts
    sampledDocIds.push(docId);
```
Add immediately after it:
```ts
    if (!perDocStats.has(docId)) {
      perDocStats.set(docId, { confirmed: 0, rejected: 0, recovered: 0, durationMs: 0 });
    }
```

Wrap the LLM call to capture timing. Find:
```ts
    let verdict = "PLAUSIBLE";
    try {
      const prompt = requirementValidationPrompt(signals);
      const response = await complete(prompt, { temperature: 0.0, maxTokens: 10 });
      verdict = response.trim().toUpperCase().split(/\s+/)[0] ?? "PLAUSIBLE";
    } catch (e) {
```
Replace with:
```ts
    let verdict = "PLAUSIBLE";
    const callStart = Date.now();
    try {
      const prompt = requirementValidationPrompt(signals);
      const response = await complete(prompt, { temperature: 0.0, maxTokens: 10 });
      verdict = response.trim().toUpperCase().split(/\s+/)[0] ?? "PLAUSIBLE";
    } catch (e) {
```
After the `try/catch` block (after `continue`), add:
```ts
    const callDurationMs = Date.now() - callStart;
    perDocStats.get(docId)!.durationMs += callDurationMs;
```

Update the verdict counting block. Find:
```ts
    if (verdict.startsWith("LOW")) { lowCount++; }
    else if (verdict.startsWith("HIGH")) { highCount++; }
    else { plausibleCount++; }
```
Replace with:
```ts
    const docVerdicts = perDocStats.get(docId)!;
    if (verdict.startsWith("LOW")) {
      lowCount++;
      docVerdicts.recovered++;
    } else if (verdict.startsWith("HIGH")) {
      highCount++;
      docVerdicts.rejected++;
    } else {
      plausibleCount++;
      docVerdicts.confirmed++;
    }
```

Add `perDocStats` to the return value. Find the return statement and add:
```ts
    perDocStats,
```
to the returned object (alongside the existing fields).

The `validateWithLlm` function's inferred return type will now include `perDocStats`. TypeScript infers this automatically — no explicit return type annotation needed (the function already has none).

- [ ] **Step 2: Emit `LlmSampleRecord` entries in `runRequirements`**

In `runRequirements`, find:
```ts
    state.llmValidation = {
```
Add this block immediately after the closing `};` of the `state.llmValidation` assignment:
```ts
    if (state.llmTrace !== undefined && validation.perDocStats.size > 0) {
      for (const [docId, stats] of validation.perDocStats) {
        const doc = state.parsed.find((d) => d.id === docId);
        const regexCount = doc?.requirementQuality?.confirmed ?? 0;
        const total = stats.confirmed + stats.rejected + stats.recovered;
        state.llmTrace.push({
          docId,
          docType: doc?.detectedDocType ?? "other",
          regexCount,
          llmConfirmedCount: stats.confirmed,
          llmRejectedCount: stats.rejected,
          llmRecoveredCount: stats.recovered,
          delta: total > 0 ? (stats.rejected + stats.recovered) / total : 0,
          llmCallDurationMs: stats.durationMs,
        });
      }
    }
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/phases/7-requirements.ts
git commit -m "feat(debug): capture per-doc LLM verdict stats in Phase 7"
```

---

## Task 6: Debug report writer

**Files:**
- Create: `src/debug/report.ts`

This module computes pattern coverage and zero-output entries from finalized state, then writes the debug JSON file. It is called by Phase 9.

- [ ] **Step 1: Create `src/debug/report.ts`**

```ts
// src/debug/report.ts
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { ScannerState } from "../state.ts";
import type { PatternCoverageEntry, ZeroOutputEntry } from "./types.ts";
import { CONFIG } from "../config.ts";

const DEBUG_STRING_MAX = 60;
const EXEMPT_KEYS = new Set(["patternName"]);

function deepTruncateDebug(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.length > DEBUG_STRING_MAX ? obj.slice(0, DEBUG_STRING_MAX) : obj;
  }
  if (Array.isArray(obj)) return obj.map(deepTruncateDebug);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = EXEMPT_KEYS.has(key) ? val : deepTruncateDebug(val);
    }
    return result;
  }
  return obj;
}

function sanitizeDebugReport(obj: unknown, path = "root"): void {
  if (typeof obj === "string") {
    if (obj.length > DEBUG_STRING_MAX) {
      throw new Error(
        `Debug report guard at ${path}: string length ${obj.length} > ${DEBUG_STRING_MAX}`,
      );
    }
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => sanitizeDebugReport(item, `${path}[${i}]`));
    return;
  }
  if (obj !== null && typeof obj === "object") {
    for (const [key, val] of Object.entries(obj)) {
      if (!EXEMPT_KEYS.has(key)) sanitizeDebugReport(val, `${path}.${key}`);
    }
  }
}

type RefType = "iso_norm" | "din_norm" | "en_norm" | "vda_norm" | "iatf_norm" | "quality_spec" | "fikb" | "kb_master" | "chapter_ref" | "doc_ref";

function computePatternCoverage(state: ScannerState): PatternCoverageEntry[] {
  const entries: PatternCoverageEntry[] = [];

  // Reference patterns
  const refPatterns: Array<{ name: string; types: RefType[] }> = [
    { name: "NORM", types: ["iso_norm", "din_norm", "en_norm", "vda_norm", "iatf_norm"] },
    { name: "QUALITY_SPEC", types: ["quality_spec"] },
    { name: "FIKB", types: ["fikb"] },
    { name: "KB_MASTER", types: ["kb_master"] },
    { name: "CHAPTER_REF", types: ["chapter_ref"] },
    { name: "DOC_REF", types: ["doc_ref"] },
  ];
  for (const { name, types } of refPatterns) {
    const typeSet = new Set<string>(types);
    const matching = state.references.filter((r) => typeSet.has(r.type));
    entries.push({
      patternName: name,
      phase: "references",
      matchCount: matching.length,
      matchedDocIds: [...new Set(matching.map((r) => r.docId))],
      zeroMatch: matching.length === 0,
    });
  }

  // Requirement patterns (from state.requirements — reliable docs only).
  // INFORMATIVE is excluded: Phase 7 filters it out before pushing to state.requirements,
  // so it would always show zero-match and create a misleading signal.
  const reqTypes = ["MANDATORY", "RECOMMENDED", "PERMITTED", "DECLARATIVE"] as const;
  for (const reqType of reqTypes) {
    const matching = state.requirements.filter((r) => r.type === reqType);
    entries.push({
      patternName: reqType,
      phase: "requirements",
      matchCount: matching.length,
      matchedDocIds: [...new Set(matching.map((r) => r.docId))],
      zeroMatch: matching.length === 0,
    });
  }

  return entries;
}

const WRONG_DOC_TYPES = new Set<string>(["planning", "protokoll", "other"]);

function computeZeroOutputEntries(state: ScannerState): ZeroOutputEntry[] {
  const reqCountByDoc = new Map<string, number>();
  for (const r of state.requirements) {
    reqCountByDoc.set(r.docId, (reqCountByDoc.get(r.docId) ?? 0) + 1);
  }
  const refCountByDoc = new Map<string, number>();
  for (const r of state.references) {
    refCountByDoc.set(r.docId, (refCountByDoc.get(r.docId) ?? 0) + 1);
  }

  const entries: ZeroOutputEntry[] = [];
  for (const doc of state.parsed) {
    const reqCount = reqCountByDoc.get(doc.id) ?? 0;
    const refCount = refCountByDoc.get(doc.id) ?? 0;
    const proj = state.ingestionProjections.find((p) => p.docId === doc.id);
    const retentionRate = proj?.tokenRetentionRate ?? 0;

    const isInteresting = (reqCount === 0 && refCount === 0) || retentionRate < 0.10;
    if (!isInteresting) continue;

    let likelyCause: ZeroOutputEntry["likelyCause"];
    if (!doc.parseSuccess)                                    likelyCause = "parse_failure";
    else if (doc.pdfClassification === "fully_scanned")       likelyCause = "scanned_pdf";
    else if (WRONG_DOC_TYPES.has(doc.detectedDocType ?? "")) likelyCause = "wrong_doc_type";
    else if (doc.parseSuccess)                                likelyCause = "regex_miss";
    else                                                      likelyCause = "unknown";

    entries.push({
      docId: doc.id,
      docType: doc.detectedDocType ?? "other",
      parseSuccess: doc.parseSuccess,
      requirementCount: reqCount,
      referenceCount: refCount,
      tokenRetentionRate: retentionRate,
      likelyCause,
    });
  }
  return entries;
}

export function writeDebugReport(state: ScannerState, timestamp: string): string | null {
  const anyEnabled =
    state.decisionAudit !== undefined ||
    state.patternCoverage !== undefined ||
    state.llmTrace !== undefined ||
    state.zeroOutputDocs !== undefined;

  if (!anyEnabled) return null;

  // Populate computed categories
  if (state.patternCoverage !== undefined) {
    state.patternCoverage.push(...computePatternCoverage(state));
  }
  if (state.zeroOutputDocs !== undefined) {
    state.zeroOutputDocs.push(...computeZeroOutputEntries(state));
  }

  const output = {
    scanId: state.scanId,
    generatedAt: new Date().toISOString(),
    categories: {
      decisionAudit:
        state.decisionAudit !== undefined
          ? { enabled: true, records: [...state.decisionAudit.values()] }
          : { enabled: false },
      patternCoverage:
        state.patternCoverage !== undefined
          ? { enabled: true, entries: state.patternCoverage }
          : { enabled: false },
      llmTrace:
        state.llmTrace !== undefined
          ? { enabled: true, records: state.llmTrace }
          : { enabled: false },
      zeroOutputDocs:
        state.zeroOutputDocs !== undefined
          ? { enabled: true, entries: state.zeroOutputDocs }
          : { enabled: false },
    },
  };

  const truncated = deepTruncateDebug(output);
  sanitizeDebugReport(truncated);

  const path = join(CONFIG.reportOutput, `scan-report-${timestamp}-debug.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(truncated, null, 2), "utf-8");
  return path;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/debug/report.ts
git commit -m "feat(debug): add writeDebugReport with pattern coverage and zero-output computation"
```

---

## Task 7: Phase 9 integration

**Files:**
- Modify: `src/phases/9-report.ts`

Phase 9 calls `writeDebugReport()` after writing the main JSON and Markdown reports.

- [ ] **Step 1: Add import and call to `src/phases/9-report.ts`**

Add this import at the top of `src/phases/9-report.ts` (after existing imports):

```ts
import { writeDebugReport } from "../debug/report.ts";
```

In `runReport`, find the final `logger.phaseEnd` call:
```ts
  logger.phaseEnd("9-report", t, { jsonPath, mdPath });
```
Replace it with:
```ts
  let debugPath: string | null = null;
  try {
    debugPath = writeDebugReport(state, timestamp);
    if (debugPath) logger.info("Debug report written", { path: debugPath });
  } catch (debugErr) {
    logger.warn("Debug report generation failed — skipping", { error: String(debugErr) });
  }

  logger.phaseEnd("9-report", t, { jsonPath, mdPath, ...(debugPath ? { debugPath } : {}) });
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Run full test suite**

```bash
cd /home/clemi/mci/huginn && bun test
```
Expected: all existing tests pass (103 pass, 0 fail) plus the 3 new settings tests = 106 pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/phases/9-report.ts
git commit -m "feat(debug): call writeDebugReport from Phase 9"
```

---

## Task 8: Server API routes

**Files:**
- Modify: `src/server/routes.ts`

Add GET and PATCH handlers for `/api/debug-settings`. Follow the existing `handleGetCompany` / `handleSaveCompany` pattern.

- [ ] **Step 1: Add import to `src/server/routes.ts`**

Add this import at the top of `src/server/routes.ts` (after existing imports):

```ts
import { loadDebugSettings, saveDebugSettings, mergeDebugSettings } from "../debug/settings.ts";
```

- [ ] **Step 2: Add handler functions to `src/server/routes.ts`**

Add these two functions before the `export async function handleRequest` declaration:

```ts
function handleGetDebugSettings(): Response {
  return json(loadDebugSettings());
}

async function handlePatchDebugSettings(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return json({ error: "body_must_be_object" }, 400);
  }
  const patch = body as Record<string, unknown>;
  // Validate: only boolean values accepted
  for (const [key, val] of Object.entries(patch)) {
    if (typeof val !== "boolean") {
      return json({ error: "invalid_value", field: key, expected: "boolean" }, 400);
    }
  }
  const current = loadDebugSettings();
  const updated = mergeDebugSettings(current, patch as Partial<import("../debug/settings.ts").DebugSettings>);
  saveDebugSettings(updated);
  return json(updated);
}
```

- [ ] **Step 3: Register routes in `handleRequest`**

In `handleRequest`, find:
```ts
  if (path === "/api/company" && req.method === "GET") return handleGetCompany();
  if (path === "/api/company" && req.method === "POST") return handleSaveCompany(req);
  if (path === "/api/profiles" && req.method === "GET") return handleGetProfiles();
```
Add after it:
```ts
  if (path === "/api/debug-settings" && req.method === "GET")   return handleGetDebugSettings();
  if (path === "/api/debug-settings" && req.method === "PATCH") return handlePatchDebugSettings(req);
```

Also add `PATCH` to the CORS `Allow-Methods` header. Find:
```ts
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
```
Replace with:
```ts
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
```

- [ ] **Step 4: Typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 5: Run full test suite**

```bash
cd /home/clemi/mci/huginn && bun test
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/server/routes.ts
git commit -m "feat(debug): add GET/PATCH /api/debug-settings server routes"
```

---

## Task 9: Final verification

- [ ] **Step 1: Full typecheck**

```bash
cd /home/clemi/mci/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 2: Full test suite**

```bash
cd /home/clemi/mci/huginn && bun test
```
Expected: 106+ pass, 0 fail.

- [ ] **Step 3: Smoke test debug output with offline scanner**

```bash
cd /home/clemi/mci/huginn && \
  mkdir -p ./reports && \
  echo '{"enabled":true,"decisionAudit":true,"patternCoverage":true,"llmTrace":false,"zeroOutputDocs":true}' > ./reports/debug-settings.json && \
  DOCUMENTS_ROOT=./_test-docs REPORT_OUTPUT=./reports TIKA_URL=http://localhost:19998 OLLAMA_URL=http://localhost:11435 bun run src/index.ts 2>&1 | tail -5
```

Expected: scanner runs (Ollama unavailable will exit with code 1 as designed — this is expected for offline test). Check that `./reports/debug-settings.json` was not corrupted. To verify the debug flow without Ollama, modify `OLLAMA_URL` in a future full Docker run — the offline run is Ollama-gated by design.

- [ ] **Step 4: Verify debug-settings API endpoint works in server mode**

```bash
# Terminal 1: start server
REPORT_OUTPUT=./reports bun run src/server/index.ts &
SERVER_PID=$!

# Terminal 2: test GET
curl -s http://localhost:3000/api/debug-settings | python3 -m json.tool

# Terminal 3: test PATCH
curl -s -X PATCH http://localhost:3000/api/debug-settings \
  -H "Content-Type: application/json" \
  -d '{"enabled":true,"decisionAudit":true}' | python3 -m json.tool

# Cleanup
kill $SERVER_PID
```

Expected: GET returns `{"enabled":false,...}`, PATCH returns updated settings with `enabled:true, decisionAudit:true`, file `./reports/debug-settings.json` contains the updated values.

- [ ] **Step 5: Final commit**

```bash
git add -A
git status  # verify only expected files
git commit -m "feat(debug): complete debug data enhancement — settings, state, phases 2/5/7/9, server API"
```

---

## Out of scope: UI integration (separate plan required)

The design spec's Section 5 (UI: debug settings panel + debug report tab) is not implemented here. It requires reading `src/ui/index.html` and understanding the existing UI structure before writing code.

That follow-on work involves:
1. A "Debug Settings" collapsible panel with one toggle per category, privacy label, and PATCH call to `/api/debug-settings`
2. A "Debug Report" tab that appears when a `*-debug.json` file exists alongside the selected report (decision audit table, pattern coverage zero-match highlights, LLM trace bars, zero-output doc list)

Create a separate plan for this after reviewing `src/ui/` and the dashboard components in `src/dashboard/`.
