# Phase 9 Ingestion Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Phase 9 to Huginn that simulates Muninn's ingestion pipeline per document, producing token waterfall stats, boilerplate pattern discovery, domain signal detection, and concrete Muninn config recommendations — all in the JSON report and a new developer-side HTML dashboard.

**Architecture:** Phase 9a runs inline at the end of Phase 2 (text still in memory via `doc.textContent`), accumulating per-document projection stats and line frequencies. Phase 9 (after Phase 2) finalises corpus-wide boilerplate discovery (9b) and config recommendations (9c). Four pure utilities are ported from Muninn. A new `8-html.ts` CLI tool generates the HTML report from any scan JSON.

**Tech Stack:** TypeScript, Bun runtime, `bun test` for tests. No new npm dependencies. Reference HTML at `/home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.html`.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Create | `src/utils/token-estimator.ts` | estimateTokens, estimateChunkTokens |
| Create | `src/utils/chunk-filter.ts` | three-rule filter predicate |
| Create | `src/utils/cleaner.ts` | normalise, strip boilerplate, detect repeats |
| Create | `src/utils/quality-scorer.ts` | domain-aware block quality 0–1 |
| Create | `src/utils/domain-detector.ts` | detect req language / unit family / ref formats |
| Create | `src/phases/9-projection.ts` | ProjectionAccumulator, projectDocument, runProjection |
| Create | `src/phases/8-html.ts` | CLI: JSON → self-contained HTML report |
| Modify | `src/state.ts` | 7 new interfaces, 5 new ScannerState fields |
| Modify | `src/phases/2-parse.ts` | call projectDocument per doc, pass accumulator |
| Modify | `src/index.ts` | add Phase 9 to pipeline |
| Modify | `src/phases/8-report.ts` | serialise 5 new JSON keys |
| Create | `src/utils/token-estimator.test.ts` | unit tests |
| Create | `src/utils/chunk-filter.test.ts` | unit tests |
| Create | `src/utils/cleaner.test.ts` | unit tests |
| Create | `src/utils/quality-scorer.test.ts` | unit tests |
| Create | `src/utils/domain-detector.test.ts` | unit tests |
| Create | `src/phases/9-projection.test.ts` | integration tests |

---

## Task 1: Token Estimator Utility

**Files:**
- Create: `src/utils/token-estimator.ts`
- Create: `src/utils/token-estimator.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/utils/token-estimator.test.ts
import { expect, test } from "bun:test";
import { estimateTokens, estimateChunkTokens } from "./token-estimator.ts";

test("estimateTokens returns 0 for empty string", () => {
  expect(estimateTokens("")).toBe(0);
});

test("estimateTokens returns positive integer for non-empty text", () => {
  const result = estimateTokens("Hello world");
  expect(result).toBeGreaterThan(0);
  expect(Number.isInteger(result)).toBe(true);
});

test("estimateTokens handles German compound words", () => {
  const result = estimateTokens("Die Karosserieteile werden nach DIN-Norm gefertigt und geprüft.");
  expect(result).toBeGreaterThan(10);
});

test("estimateChunkTokens applies boilerplate compression factor 0.7", () => {
  const text = "Seite 1 von 10 Vertraulich";
  const prose = estimateChunkTokens(text, "prose");
  const boilerplate = estimateChunkTokens(text, "boilerplate");
  expect(boilerplate).toBe(Math.ceil(prose * 0.7));
});

test("estimateChunkTokens applies header compression factor 0.8", () => {
  const text = "1. Anforderungen";
  const prose = estimateChunkTokens(text, "prose");
  const header = estimateChunkTokens(text, "header");
  expect(header).toBe(Math.ceil(prose * 0.8));
});

test("estimateChunkTokens applies no compression for prose and spec_value", () => {
  const text = "Der Werkstoff muss eine Zugfestigkeit von 500 MPa aufweisen.";
  expect(estimateChunkTokens(text, "prose")).toBe(estimateTokens(text));
  expect(estimateChunkTokens(text, "spec_value")).toBe(estimateTokens(text));
});

test("estimateChunkTokens falls back to 1.0 for unknown type", () => {
  const text = "Some text here";
  expect(estimateChunkTokens(text, "unknown_type")).toBe(estimateTokens(text));
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /home/clemi/huginn && bun test src/utils/token-estimator.test.ts
```
Expected: `error: Cannot find module './token-estimator.ts'`

- [ ] **Step 3: Implement**

```typescript
// src/utils/token-estimator.ts
export type ChunkType = "spec_value" | "prose" | "table_row" | "boilerplate" | "header";

const CHARS_PER_TOKEN = 4.5;
const WORD_BOUNDARY_BONUS = 0.5;

const COMPRESSION_FACTORS: Record<ChunkType, number> = {
  spec_value:  1.0,
  prose:       1.0,
  table_row:   1.0,
  boilerplate: 0.7,
  header:      0.8,
};

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0;
  const nonWhitespace = text.replace(/\s+/g, "").length;
  const words = text.trim().split(/\s+/).filter((w) => w.length > 0).length;
  return Math.ceil((nonWhitespace + words * WORD_BOUNDARY_BONUS) / CHARS_PER_TOKEN);
}

export function estimateChunkTokens(content: string, chunkType: ChunkType | string): number {
  const base = estimateTokens(content);
  const factor = COMPRESSION_FACTORS[chunkType as ChunkType] ?? 1.0;
  return Math.ceil(base * factor);
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /home/clemi/huginn && bun test src/utils/token-estimator.test.ts
```
Expected: all 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/token-estimator.ts src/utils/token-estimator.test.ts
git commit -m "feat: add token estimator utility (ported from Muninn)"
```

---

## Task 2: Chunk Filter Utility

**Files:**
- Create: `src/utils/chunk-filter.ts`
- Create: `src/utils/chunk-filter.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/utils/chunk-filter.test.ts
import { expect, test } from "bun:test";
import { filterChunk } from "./chunk-filter.ts";

test("rejects chunks shorter than 20 chars", () => {
  const result = filterChunk("too short");
  expect(result.passed).toBe(false);
  expect(result.rejectionReason).toBe("too_short");
});

test("rejects chunks with letter ratio below 25%", () => {
  // 3 letters out of 20 non-whitespace = 15%
  const result = filterChunk("123 456 789 012 345 abc");
  expect(result.passed).toBe(false);
  expect(result.rejectionReason).toBe("low_letter_ratio");
});

test("rejects chunks with punctuation ratio above 40%", () => {
  // heavy punctuation
  const result = filterChunk("...,,,;;;::: text here !!!???()[]{}");
  expect(result.passed).toBe(false);
  expect(result.rejectionReason).toBe("high_punctuation");
});

test("passes normal prose text", () => {
  const result = filterChunk("Der Werkstoff muss eine Zugfestigkeit von mindestens 500 MPa aufweisen.");
  expect(result.passed).toBe(true);
  expect(result.rejectionReason).toBeUndefined();
});

test("passes exactly-20-char text with good ratios", () => {
  const result = filterChunk("abcdefghijklmnopqrstu"); // 21 letters
  expect(result.passed).toBe(true);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /home/clemi/huginn && bun test src/utils/chunk-filter.test.ts
```
Expected: `error: Cannot find module './chunk-filter.ts'`

- [ ] **Step 3: Implement**

```typescript
// src/utils/chunk-filter.ts
export type ChunkFilterReason = "too_short" | "low_letter_ratio" | "high_punctuation";

export interface FilteredChunk {
  content: string;
  passed: boolean;
  rejectionReason?: ChunkFilterReason;
}

export function filterChunk(content: string): FilteredChunk {
  const t = content.trim();
  if (t.length < 20) {
    return { content, passed: false, rejectionReason: "too_short" };
  }
  const letters = (t.match(/\p{L}/gu) ?? []).length;
  const total   = t.replace(/\s/g, "").length || 1;
  if (letters / total < 0.25) {
    return { content, passed: false, rejectionReason: "low_letter_ratio" };
  }
  const punct = (t.match(/[.,;:!?()\[\]{}"']/g) ?? []).length;
  if (punct / total > 0.4) {
    return { content, passed: false, rejectionReason: "high_punctuation" };
  }
  return { content, passed: true };
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /home/clemi/huginn && bun test src/utils/chunk-filter.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/chunk-filter.ts src/utils/chunk-filter.test.ts
git commit -m "feat: add chunk filter utility (ported from Muninn)"
```

---

## Task 3: Cleaner Utility

**Files:**
- Create: `src/utils/cleaner.ts`
- Create: `src/utils/cleaner.test.ts`

Depends on: Task 1 (token-estimator).

- [ ] **Step 1: Write the failing tests**

```typescript
// src/utils/cleaner.test.ts
import { expect, test } from "bun:test";
import { cleanContent, classifyBlock, normalizeExtractedText } from "./cleaner.ts";

test("normalizeExtractedText removes soft hyphens", () => {
  const input = "Brücken­bau";
  expect(normalizeExtractedText(input)).not.toContain("­");
});

test("normalizeExtractedText repairs hard hyphenation across lines", () => {
  const input = "Karosse-\nriebau";
  expect(normalizeExtractedText(input)).toBe("Karosseriebau");
});

test("normalizeExtractedText collapses multiple blank lines to two", () => {
  const input = "line1\n\n\n\n\nline2";
  expect(normalizeExtractedText(input)).toBe("line1\n\nline2");
});

test("cleanContent strips known boilerplate patterns", () => {
  const text = "Einleitung\nSeite 3 von 12\nDer Werkstoff muss geprüft werden.";
  const { audit } = cleanContent(text);
  expect(audit.tokensLostBoilerplate).toBeGreaterThan(0);
  expect(audit.removedBoilerplate.length).toBeGreaterThan(0);
});

test("cleanContent detects repeated lines as headers/footers", () => {
  const repeatedLine = "Musterfirma GmbH — Vertraulich";
  const lines = Array(5).fill(repeatedLine).join("\n");
  const text = `Einleitung\n${lines}\nInhalt folgt hier`;
  const { audit } = cleanContent(text);
  expect(audit.removedRepeated.length).toBeGreaterThan(0);
  expect(audit.tokensLostRepeated).toBeGreaterThan(0);
});

test("cleanContent reports normalization token loss", () => {
  // Text with control characters
  const text = "Normal text \x01\x02\x03 more text here with content";
  const { audit } = cleanContent(text);
  expect(audit.tokensLostNormalization).toBeGreaterThanOrEqual(0);
});

test("classifyBlock returns boilerplate for page number lines", () => {
  expect(classifyBlock("Seite 3 von 12")).toBe("boilerplate");
  expect(classifyBlock("© 2024 Musterfirma")).toBe("boilerplate");
});

test("classifyBlock returns header for numbered section titles", () => {
  expect(classifyBlock("3.1 Anforderungen")).toBe("header");
  expect(classifyBlock("ANFORDERUNGEN AN DEN WERKSTOFF")).toBe("header");
});

test("classifyBlock returns spec_value for measurement lines", () => {
  expect(classifyBlock("Zugfestigkeit: 500 MPa")).toBe("spec_value");
  expect(classifyBlock("Toleranz: ±0.05 mm")).toBe("spec_value");
});

test("classifyBlock returns table_row for tab-separated content", () => {
  expect(classifyBlock("Eigenschaft\tWert\tEinheit")).toBe("table_row");
});

test("classifyBlock returns prose for regular sentences", () => {
  expect(classifyBlock("Der Werkstoff muss eine ausreichende Zugfestigkeit aufweisen, um den Anforderungen zu genügen.")).toBe("prose");
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /home/clemi/huginn && bun test src/utils/cleaner.test.ts
```
Expected: `error: Cannot find module './cleaner.ts'`

- [ ] **Step 3: Implement**

```typescript
// src/utils/cleaner.ts
import { estimateTokens } from "./token-estimator.ts";

export interface CleaningAudit {
  removedBoilerplate: Array<{ line: string; pattern: string }>;
  removedRepeated: Array<{ line: string; count: number }>;
  tokensLostNormalization: number;
  tokensLostBoilerplate: number;
  tokensLostRepeated: number;
}

export const BOILERPLATE_PATTERNS: RegExp[] = [
  /^seite\s+\d+\s*(von\s+\d+)?$/i,
  /^-\s*\d+\s*-$/,
  /^\d+\s*\/\s*\d+$/,
  /^vertraulich$/i,
  /^confidential$/i,
  /^intern$/i,
  /^propriet[äa]r$/i,
  /^alle\s+rechte\s+vorbehalten/i,
  /^©\s*\d{4}/,
  /^copyright\s+\d{4}/i,
  /^stand:\s*\d{2}\.\d{2}\.\d{4}$/i,
  /^(dokument|datei|version|revision)[-:\s]+[^\n]{0,30}$/i,
];

const HEADER_FOOTER_MIN_OCCURRENCES = 3;

export function normalizeExtractedText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[�￾￿]/g, "")
    .replace(/­/g, "")
    .replace(/([\p{L}])-\r?\n\s*([\p{L}])/gu, "$1$2")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/[-]/g, " ")
    .replace(/[\uD800-\uDFFF]/g, " ")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanContent(content: string): { cleaned: string; audit: CleaningAudit } {
  const normalized = normalizeExtractedText(content);
  const tokensRaw = estimateTokens(content);
  const tokensNormalized = estimateTokens(normalized);

  const audit: CleaningAudit = {
    removedBoilerplate: [],
    removedRepeated: [],
    tokensLostNormalization: Math.max(0, tokensRaw - tokensNormalized),
    tokensLostBoilerplate: 0,
    tokensLostRepeated: 0,
  };

  const lines = normalized.split("\n");

  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const t = line.trim();
    if (t.length > 3 && t.length < 120) {
      lineCounts.set(t, (lineCounts.get(t) ?? 0) + 1);
    }
  }
  const repeated = new Map(
    [...lineCounts.entries()].filter(([, c]) => c >= HEADER_FOOTER_MIN_OCCURRENCES)
  );

  const cleanedLines: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    let removed = false;

    for (const re of BOILERPLATE_PATTERNS) {
      if (re.test(t)) {
        audit.removedBoilerplate.push({ line: t.slice(0, 60), pattern: re.source });
        audit.tokensLostBoilerplate += estimateTokens(line);
        removed = true;
        break;
      }
    }

    if (!removed && repeated.has(t)) {
      const count = repeated.get(t)!;
      if (!audit.removedRepeated.some((r) => r.line === t)) {
        audit.removedRepeated.push({ line: t.slice(0, 60), count });
      }
      audit.tokensLostRepeated += estimateTokens(line);
      removed = true;
    }

    if (!removed) cleanedLines.push(line);
  }

  const cleaned = cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { cleaned, audit };
}

export function classifyBlock(text: string): "header" | "spec_value" | "table_row" | "boilerplate" | "prose" {
  const t = text.trim();
  if (BOILERPLATE_PATTERNS.some((re) => re.test(t))) return "boilerplate";
  if (
    t.length < 100 &&
    (/^\d+(\.\d+)*\s+\S/.test(t) ||
      /^[A-ZÄÖÜ][A-ZÄÖÜ\s]{5,}$/.test(t) ||
      (/[A-ZÄÖÜ]/.test(t[0] ?? "") && t.endsWith(":")))
  ) return "header";
  if (/[\d,]+\s*(mm|cm|m|kg|g|°C|°F|%|bar|N|kN|MPa|V|A|W|Hz|rpm|μm|±|∅)/i.test(t) && t.length < 300) return "spec_value";
  if (/\t/.test(t) || /\|/.test(t) || /  {3,}/.test(t)) return "table_row";
  return "prose";
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /home/clemi/huginn && bun test src/utils/cleaner.test.ts
```
Expected: all 11 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/cleaner.ts src/utils/cleaner.test.ts
git commit -m "feat: add cleaner utility (ported from Muninn)"
```

---

## Task 4: Quality Scorer Utility

**Files:**
- Create: `src/utils/quality-scorer.ts`
- Create: `src/utils/quality-scorer.test.ts`

Adapted from Muninn: `specificityScore` and `coherenceScore` accept a `DomainHints` parameter so they work beyond German automotive.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/utils/quality-scorer.test.ts
import { expect, test } from "bun:test";
import { scoreBlock, type DomainHints } from "./quality-scorer.ts";

test("boilerplate chunks score very low regardless of content", async () => {
  const score = await scoreBlock("Seite 1 von 100 Vertraulich intern", "boilerplate", {});
  expect(score).toBe(0.1);
});

test("header chunks are capped at 0.35", async () => {
  const score = await scoreBlock("1.2.3 Wichtige Anforderungen an den Werkstoff", "header", {});
  expect(score).toBeLessThanOrEqual(0.35);
});

test("prose with german requirements scores higher with german_modal hint", async () => {
  const text = "Der Werkstoff muss eine Zugfestigkeit von mindestens 500 MPa aufweisen und soll korrosionsbeständig sein.";
  const noHint = await scoreBlock(text, "prose", {});
  const withHint = await scoreBlock(text, "prose", { requirementLanguageFamily: "german_modal" });
  expect(withHint).toBeGreaterThanOrEqual(noHint);
});

test("spec_value with measurement units scores higher with matching unit family", async () => {
  const text = "Zugfestigkeit: 500 MPa, Härte: 200 HV, Toleranz: ±0.05 mm";
  const noHint = await scoreBlock(text, "spec_value", {});
  const withHint = await scoreBlock(text, "spec_value", { dominantUnitFamily: "mechanical" });
  expect(withHint).toBeGreaterThanOrEqual(noHint);
});

test("short repetitive text scores low", async () => {
  const text = "test test test test test test test test test test test test test test";
  const score = await scoreBlock(text, "prose", {});
  expect(score).toBeLessThan(0.5);
});

test("score is always between 0 and 1", async () => {
  const texts = [
    "a",
    "Der Werkstoff muss geprüft werden.",
    "Zugfestigkeit: 500 MPa bei 20°C",
    "1.1 Anforderungen",
  ];
  for (const text of texts) {
    const score = await scoreBlock(text, "prose", {});
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  }
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /home/clemi/huginn && bun test src/utils/quality-scorer.test.ts
```
Expected: `error: Cannot find module './quality-scorer.ts'`

- [ ] **Step 3: Implement**

```typescript
// src/utils/quality-scorer.ts
import type { ChunkType } from "./token-estimator.ts";

export type RequirementLanguageFamily = "german_modal" | "rfc2119" | "legal" | "french_modal" | "none";
export type UnitFamily = "mechanical" | "electrical" | "pharma" | "financial" | "logistics" | "mixed" | "none";

export interface DomainHints {
  requirementLanguageFamily?: RequirementLanguageFamily;
  dominantUnitFamily?: UnitFamily;
}

const REQ_PATTERNS: Record<RequirementLanguageFamily, RegExp> = {
  german_modal: /\b(soll|muss|darf\s+nicht|hat\s+sicherzustellen|muss\s+gewährleistet)\b/i,
  rfc2119:      /\b(MUST|SHALL|SHOULD|MAY|REQUIRED|RECOMMENDED)\b/,
  legal:        /\b(shall\s+not|is\s+obligated\s+to|warrants\s+that)\b/i,
  french_modal: /\b(doit|devrait|peut)\b/i,
  none:         /(?!)/,
};

const UNIT_PATTERNS: Record<UnitFamily, RegExp> = {
  mechanical:  /[\d,]+\s*(mm|cm|m|kg|g|°C|%|bar|N|kN|MPa|rpm|μm|±|∅)/i,
  electrical:  /[\d,]+\s*(V|A|W|kWh|Ω|Hz|kV|mA)/i,
  pharma:      /[\d,]+\s*(mg|mL|μg|ppm|mol\/L|ng|μL)/i,
  financial:   /[\d,]+\s*(€|\$|£|%|bps|bp)/,
  logistics:   /[\d,]+\s*(pcs|TEU|kg\/m³|pallets|units)/i,
  mixed:       /[\d,]+\s*[a-zA-Z°μ%€$£Ω±∅]{1,6}/,
  none:        /(?!)/,
};

const PART_NUMBER = /\b([A-Z]{2,}-?\d{3,}|KB[-_]?\d{3,}|FIKB[-\s]?\d{3,})\b/;

export async function scoreBlock(content: string, chunkType: ChunkType | string, hints: DomainHints): Promise<number> {
  if (chunkType === "boilerplate") return 0.1;

  const score = Math.min(
    1.0,
    0.4 * densityScore(content) +
    0.3 * coherenceScore(content, hints.requirementLanguageFamily ?? "none") +
    0.3 * specificityScore(content, hints.dominantUnitFamily ?? "none"),
  );

  if (chunkType === "header") return Math.min(score, 0.35);
  return Math.round(score * 1000) / 1000;
}

function densityScore(text: string): number {
  const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (tokens.length === 0) return 0;
  const unique = new Set(tokens).size;
  const diversity = unique / tokens.length;
  const normalized = Math.min(1.0, diversity / 0.7);
  const lengthBonus = Math.min(1.0, tokens.length / 30);
  return normalized * lengthBonus;
}

function coherenceScore(text: string, family: RequirementLanguageFamily): number {
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 5);
  if (sentences.length === 0) return 0.3;
  const avgLen = sentences.reduce((s, sen) => s + sen.split(/\s+/).length, 0) / sentences.length;
  const lenScore = avgLen < 4 ? 0.2 : avgLen > 50 ? 0.4 : Math.min(1.0, avgLen / 15);
  const reqBonus = family !== "none" && REQ_PATTERNS[family].test(text) ? 0.15 : 0;
  return Math.min(1.0, lenScore + reqBonus);
}

function specificityScore(text: string, unitFamily: UnitFamily): number {
  let score = 0;
  const pattern = unitFamily !== "none" ? UNIT_PATTERNS[unitFamily] : UNIT_PATTERNS.mechanical;
  const unitMatches = text.match(new RegExp(pattern.source, "gi")) ?? [];
  score += Math.min(0.4, unitMatches.length * 0.1);
  if (PART_NUMBER.test(text)) score += 0.2;
  const digits = (text.match(/\d/g) ?? []).length;
  const total = text.replace(/\s/g, "").length;
  if (total > 0) score += Math.min(0.2, (digits / total) * 2);
  if (/\t/.test(text) || /\|/.test(text)) score += 0.1;
  return Math.min(1.0, score);
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /home/clemi/huginn && bun test src/utils/quality-scorer.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/quality-scorer.ts src/utils/quality-scorer.test.ts
git commit -m "feat: add quality scorer utility (domain-aware, ported from Muninn)"
```

---

## Task 5: Domain Detector Utility

**Files:**
- Create: `src/utils/domain-detector.ts`
- Create: `src/utils/domain-detector.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/utils/domain-detector.test.ts
import { expect, test } from "bun:test";
import { detectDomainSignals, buildDomainProfile, type DomainSignalSample } from "./domain-detector.ts";

test("detectDomainSignals identifies german_modal family", () => {
  const text = "Das Bauteil muss eine Zugfestigkeit von 500 MPa aufweisen. Der Werkstoff soll korrosionsbeständig sein.";
  const signals = detectDomainSignals(text);
  expect(signals.reqFamilyHits.german_modal).toBeGreaterThan(0);
});

test("detectDomainSignals identifies rfc2119 family", () => {
  const text = "The implementation MUST support TLS 1.3. Servers SHOULD prefer ECDHE cipher suites.";
  const signals = detectDomainSignals(text);
  expect(signals.reqFamilyHits.rfc2119).toBeGreaterThan(0);
});

test("detectDomainSignals identifies mechanical unit family", () => {
  const text = "Toleranz ±0.05 mm, Zugfestigkeit 500 MPa, Gewicht 2.5 kg";
  const signals = detectDomainSignals(text);
  expect(signals.unitFamilyHits.mechanical).toBeGreaterThan(0);
});

test("detectDomainSignals identifies pharma unit family", () => {
  const text = "Dosierung 50 mg täglich, Konzentration 0.9 mg/mL, Batch 1200 μg";
  const signals = detectDomainSignals(text);
  expect(signals.unitFamilyHits.pharma).toBeGreaterThan(0);
});

test("buildDomainProfile returns dominant family from samples", () => {
  const samples: DomainSignalSample[] = [
    { reqFamilyHits: { german_modal: 5, rfc2119: 0, legal: 0, french_modal: 0 }, unitFamilyHits: { mechanical: 3, electrical: 0, pharma: 0, financial: 0, logistics: 0 }, refFormatHits: {} },
    { reqFamilyHits: { german_modal: 3, rfc2119: 1, legal: 0, french_modal: 0 }, unitFamilyHits: { mechanical: 5, electrical: 0, pharma: 0, financial: 0, logistics: 0 }, refFormatHits: {} },
  ];
  const profile = buildDomainProfile(samples, []);
  expect(profile.requirementLanguageFamily).toBe("german_modal");
  expect(profile.dominantUnitFamily).toBe("mechanical");
});

test("buildDomainProfile returns none when no signals found", () => {
  const samples: DomainSignalSample[] = [
    { reqFamilyHits: { german_modal: 0, rfc2119: 0, legal: 0, french_modal: 0 }, unitFamilyHits: { mechanical: 0, electrical: 0, pharma: 0, financial: 0, logistics: 0 }, refFormatHits: {} },
  ];
  const profile = buildDomainProfile(samples, []);
  expect(profile.requirementLanguageFamily).toBe("none");
  expect(profile.dominantUnitFamily).toBe("none");
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /home/clemi/huginn && bun test src/utils/domain-detector.test.ts
```
Expected: `error: Cannot find module './domain-detector.ts'`

- [ ] **Step 3: Implement**

```typescript
// src/utils/domain-detector.ts
import type { RequirementLanguageFamily, UnitFamily } from "./quality-scorer.ts";
// No import from state.ts — return type is structurally compatible, no explicit import needed.

export interface DomainSignalSample {
  reqFamilyHits: Record<RequirementLanguageFamily, number>;
  unitFamilyHits: Record<Exclude<UnitFamily, "mixed" | "none">, number>;
  refFormatHits: Record<string, number>;
}

const REQ_DETECTORS: Record<RequirementLanguageFamily, RegExp> = {
  german_modal: /\b(muss|soll|kann|darf\s+nicht)\b/gi,
  rfc2119:      /\b(MUST|SHALL|SHOULD|MAY|REQUIRED)\b/g,
  legal:        /\b(shall\s+not|is\s+obligated|warrants\s+that)\b/gi,
  french_modal: /\b(doit|devrait|peut)\b/gi,
  none:         /(?!)/g,
};

const UNIT_DETECTORS: Record<Exclude<UnitFamily, "mixed" | "none">, RegExp> = {
  mechanical: /[\d,]+\s*(mm|cm|MPa|rpm|μm|kg|°C|bar|kN)/gi,
  electrical: /[\d,]+\s*(kWh|kV|mA|Hz|V|A|W|Ω)/gi,
  pharma:     /[\d,]+\s*(mg|mL|μg|ppm|mol\/L|ng)/gi,
  financial:  /[\d,]+\s*(€|\$|£|bps)/g,
  logistics:  /[\d,]+\s*(pcs|TEU|pallets)/gi,
};

const REF_DETECTORS: Record<string, RegExp> = {
  "letter_prefix_digits": /\b[A-Z]{2,}-?\d{3,}\b/g,
  "dotted_decimal":       /\b\d{2,}\s+\d{4,}-\d+:\d{4}\b/g,
  "paragraph_number":     /§\s*\d+/g,
  "all_caps_acronym":     /\b[A-Z]{2,}-\d{1,3}-[A-Z0-9]+\b/g,
};

export function detectDomainSignals(text: string): DomainSignalSample {
  const sample = text.slice(0, 8000);
  const reqFamilyHits = {} as Record<RequirementLanguageFamily, number>;
  for (const [family, re] of Object.entries(REQ_DETECTORS)) {
    reqFamilyHits[family as RequirementLanguageFamily] = (sample.match(re) ?? []).length;
  }
  const unitFamilyHits = {} as Record<Exclude<UnitFamily, "mixed" | "none">, number>;
  for (const [family, re] of Object.entries(UNIT_DETECTORS)) {
    unitFamilyHits[family as Exclude<UnitFamily, "mixed" | "none">] = (sample.match(re) ?? []).length;
  }
  const refFormatHits: Record<string, number> = {};
  for (const [name, re] of Object.entries(REF_DETECTORS)) {
    refFormatHits[name] = (sample.match(re) ?? []).length;
  }
  return { reqFamilyHits, unitFamilyHits, refFormatHits };
}

export function buildDomainProfile(
  samples: DomainSignalSample[],
  parsedLanguages: string[],
): DomainProfile {
  const totalReq = {} as Record<RequirementLanguageFamily, number>;
  const totalUnit = {} as Record<Exclude<UnitFamily, "mixed" | "none">, number>;
  const totalRef: Record<string, number> = {};

  for (const s of samples) {
    for (const [k, v] of Object.entries(s.reqFamilyHits)) totalReq[k as RequirementLanguageFamily] = (totalReq[k as RequirementLanguageFamily] ?? 0) + v;
    for (const [k, v] of Object.entries(s.unitFamilyHits)) totalUnit[k as Exclude<UnitFamily, "mixed" | "none">] = (totalUnit[k as Exclude<UnitFamily, "mixed" | "none">] ?? 0) + v;
    for (const [k, v] of Object.entries(s.refFormatHits)) totalRef[k] = (totalRef[k] ?? 0) + v;
  }

  const topReq = (Object.entries(totalReq) as [RequirementLanguageFamily, number][])
    .filter(([k]) => k !== "none")
    .sort(([, a], [, b]) => b - a)[0];
  const topUnit = (Object.entries(totalUnit) as [Exclude<UnitFamily, "mixed" | "none">, number][])
    .sort(([, a], [, b]) => b - a)[0];

  const requirementLanguageFamily: RequirementLanguageFamily =
    topReq && topReq[1] > 0 ? topReq[0] : "none";
  const dominantUnitFamily: UnitFamily =
    topUnit && topUnit[1] > 0 ? topUnit[0] : "none";

  const langCounts: Record<string, number> = {};
  for (const l of parsedLanguages) langCounts[l] = (langCounts[l] ?? 0) + 1;
  const topLang = Object.entries(langCounts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? "und";
  const detectedLanguage: "de" | "en" | "fr" | "mixed" =
    topLang.startsWith("deu") || topLang === "de" ? "de" :
    topLang.startsWith("eng") || topLang === "en" ? "en" :
    topLang.startsWith("fra") || topLang === "fr" ? "fr" : "mixed";

  const totalSamples = samples.length || 1;
  const reqCoverage = samples.filter((s) =>
    requirementLanguageFamily !== "none" && (s.reqFamilyHits[requirementLanguageFamily] ?? 0) > 0
  ).length / totalSamples;

  const unitCoverage = samples.filter((s) =>
    dominantUnitFamily !== "none" && dominantUnitFamily !== "mixed" &&
    (s.unitFamilyHits[dominantUnitFamily as Exclude<UnitFamily, "mixed" | "none">] ?? 0) > 0
  ).length / totalSamples;

  const topRefs = Object.entries(totalRef)
    .filter(([, c]) => c > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([pattern, occurrenceCount]) => ({
      pattern,
      occurrenceCount,
      documentCount: samples.filter((s) => (s.refFormatHits[pattern] ?? 0) > 0).length,
      alreadyExtracted: ["letter_prefix_digits"].includes(pattern),
    }));

  const isDefault = requirementLanguageFamily === "german_modal" && dominantUnitFamily === "mechanical" && detectedLanguage === "de";
  const qualityScorerProfile: DomainProfile["qualityScorerProfile"] =
    isDefault ? "automotive_de" :
    detectedLanguage === "de" ? "generic_de" :
    detectedLanguage === "en" ? "generic_en" : "adapted";

  return {
    detectedLanguage,
    requirementLanguageFamily,
    requirementLanguageCoverage: reqCoverage,
    discoveredReferenceFormats: topRefs,
    dominantUnitFamily,
    unitFamilyCoverage: unitCoverage,
    qualityScorerProfile,
  };
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /home/clemi/huginn && bun test src/utils/domain-detector.test.ts
```
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/utils/domain-detector.ts src/utils/domain-detector.test.ts
git commit -m "feat: add domain detector utility"
```

---

## Task 6: State Types — Phase 9 Additions

**Files:**
- Modify: `src/state.ts`

Add 7 new interfaces and 5 new fields to `ScannerState`. Also update `createInitialState`.

- [ ] **Step 1: Add imports needed by new types (none — all types are self-contained)**

- [ ] **Step 2: Add new interfaces after the existing `ConsistencyCheck` interface**

In `src/state.ts`, after line 176 (end of `ConsistencyCheck` interface), insert:

```typescript
// ── Phase 9: Ingestion Projection ────────────────────────────────────────────

export interface DocumentIngestionProjection {
  docId: string;
  tokenWaterfall: {
    raw: number;
    afterNormalization: number;
    afterCleaning: number;
    afterChunking: number;
    afterFilter: number;
    embeddable: number;
  };
  cleaningLoss: {
    normalization: number;
    boilerplate: number;
    repeatedLines: number;
  };
  filterLoss: {
    byLength: number;
    byLetterRatio: number;
    byPunctuation: number;
  };
  predictedChunkCount: number;
  predictedFilteredChunkCount: number;
  blockTypeDistribution: {
    prose: number;
    header: number;
    specValue: number;
    tableRow: number;
    boilerplate: number;
  };
  predictedQualityDistribution: {
    high: number;    // share of tokens in blocks scoring >= 0.7
    medium: number;  // 0.4 – 0.7
    low: number;     // < 0.4
  };
  tokenRetentionRate: number;  // embeddable / raw, 0–1
}

export interface CorpusIngestionSummary {
  totalTokensRaw: number;
  totalTokensEmbeddable: number;
  overallRetentionRate: number;
  lossWaterfall: Array<{ stage: string; tokensLost: number; percentOfRaw: number }>;
  byDocType: Record<string, {
    docCount: number;
    retentionRate: number;
    avgQualityHigh: number;
    dominantChunkStrategy: string;
    avgPredictedChunkCount: number;
  }>;
  highRiskDocs: Array<{
    docId: string;
    retentionRate: number;
    primaryLossCause: "ocr" | "boilerplate" | "filter" | "normalization";
  }>;
}

export interface DiscoveredBoilerplatePattern {
  normalizedForm: string;       // max 60 chars
  occurrenceCount: number;
  documentCount: number;
  suggestedRegex: string;
  alreadyCovered: boolean;
  tokensAtRisk: number;
}

export interface CorpusBoilerplateSummary {
  totalCandidatePatterns: number;
  newPatterns: number;
  suppressedPatterns: number;
  totalTokensRecoverable: number;
}

export interface MuninnConfigRecommendation {
  parameter: string;
  currentDefault: string | number;
  recommendedValue: string | number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  reasoning: string;
  evidenceDocCount: number;
  affectedTokenShare: number;
}

export interface DomainProfile {
  detectedLanguage: "de" | "en" | "fr" | "mixed";
  requirementLanguageFamily: "german_modal" | "rfc2119" | "legal" | "french_modal" | "none";
  requirementLanguageCoverage: number;
  discoveredReferenceFormats: Array<{
    pattern: string;
    occurrenceCount: number;
    documentCount: number;
    alreadyExtracted: boolean;
  }>;
  dominantUnitFamily: "mechanical" | "electrical" | "pharma" | "financial" | "logistics" | "mixed" | "none";
  unitFamilyCoverage: number;
  qualityScorerProfile: "automotive_de" | "generic_de" | "generic_en" | "adapted";
}
```

- [ ] **Step 3: Add 5 new fields to `ScannerState` interface**

In `ScannerState`, after `consistencyChecks: ConsistencyCheck[];`, add:

```typescript
  // Phase 9: Ingestion Projection
  ingestionProjections: DocumentIngestionProjection[];
  corpusIngestionSummary: CorpusIngestionSummary;
  discoveredBoilerplatePatterns: DiscoveredBoilerplatePattern[];
  muninnConfigRecommendations: MuninnConfigRecommendation[];
  domainProfile: DomainProfile;
```

- [ ] **Step 4: Update `createInitialState` to initialise new fields**

Add to the return object in `createInitialState`:

```typescript
    ingestionProjections: [],
    corpusIngestionSummary: {
      totalTokensRaw: 0,
      totalTokensEmbeddable: 0,
      overallRetentionRate: 0,
      lossWaterfall: [],
      byDocType: {},
      highRiskDocs: [],
    },
    discoveredBoilerplatePatterns: [],
    muninnConfigRecommendations: [],
    domainProfile: {
      detectedLanguage: "de",
      requirementLanguageFamily: "none",
      requirementLanguageCoverage: 0,
      discoveredReferenceFormats: [],
      dominantUnitFamily: "none",
      unitFamilyCoverage: 0,
      qualityScorerProfile: "automotive_de",
    },
```

- [ ] **Step 5: Type-check**

```bash
cd /home/clemi/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/state.ts
git commit -m "feat: add Phase 9 state types to ScannerState"
```

---

## Task 7: Phase 9a — projectDocument Function

**Files:**
- Create: `src/phases/9-projection.ts`
- Create: `src/phases/9-projection.test.ts`

`ProjectionAccumulator` is created once in Phase 2's document loop and collects line frequencies and domain signal samples. `projectDocument` is called per document.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/phases/9-projection.test.ts
import { expect, test } from "bun:test";
import { ProjectionAccumulator, projectDocument } from "./9-projection.ts";
import type { ParsedDocument } from "../state.ts";

function makeDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    id: "doc-001",
    path: "test/doc.docx",
    absolutePath: "/documents/test/doc.docx",
    filename: "doc.docx",
    extension: ".docx",
    sizeBytes: 1000,
    sha256: "abc123",
    modifiedAt: new Date(),
    createdAt: new Date(),
    depth: 1,
    pathSegments: ["test"],
    charCount: 500,
    tokenCountEstimate: 100,
    language: "deu",
    headings: [],
    hasNumberedHeadings: false,
    tableCount: 0,
    parserUsed: "officeparser",
    isScannedPdf: false,
    isOcrRequired: false,
    parseSuccess: true,
    dateSignals: { mtime: "2024-01-01", ctime: "2024-01-01", mtimeReliable: true, bestDate: "2024-01-01" },
    recommendedChunkStrategy: "sliding_window",
    chunkStrategyReasoning: { recommended: "sliding_window", confidence: 0.8, signals: { headingCount: 0, headingDepth: 0, avgTokensPerSection: 0, tableCount: 0, hasNestedHeadings: false, isXlsx: false, pdfClassification: "not_pdf" } },
    requirementMetadataReliable: false,
    textContent: "Der Werkstoff muss eine Zugfestigkeit von mindestens 500 MPa aufweisen.\nSeite 1 von 10\nDer Lieferant soll die Qualität sicherstellen.\nSeite 2 von 10\nToleranzen: ±0.05 mm, Härte: 200 HV",
    ...overrides,
  };
}

test("projectDocument returns a DocumentIngestionProjection", async () => {
  const acc = new ProjectionAccumulator();
  const doc = makeDoc();
  const proj = await projectDocument(doc, acc);
  expect(proj.docId).toBe("doc-001");
  expect(proj.tokenWaterfall.raw).toBeGreaterThan(0);
  expect(proj.tokenWaterfall.embeddable).toBeGreaterThanOrEqual(0);
  expect(proj.tokenRetentionRate).toBeGreaterThanOrEqual(0);
  expect(proj.tokenRetentionRate).toBeLessThanOrEqual(1);
});

test("projectDocument detects boilerplate loss when document has page numbers", async () => {
  const acc = new ProjectionAccumulator();
  const doc = makeDoc({
    textContent: "Einleitung\nSeite 1 von 20\nInhalt\nSeite 2 von 20\nMehr Inhalt hier\nSeite 3 von 20",
  });
  const proj = await projectDocument(doc, acc);
  expect(proj.cleaningLoss.boilerplate).toBeGreaterThan(0);
});

test("projectDocument skips documents with parseSuccess false", async () => {
  const acc = new ProjectionAccumulator();
  const doc = makeDoc({ parseSuccess: false, textContent: undefined });
  const proj = await projectDocument(doc, acc);
  expect(proj.tokenWaterfall.raw).toBe(0);
  expect(proj.tokenRetentionRate).toBe(0);
});

test("projectDocument accumulates lines for boilerplate discovery", async () => {
  const acc = new ProjectionAccumulator();
  const repeatedLine = "Musterfirma GmbH Vertraulich";
  const text = Array(4).fill(repeatedLine).join("\n") + "\nNormaler Inhalt des Dokuments hier";
  const doc = makeDoc({ textContent: text });
  await projectDocument(doc, acc);
  const lineFreq = acc.getLineFrequencies();
  expect(lineFreq.get(repeatedLine.toLowerCase())).toBeDefined();
});

test("blockTypeDistribution sums to approximately 1.0", async () => {
  const acc = new ProjectionAccumulator();
  const doc = makeDoc();
  const proj = await projectDocument(doc, acc);
  const dist = proj.blockTypeDistribution;
  const total = dist.prose + dist.header + dist.specValue + dist.tableRow + dist.boilerplate;
  expect(total).toBeCloseTo(1.0, 1);
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /home/clemi/huginn && bun test src/phases/9-projection.test.ts
```
Expected: `error: Cannot find module './9-projection.ts'`

- [ ] **Step 3: Implement `src/phases/9-projection.ts` (Phase 9a + scaffolding)**

```typescript
// src/phases/9-projection.ts
import type {
  ScannerState,
  ParsedDocument,
  DocumentIngestionProjection,
  DiscoveredBoilerplatePattern,
  CorpusBoilerplateSummary,
  MuninnConfigRecommendation,
  CorpusIngestionSummary,
} from "../state.ts";
import { logger, setPhase } from "../utils/logger.ts";
import { estimateTokens, estimateChunkTokens } from "../utils/token-estimator.ts";
import { cleanContent, classifyBlock, BOILERPLATE_PATTERNS } from "../utils/cleaner.ts";
import { filterChunk } from "../utils/chunk-filter.ts";
import { scoreBlock } from "../utils/quality-scorer.ts";
import { detectDomainSignals, buildDomainProfile, type DomainSignalSample } from "../utils/domain-detector.ts";

// ── Accumulator: shared state collected during Phase 2 ─────────────────────

export class ProjectionAccumulator {
  private lineDocMap = new Map<string, Set<string>>(); // normalised line → doc IDs
  private lineCount  = new Map<string, number>();      // normalised line → total occurrences
  private lineTokens = new Map<string, number>();      // normalised line → token cost
  private domainSamples: DomainSignalSample[] = [];

  addLine(raw: string, docId: string): void {
    const key = normaliseLine(raw);
    if (!key || key.length < 4 || key.length > 120) return;
    const docs = this.lineDocMap.get(key) ?? new Set();
    docs.add(docId);
    this.lineDocMap.set(key, docs);
    this.lineCount.set(key, (this.lineCount.get(key) ?? 0) + 1);
    if (!this.lineTokens.has(key)) this.lineTokens.set(key, estimateTokens(raw));
  }

  addDomainSample(sample: DomainSignalSample): void {
    this.domainSamples.push(sample);
  }

  getLineFrequencies(): Map<string, number> {
    return this.lineCount;
  }

  getCandidateLines(minDocs: number): Array<{ key: string; occurrences: number; docCount: number; tokenCost: number }> {
    return [...this.lineDocMap.entries()]
      .filter(([, docs]) => docs.size >= minDocs)
      .map(([key, docs]) => ({
        key,
        occurrences: this.lineCount.get(key) ?? 0,
        docCount: docs.size,
        tokenCost: this.lineTokens.get(key) ?? 0,
      }));
  }

  getDomainSamples(): DomainSignalSample[] {
    return this.domainSamples;
  }
}

function normaliseLine(line: string): string {
  return line.toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\b\d{1,2}[.\s]\d{1,2}[.\s]\d{2,4}\b/g, "DATE")
    .replace(/\b\d+\b/g, "N")
    .trim();
}

// ── 9a: Per-document simulation ────────────────────────────────────────────

export async function projectDocument(
  doc: ParsedDocument,
  acc: ProjectionAccumulator,
): Promise<DocumentIngestionProjection> {
  if (!doc.parseSuccess || !doc.textContent) {
    return emptyProjection(doc.id);
  }

  const text = doc.textContent;

  // 1. Token count at each cleaning stage
  const raw = estimateTokens(text);
  const { cleaned, audit } = cleanContent(text);
  const afterNormalization = Math.max(0, raw - audit.tokensLostNormalization);
  const afterCleaning      = Math.max(0, afterNormalization - audit.tokensLostBoilerplate - audit.tokensLostRepeated);

  // 2. Classify blocks and compute post-chunking token count (with compression)
  const blocks = splitIntoBlocks(cleaned);
  const blockTypeTokens = { prose: 0, header: 0, specValue: 0, tableRow: 0, boilerplate: 0 };
  let totalCompressedTokens = 0;

  for (const block of blocks) {
    const btype = classifyBlock(block);
    const btypeKey = blockTypeToKey(btype);
    const compressed = estimateChunkTokens(block, btype);
    blockTypeTokens[btypeKey] += compressed;
    totalCompressedTokens += compressed;
  }

  const afterChunking = totalCompressedTokens;

  // 3. Filter loss simulation
  const filterLoss = { byLength: 0, byLetterRatio: 0, byPunctuation: 0 };
  let passedChunks = 0;
  let failedChunks = 0;

  for (const block of blocks) {
    const result = filterChunk(block);
    if (result.passed) {
      passedChunks++;
    } else {
      failedChunks++;
      const t = estimateTokens(block);
      if (result.rejectionReason === "too_short")        filterLoss.byLength      += t;
      else if (result.rejectionReason === "low_letter_ratio") filterLoss.byLetterRatio += t;
      else if (result.rejectionReason === "high_punctuation") filterLoss.byPunctuation += t;
    }
  }

  const totalFilterLoss = filterLoss.byLength + filterLoss.byLetterRatio + filterLoss.byPunctuation;
  const afterFilter  = Math.max(0, afterChunking - totalFilterLoss);
  const embeddable   = afterFilter;

  // 4. Chunk count simulation
  const predictedChunkCount         = simulateChunkCount(doc, afterCleaning);
  const predictedFilteredChunkCount = failedChunks;

  // 5. Quality distribution (sample ≤30 blocks)
  const sampleBlocks = evenSample(blocks, 30);
  const qualityDist  = await sampleQualityDistribution(sampleBlocks, estimateChunkTokens);

  // 6. Block type distribution (0–1 shares)
  const blockTypeDistribution = totalCompressedTokens > 0
    ? {
        prose:       blockTypeTokens.prose       / totalCompressedTokens,
        header:      blockTypeTokens.header      / totalCompressedTokens,
        specValue:   blockTypeTokens.specValue   / totalCompressedTokens,
        tableRow:    blockTypeTokens.tableRow    / totalCompressedTokens,
        boilerplate: blockTypeTokens.boilerplate / totalCompressedTokens,
      }
    : { prose: 1, header: 0, specValue: 0, tableRow: 0, boilerplate: 0 };

  // 7. Accumulate corpus data
  for (const line of cleaned.split("\n")) {
    acc.addLine(line.trim(), doc.id);
  }
  acc.addDomainSample(detectDomainSignals(text.slice(0, 8000)));

  return {
    docId: doc.id,
    tokenWaterfall: { raw, afterNormalization, afterCleaning, afterChunking, afterFilter, embeddable },
    cleaningLoss: {
      normalization: audit.tokensLostNormalization,
      boilerplate:   audit.tokensLostBoilerplate,
      repeatedLines: audit.tokensLostRepeated,
    },
    filterLoss,
    predictedChunkCount,
    predictedFilteredChunkCount,
    blockTypeDistribution,
    predictedQualityDistribution: qualityDist,
    tokenRetentionRate: raw > 0 ? embeddable / raw : 0,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyProjection(docId: string): DocumentIngestionProjection {
  return {
    docId,
    tokenWaterfall: { raw: 0, afterNormalization: 0, afterCleaning: 0, afterChunking: 0, afterFilter: 0, embeddable: 0 },
    cleaningLoss: { normalization: 0, boilerplate: 0, repeatedLines: 0 },
    filterLoss: { byLength: 0, byLetterRatio: 0, byPunctuation: 0 },
    predictedChunkCount: 0,
    predictedFilteredChunkCount: 0,
    blockTypeDistribution: { prose: 1, header: 0, specValue: 0, tableRow: 0, boilerplate: 0 },
    predictedQualityDistribution: { high: 0, medium: 0, low: 0 },
    tokenRetentionRate: 0,
  };
}

function splitIntoBlocks(text: string): string[] {
  return text.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
}

function blockTypeToKey(btype: string): "prose" | "header" | "specValue" | "tableRow" | "boilerplate" {
  if (btype === "spec_value") return "specValue";
  if (btype === "table_row")  return "tableRow";
  return btype as "prose" | "header" | "boilerplate";
}

function simulateChunkCount(doc: ParsedDocument, cleanedTokens: number): number {
  const CHUNK_SIZE    = 512;
  const CHUNK_OVERLAP = 64;
  const effective     = Math.max(1, CHUNK_SIZE - CHUNK_OVERLAP);

  switch (doc.recommendedChunkStrategy) {
    case "heading_sections": {
      const hCount = doc.headings.length;
      if (hCount === 0) return Math.max(1, Math.ceil(cleanedTokens / effective));
      const avgSectionTokens = cleanedTokens / hCount;
      return Math.max(1, Math.round(hCount * Math.ceil(avgSectionTokens / CHUNK_SIZE)));
    }
    case "table_rows":
      return Math.max(1, doc.tableCount * 10, Math.ceil(cleanedTokens / effective));
    default:
      return Math.max(1, Math.ceil(cleanedTokens / effective));
  }
}

function evenSample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)]!);
}

async function sampleQualityDistribution(
  blocks: string[],
  _estimator: typeof estimateChunkTokens,
): Promise<{ high: number; medium: number; low: number }> {
  if (blocks.length === 0) return { high: 0, medium: 0, low: 0 };
  let highTokens = 0, medTokens = 0, lowTokens = 0, total = 0;
  for (const block of blocks) {
    const btype = classifyBlock(block);
    const tokens = estimateChunkTokens(block, btype);
    const score = await scoreBlock(block, btype, {});
    total += tokens;
    if (score >= 0.7)      highTokens += tokens;
    else if (score >= 0.4) medTokens  += tokens;
    else                   lowTokens  += tokens;
  }
  if (total === 0) return { high: 0, medium: 0, low: 0 };
  return { high: highTokens / total, medium: medTokens / total, low: lowTokens / total };
}

// ── 9b: Corpus-wide boilerplate discovery ─────────────────────────────────

const COMMON_WORDS = new Set([
  "seite","von","und","der","die","das","des","dem","den","ein","eine","eines","einer","einem","einen",
  "page","of","the","and","a","an","for","in","is","it","to","with","from","this","that",
  "stand","datum","version","revision","intern","confidential","vertraulich",
]);

function isPrivacySafe(normalizedForm: string): boolean {
  const words = normalizedForm.split(/\s+/);
  for (const word of words) {
    const clean = word.replace(/[^a-zäöüß]/gi, "");
    if (clean.length > 4 && !COMMON_WORDS.has(clean.toLowerCase())) {
      return false;
    }
  }
  return true;
}

function generateRegex(key: string): string {
  const withPlaceholders = key
    .replace(/\bdate\b/g, "\\d{2}\\.\\d{2}\\.\\d{4}")
    .replace(/\bN\b/g, "\\d+")
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\\d/g, "\\d");
  return `^${withPlaceholders}$`;
}

function discoverBoilerplatePatterns(
  acc: ProjectionAccumulator,
  projections: DocumentIngestionProjection[],
): { patterns: DiscoveredBoilerplatePattern[]; summary: CorpusBoilerplateSummary } {
  const candidates = acc.getCandidateLines(3);
  const patterns: DiscoveredBoilerplatePattern[] = [];
  let suppressedPatterns = 0;
  let totalTokensRecoverable = 0;

  for (const { key, occurrences, docCount, tokenCost } of candidates) {
    const alreadyCovered = BOILERPLATE_PATTERNS.some((re) => re.test(key));
    if (!isPrivacySafe(key)) {
      suppressedPatterns++;
      continue;
    }
    const normalizedForm = key.slice(0, 60);
    const tokensAtRisk = tokenCost * occurrences;
    totalTokensRecoverable += alreadyCovered ? 0 : tokensAtRisk;
    patterns.push({
      normalizedForm,
      occurrenceCount: occurrences,
      documentCount: docCount,
      suggestedRegex: generateRegex(key),
      alreadyCovered,
      tokensAtRisk,
    });
  }

  patterns.sort((a, b) => b.tokensAtRisk - a.tokensAtRisk);

  return {
    patterns,
    summary: {
      totalCandidatePatterns: patterns.length + suppressedPatterns,
      newPatterns: patterns.filter((p) => !p.alreadyCovered).length,
      suppressedPatterns,
      totalTokensRecoverable,
    },
  };
}

// ── 9c: Config recommendation engine ──────────────────────────────────────

function generateConfigRecommendations(
  state: ScannerState,
  boilerplatePatterns: DiscoveredBoilerplatePattern[],
): MuninnConfigRecommendation[] {
  const recs: MuninnConfigRecommendation[] = [];
  const projections = state.ingestionProjections;
  const totalRaw = projections.reduce((s, p) => s + p.tokenWaterfall.raw, 0);
  if (projections.length === 0 || totalRaw === 0) return recs;

  // CHUNK_SIZE: from median section token length in heading_sections docs
  const headingDocs = state.parsed.filter(
    (d) => d.parseSuccess && d.recommendedChunkStrategy === "heading_sections" && d.headings.length > 0
  );
  if (headingDocs.length >= 3) {
    const avgSectionTokens = headingDocs.map((d) => {
      const p = projections.find((pr) => pr.docId === d.id);
      if (!p || d.headings.length === 0) return 0;
      return p.tokenWaterfall.afterCleaning / d.headings.length;
    }).filter((v) => v > 0).sort((a, b) => a - b);

    const median = avgSectionTokens[Math.floor(avgSectionTokens.length / 2)] ?? 0;
    const recommended = Math.ceil(median * 1.15 / 64) * 64;
    const splitRate = avgSectionTokens.filter((t) => t > 512).length / avgSectionTokens.length;
    if (recommended !== 512) {
      recs.push({
        parameter: "CHUNK_SIZE",
        currentDefault: 512,
        recommendedValue: Math.max(256, Math.min(1024, recommended)),
        confidence: headingDocs.length >= 10 ? "HIGH" : "MEDIUM",
        reasoning: `Median section length is ${Math.round(median)} tokens; ${Math.round(splitRate * 100)}% of sections would be split at the current default of 512.`,
        evidenceDocCount: headingDocs.length,
        affectedTokenShare: projections.filter((p) => {
          const d = state.parsed.find((pd) => pd.id === p.docId);
          return d?.recommendedChunkStrategy === "heading_sections";
        }).reduce((s, p) => s + p.tokenWaterfall.raw, 0) / totalRaw,
      });
    }
  }

  // QUALITY_THRESHOLD: from quality distribution
  const allLow    = projections.reduce((s, p) => s + p.predictedQualityDistribution.low, 0)    / projections.length;
  const allMedium = projections.reduce((s, p) => s + p.predictedQualityDistribution.medium, 0) / projections.length;
  if (allLow > 0.25) {
    recs.push({
      parameter: "QUALITY_THRESHOLD",
      currentDefault: 0.4,
      recommendedValue: 0.3,
      confidence: projections.length >= 10 ? "HIGH" : "MEDIUM",
      reasoning: `${Math.round(allLow * 100)}% of content-bearing tokens score below 0.4 — lowering threshold prevents excessive chunk loss.`,
      evidenceDocCount: projections.length,
      affectedTokenShare: allLow + allMedium,
    });
  } else if (allLow < 0.05) {
    recs.push({
      parameter: "QUALITY_THRESHOLD",
      currentDefault: 0.4,
      recommendedValue: 0.5,
      confidence: projections.length >= 10 ? "HIGH" : "MEDIUM",
      reasoning: `Only ${Math.round(allLow * 100)}% of tokens score below 0.4 — raising threshold tightens retrieval quality without significant loss.`,
      evidenceDocCount: projections.length,
      affectedTokenShare: allLow,
    });
  }

  // BOILERPLATE_PATTERNS additions
  const newPatterns = boilerplatePatterns.filter((p) => !p.alreadyCovered && p.documentCount >= 5);
  if (newPatterns.length > 0) {
    const tokenShare = newPatterns.reduce((s, p) => s + p.tokensAtRisk, 0) / totalRaw;
    recs.push({
      parameter: "BOILERPLATE_PATTERNS",
      currentDefault: "12 existing patterns",
      recommendedValue: `Add ${newPatterns.length} new pattern(s)`,
      confidence: "HIGH",
      reasoning: `${newPatterns.length} client-specific boilerplate line pattern(s) found in 5+ documents (${Math.round(tokenShare * 100)}% of corpus tokens at risk).`,
      evidenceDocCount: Math.max(...newPatterns.map((p) => p.documentCount)),
      affectedTokenShare: tokenShare,
    });
  }

  // VERSION thresholds: from versionPair score histogram
  const scores = state.versionPairs.map((vp) => vp.score);
  if (scores.length >= 10) {
    const high = scores.filter((s) => s >= 10).length;
    const mid  = scores.filter((s) => s >= 5 && s < 10).length;
    const isBimodal = mid < scores.length * 0.1 && high > scores.length * 0.3;
    if (isBimodal) {
      recs.push({
        parameter: "VERSION_AUTO_THRESHOLD",
        currentDefault: 0.95,
        recommendedValue: 0.97,
        confidence: "MEDIUM",
        reasoning: `Score distribution is bimodal (${high} pairs score 10-12, ${mid} score 5-9) — raising threshold reduces false-positive auto-supersession.`,
        evidenceDocCount: state.versionPairs.length,
        affectedTokenShare: 0,
      });
    }
  }

  return recs;
}

// ── Corpus summary ─────────────────────────────────────────────────────────

function buildCorpusSummary(
  projections: DocumentIngestionProjection[],
  parsed: ScannerState["parsed"],
): CorpusIngestionSummary {
  if (projections.length === 0) {
    return {
      totalTokensRaw: 0, totalTokensEmbeddable: 0, overallRetentionRate: 0,
      lossWaterfall: [], byDocType: {}, highRiskDocs: [],
    };
  }

  const totalRaw        = projections.reduce((s, p) => s + p.tokenWaterfall.raw, 0);
  const totalEmbeddable = projections.reduce((s, p) => s + p.tokenWaterfall.embeddable, 0);

  const stageNames = ["normalization", "boilerplate + repeated lines", "chunking compression", "content filter"];
  const stageLoss  = projections.reduce(
    (acc, p) => {
      acc[0] += p.cleaningLoss.normalization;
      acc[1] += p.cleaningLoss.boilerplate + p.cleaningLoss.repeatedLines;
      acc[2] += Math.max(0, p.tokenWaterfall.afterCleaning - p.tokenWaterfall.afterChunking);
      acc[3] += p.filterLoss.byLength + p.filterLoss.byLetterRatio + p.filterLoss.byPunctuation;
      return acc;
    },
    [0, 0, 0, 0],
  );

  const lossWaterfall = stageNames.map((stage, i) => ({
    stage,
    tokensLost: stageLoss[i]!,
    percentOfRaw: totalRaw > 0 ? (stageLoss[i]! / totalRaw) * 100 : 0,
  }));

  const byDocType: CorpusIngestionSummary["byDocType"] = {};
  for (const doc of parsed) {
    if (!doc.parseSuccess) continue;
    const proj = projections.find((p) => p.docId === doc.id);
    if (!proj) continue;
    const key = doc.detectedDocType ?? "other";
    const entry = byDocType[key] ?? { docCount: 0, retentionRate: 0, avgQualityHigh: 0, dominantChunkStrategy: doc.recommendedChunkStrategy, avgPredictedChunkCount: 0 };
    entry.docCount++;
    entry.retentionRate       = (entry.retentionRate * (entry.docCount - 1) + proj.tokenRetentionRate) / entry.docCount;
    entry.avgQualityHigh      = (entry.avgQualityHigh * (entry.docCount - 1) + proj.predictedQualityDistribution.high) / entry.docCount;
    entry.avgPredictedChunkCount = (entry.avgPredictedChunkCount * (entry.docCount - 1) + proj.predictedChunkCount) / entry.docCount;
    byDocType[key] = entry;
  }

  const highRiskDocs = projections
    .filter((p) => p.tokenRetentionRate < 0.5 && p.tokenWaterfall.raw > 0)
    .map((p) => {
      const cl = p.cleaningLoss;
      const fl = p.filterLoss;
      const doc = parsed.find((d) => d.id === p.docId);
      let primaryLossCause: CorpusIngestionSummary["highRiskDocs"][number]["primaryLossCause"] = "normalization";
      if (doc?.isOcrRequired) primaryLossCause = "ocr";
      else if (cl.boilerplate + cl.repeatedLines > cl.normalization && cl.boilerplate + cl.repeatedLines > (fl.byLength + fl.byLetterRatio + fl.byPunctuation)) primaryLossCause = "boilerplate";
      else if (fl.byLength + fl.byLetterRatio + fl.byPunctuation > cl.normalization) primaryLossCause = "filter";
      return { docId: p.docId, retentionRate: p.tokenRetentionRate, primaryLossCause };
    });

  return {
    totalTokensRaw: totalRaw,
    totalTokensEmbeddable: totalEmbeddable,
    overallRetentionRate: totalRaw > 0 ? totalEmbeddable / totalRaw : 0,
    lossWaterfall,
    byDocType,
    highRiskDocs,
  };
}

// ── Phase 9 main entry point ───────────────────────────────────────────────

export async function runProjection(state: ScannerState, acc: ProjectionAccumulator): Promise<void> {
  setPhase("9-projection");
  logger.info("Phase 9: Ingestion Projection — corpus analysis", {
    projections: state.ingestionProjections.length,
  });

  // 9b: Boilerplate discovery
  const { patterns, summary: boilerplateSummary } = discoverBoilerplatePatterns(acc, state.ingestionProjections);
  state.discoveredBoilerplatePatterns = patterns;
  logger.info("Boilerplate discovery complete", {
    candidates: boilerplateSummary.totalCandidatePatterns,
    newPatterns: boilerplateSummary.newPatterns,
    suppressed: boilerplateSummary.suppressedPatterns,
  });

  // Finalise domain profile
  const domainSamples = acc.getDomainSamples();
  const parsedLanguages = state.parsed.filter((d) => d.parseSuccess).map((d) => d.language);
  state.domainProfile = buildDomainProfile(domainSamples, parsedLanguages);
  logger.info("Domain profile finalised", {
    language: state.domainProfile.detectedLanguage,
    reqFamily: state.domainProfile.requirementLanguageFamily,
    unitFamily: state.domainProfile.dominantUnitFamily,
    profile: state.domainProfile.qualityScorerProfile,
  });

  // 9c: Config recommendations
  state.muninnConfigRecommendations = generateConfigRecommendations(state, patterns);
  logger.info("Config recommendations generated", {
    count: state.muninnConfigRecommendations.length,
  });

  // Corpus summary
  state.corpusIngestionSummary = buildCorpusSummary(state.ingestionProjections, state.parsed);
  logger.info("Corpus ingestion summary built", {
    totalTokensRaw: state.corpusIngestionSummary.totalTokensRaw,
    retentionRate: state.corpusIngestionSummary.overallRetentionRate.toFixed(2),
    highRiskDocs: state.corpusIngestionSummary.highRiskDocs.length,
  });
}
```

- [ ] **Step 4: Run to confirm pass**

```bash
cd /home/clemi/huginn && bun test src/phases/9-projection.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/phases/9-projection.ts src/phases/9-projection.test.ts
git commit -m "feat: add Phase 9 projection engine (9a per-doc, 9b boilerplate, 9c config recs)"
```

---

## Task 8: Wire Phase 9a into Phase 2

**Files:**
- Modify: `src/phases/2-parse.ts`

Phase 2 creates a `ProjectionAccumulator`, calls `projectDocument` for each successfully parsed document, and stores both on the state. The accumulator is stored on state temporarily (as a non-serialized field) so Phase 9 can use it.

To avoid a circular import (`state.ts` → `9-projection.ts` → `state.ts`), the accumulator is **not** stored on `ScannerState`. Instead, `2-parse.ts` exports a module-level variable that `9-projection.ts` reads.

- [ ] **Step 1: Export accumulator from Phase 2**

In `src/phases/2-parse.ts`, at module scope (outside any function), add:
```typescript
import { ProjectionAccumulator, projectDocument } from "./9-projection.ts";

export let _lastAccumulator: ProjectionAccumulator | null = null;
```

In `runParse`, before the document-processing loop:
```typescript
const projectionAcc = new ProjectionAccumulator();
```

At the end of each successful document parse (after `state.parsed.push(parsedDoc)`):
```typescript
const projection = await projectDocument(parsedDoc, projectionAcc);
state.ingestionProjections.push(projection);
```

After the loop completes:
```typescript
_lastAccumulator = projectionAcc;
logger.info("Phase 9a complete", { projectedDocs: state.ingestionProjections.length });
```

- [ ] **Step 2: Read accumulator in Phase 9**

In `src/phases/9-projection.ts`, update `runProjection` signature and body to import the accumulator:
```typescript
import { _lastAccumulator } from "./2-parse.ts";

export async function runProjection(state: ScannerState): Promise<void> {
  const acc = _lastAccumulator;
  if (!acc) {
    logger.warn("Phase 9: no accumulator from Phase 2 — skipping corpus analysis");
    return;
  }
  // ... rest of existing implementation unchanged
}
```

- [ ] **Step 3: Type-check**

```bash
cd /home/clemi/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/phases/2-parse.ts src/state.ts
git commit -m "feat: wire Phase 9a projection into Phase 2 parse loop"
```

---

## Task 9: Wire Phase 9 into Pipeline and Serialise New JSON Keys

**Files:**
- Modify: `src/index.ts`
- Modify: `src/phases/8-report.ts`

- [ ] **Step 1: Add Phase 9 to the pipeline in `src/index.ts`**

At the top, add the import:
```typescript
import { runProjection } from "./phases/9-projection.ts";
```

In the `phases` array in `main()`, insert after `"2-parse"`:
```typescript
    {
      name: "9-projection",
      fn: () => runProjection(state),
    },
```

- [ ] **Step 2: Serialise new fields in `src/phases/8-report.ts`**

Find the `serializeState` function (or the section that builds the JSON output object). Add the five new top-level keys to the serialized report object:

```typescript
tokenProjection:    state.ingestionProjections,
corpusTokenSummary: state.corpusIngestionSummary,
boilerplateDiscovery: {
  patterns: state.discoveredBoilerplatePatterns,
  summary: {
    totalCandidatePatterns: state.discoveredBoilerplatePatterns.length,
    newPatterns: state.discoveredBoilerplatePatterns.filter((p) => !p.alreadyCovered).length,
    suppressedPatterns: 0,
    totalTokensRecoverable: state.corpusIngestionSummary.totalTokensRaw > 0
      ? state.discoveredBoilerplatePatterns.filter((p) => !p.alreadyCovered).reduce((s, p) => s + p.tokensAtRisk, 0)
      : 0,
  },
},
muninnConfig:  state.muninnConfigRecommendations,
domainProfile: state.domainProfile,
```

Note: `suggestedRegex` fields in `discoveredBoilerplatePatterns` must be exempt from the `deepTruncateStrings` guard (they contain regex syntax, not document content). Add the key to an exemption list or handle in the sanitizer:

```typescript
// In deepTruncateStrings, add a key exemption check:
function deepTruncateStrings(obj: unknown, exemptKeys: Set<string> = new Set(["suggestedRegex"])): unknown {
  // ... existing logic, but skip truncation when current key is in exemptKeys
}
```

Update the `deepTruncateStrings` call signature if needed to thread the exempt keys through recursive calls.

- [ ] **Step 3: Type-check**

```bash
cd /home/clemi/huginn && bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Run all tests**

```bash
cd /home/clemi/huginn && bun test
```
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/phases/8-report.ts
git commit -m "feat: add Phase 9 to pipeline and serialise new JSON keys"
```

---

## Task 10: HTML Generator — Scaffold and Existing Sections

**Files:**
- Create: `src/phases/8-html.ts`

This is a standalone CLI tool: `bun src/phases/8-html.ts <path-to-scan-report.json>`. It reads the JSON, generates a complete self-contained HTML, and writes it alongside the JSON file.

The style (dark theme, IBM Plex Mono, Chart.js) is ported from the reference HTML at `/home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.html`. The data is embedded via `<script id="report-data" type="application/json">` and read by `window.__huginnData` exactly as in the reference.

- [ ] **Step 1: Create the scaffold**

```typescript
// src/phases/8-html.ts
import { readFileSync, writeFileSync } from "fs";
import { join, dirname, basename } from "path";

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("Usage: bun src/phases/8-html.ts <path-to-scan-report.json>");
    process.exit(1);
  }

  const json = readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(json);

  const html = generateHtml(data, json);

  const outPath = join(dirname(jsonPath), basename(jsonPath, ".json") + ".html");
  writeFileSync(outPath, html, "utf-8");
  console.log(`HTML report written to: ${outPath}`);
}

function generateHtml(data: Record<string, unknown>, rawJson: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Huginn Dashboard — ${esc(String(data.scanId ?? ""))}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
  <style>${CSS}</style>
</head>
<body>
<script id="report-data" type="application/json">${rawJson}</script>
<script>
(function() {
  var _el = document.getElementById('report-data');
  var _d = {};
  try { _d = _el ? JSON.parse(_el.textContent || '{}') : {}; } catch(e) {}
  window.__huginnData = _d;
})();
</script>
<div class="container">
  ${sectionHeader(data)}
  ${sectionMuninnConfig(data)}
  ${sectionQualityGauge(data)}
  ${sectionDocDistribution(data)}
  ${sectionIngestionIntelligence(data)}
  ${sectionFileTree(data)}
  ${sectionVersionPairs(data)}
  ${sectionRequirements(data)}
  ${sectionReferences(data)}
  ${sectionParseHealth(data)}
  ${sectionBoilerplateDiscovery(data)}
  ${sectionConsistencyChecks(data)}
</div>
</body>
</html>`;
}

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Add the CSS constant**

Port the CSS from the reference HTML (lines 7–1243 of the reference file). Extract as a template literal `const CSS = \`...\``. The reference file is at `/home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.html` — read lines 7–1240 for the style block content.

- [ ] **Step 3: Port existing section functions from reference HTML**

For each of the following sections, port the HTML and JS from the reference file into a TypeScript function that accepts `data` and returns an HTML string with an inline `<script>` block:

- `sectionHeader(data)` — KPI cards header (reference lines 1273–1308)
- `sectionQualityGauge(data)` — gauge chart (lines 1309–1360)
- `sectionDocDistribution(data)` — charts + filterable table (lines 1383–1443); add `retention %` and `dominant loss cause` columns using `data.tokenProjection`
- `sectionFileTree(data)` — collapsible tree (lines 1595–1778)
- `sectionVersionPairs(data)` — histogram + pairs table (lines 1779–6782)
- `sectionRequirements(data)` — requirements landscape (lines 6783–6949)
- `sectionReferences(data)` — reference graph (lines 6950–7012)
- `sectionParseHealth(data)` — parse health + OCR (lines 7013–7055); add OCR token loss note using `data.corpusTokenSummary`
- `sectionConsistencyChecks(data)` — checks table (lines 7056–end)

- [ ] **Step 4: Smoke test**

```bash
cd /home/clemi/huginn && bun src/phases/8-html.ts /home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.json
```
Expected: `HTML report written to: /home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.html` with no errors. Open in browser and verify header and existing sections render.

- [ ] **Step 5: Commit**

```bash
git add src/phases/8-html.ts
git commit -m "feat: add HTML report generator scaffold with existing sections"
```

---

## Task 11: HTML — Muninn Config Recommendations Section

**Files:**
- Modify: `src/phases/8-html.ts`

- [ ] **Step 1: Implement `sectionMuninnConfig`**

```typescript
function sectionMuninnConfig(data: Record<string, unknown>): string {
  const recs = (data.muninnConfig as any[]) ?? [];
  if (recs.length === 0) return "";

  const CONF_COLOUR: Record<string, string> = {
    HIGH: "#43a047", MEDIUM: "#ff9800", LOW: "#607d8b",
  };

  const cards = recs.map((r: any) => `
    <div class="config-card">
      <div class="config-card-header">
        <span class="config-param">${esc(r.parameter)}</span>
        <span class="config-badge" style="color:${CONF_COLOUR[r.confidence] ?? "#607d8b"}">${esc(r.confidence)}</span>
      </div>
      <div class="config-value">
        <span class="config-old">${esc(String(r.currentDefault))}</span>
        <span class="config-arrow">→</span>
        <span class="config-new">${esc(String(r.recommendedValue))}</span>
        <button class="copy-btn" onclick="navigator.clipboard.writeText('${esc(String(r.recommendedValue))}')">copy</button>
      </div>
      <div class="config-reasoning">${esc(r.reasoning)}</div>
      <div class="config-meta">${r.evidenceDocCount} doc(s) · ${(r.affectedTokenShare * 100).toFixed(1)}% of corpus tokens affected</div>
    </div>`).join("");

  const envDiff = recs
    .filter((r: any) => r.parameter !== "BOILERPLATE_PATTERNS")
    .map((r: any) => `# ${r.parameter}\n- ${r.parameter}=${r.currentDefault}\n+ ${r.parameter}=${r.recommendedValue}`)
    .join("\n");

  return `
<section id="muninn-config">
  <h2>Muninn Config Recommendations</h2>
  <p class="section-desc">Based on corpus analysis — copy values directly into Muninn .env before ingestion.</p>
  <div class="config-cards">${cards}</div>
  <div style="margin-top:1rem">
    <button class="tree-btn" onclick="navigator.clipboard.writeText(document.getElementById('env-diff').textContent)">Copy .env diff</button>
    <pre id="env-diff" style="margin-top:.5rem;background:#0f1419;padding:1rem;border-radius:4px;font-size:.8em;color:#a0a4ab;white-space:pre-wrap">${esc(envDiff)}</pre>
  </div>
</section>

<style>
.config-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:1rem; }
.config-card { background:#1a1f26; border:1px solid #2a3038; border-radius:4px; padding:1.25rem; display:flex; flex-direction:column; gap:.4rem; }
.config-card-header { display:flex; justify-content:space-between; align-items:center; }
.config-param { font-family:"IBM Plex Mono","Fira Code",monospace; font-weight:700; font-size:.9em; }
.config-badge { font-size:.7em; font-weight:700; text-transform:uppercase; letter-spacing:1px; }
.config-value { display:flex; align-items:center; gap:.5rem; font-family:"IBM Plex Mono","Fira Code",monospace; }
.config-old { color:#607d8b; text-decoration:line-through; }
.config-arrow { color:#a0a4ab; }
.config-new { color:#ff6b35; font-weight:700; }
.copy-btn { background:#2a3038; border:none; color:#a0a4ab; padding:.2rem .5rem; border-radius:3px; cursor:pointer; font-size:.7em; }
.copy-btn:hover { background:#ff6b35; color:#fff; }
.config-reasoning { font-size:.8em; color:#a0a4ab; line-height:1.5; }
.config-meta { font-size:.72em; color:#607d8b; }
</style>`;
}
```

- [ ] **Step 2: Smoke test**

```bash
cd /home/clemi/huginn && bun src/phases/8-html.ts /home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.json
```
Open HTML in browser. The Muninn Config section should be visible near the top (the existing JSON has no `muninnConfig` key yet, so it renders empty — verify graceful empty-state rendering).

- [ ] **Step 3: Commit**

```bash
git add src/phases/8-html.ts
git commit -m "feat: add Muninn Config Recommendations section to HTML report"
```

---

## Task 12: HTML — Ingestion Intelligence Section

**Files:**
- Modify: `src/phases/8-html.ts`

- [ ] **Step 1: Implement `sectionIngestionIntelligence`**

```typescript
function sectionIngestionIntelligence(data: Record<string, unknown>): string {
  const summary = (data.corpusTokenSummary as any) ?? null;
  if (!summary || summary.totalTokensRaw === 0) return "";

  const waterfall = (summary.lossWaterfall as any[]) ?? [];
  const byDocType = summary.byDocType as Record<string, any> ?? {};
  const highRisk  = (summary.highRiskDocs as any[]) ?? [];

  const waterfallStages = ["raw", "afterNormalization", "afterCleaning", "afterChunking", "afterFilter", "embeddable"];
  const STAGE_LABELS = ["Raw", "After Normalisation", "After Cleaning", "After Chunking", "After Filter", "Embeddable"];
  const STAGE_COLOURS = ["#607d8b", "#78909c", "#ff9800", "#f57c00", "#e53935", "#43a047"];

  const projections = (data.tokenProjection as any[]) ?? [];
  const stageValues = waterfallStages.map((k) =>
    projections.reduce((s: number, p: any) => s + (p.tokenWaterfall?.[k] ?? 0), 0)
  );

  const docTypeLabels  = Object.keys(byDocType);
  const retentionData  = docTypeLabels.map((k) => (byDocType[k].retentionRate * 100).toFixed(1));
  const retentionColours = docTypeLabels.map((k) =>
    byDocType[k].retentionRate < 0.4 ? "#e53935" : byDocType[k].retentionRate < 0.6 ? "#ff9800" : "#43a047"
  );

  const highRiskRows = highRisk.slice(0, 10).map((d: any) => {
    const parsed = ((data.parsed as any[]) ?? []).find((p: any) => p.id === d.docId);
    return `<tr>
      <td style="font-family:monospace;font-size:.78em">${esc(parsed?.filename ?? d.docId)}</td>
      <td style="color:${d.retentionRate < 0.4 ? "#e53935" : "#ff9800"}">${(d.retentionRate * 100).toFixed(0)}%</td>
      <td>${esc(d.primaryLossCause)}</td>
    </tr>`;
  }).join("");

  return `
<section id="ingestion-intelligence">
  <h2>Ingestion Intelligence</h2>
  <p class="section-desc">Predicted token flow through Muninn's ingestion pipeline — no documents were ingested; values are simulated from corpus structure.</p>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem">
    <div>
      <h3>Token Waterfall</h3>
      <canvas id="waterfall-chart" height="120"></canvas>
    </div>
    <div>
      <h3>Retention by Doc Type</h3>
      <canvas id="retention-chart" height="120"></canvas>
    </div>
  </div>
  ${highRisk.length > 0 ? `
  <h3>High-Risk Documents (retention &lt; 50%)</h3>
  <table class="data-table">
    <thead><tr><th>Filename</th><th>Retention</th><th>Primary Loss Cause</th></tr></thead>
    <tbody>${highRiskRows}</tbody>
  </table>` : ""}
</section>
<script>
(function() {
  var stageValues = ${JSON.stringify(stageValues)};
  var stageLabels = ${JSON.stringify(STAGE_LABELS)};
  var stageColours = ${JSON.stringify(STAGE_COLOURS)};

  new Chart(document.getElementById('waterfall-chart'), {
    type: 'bar',
    data: { labels: stageLabels, datasets: [{ data: stageValues, backgroundColor: stageColours }] },
    options: {
      indexAxis: 'y', plugins: { legend: { display: false } },
      scales: { x: { ticks: { color: '#a0a4ab' } }, y: { ticks: { color: '#a0a4ab' } } }
    }
  });

  var dtLabels = ${JSON.stringify(docTypeLabels)};
  var dtValues = ${JSON.stringify(retentionData)};
  var dtColours = ${JSON.stringify(retentionColours)};
  new Chart(document.getElementById('retention-chart'), {
    type: 'bar',
    data: { labels: dtLabels, datasets: [{ label: 'Retention %', data: dtValues, backgroundColor: dtColours }] },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        y: { min: 0, max: 100, ticks: { color: '#a0a4ab', callback: function(v) { return v + '%'; } } },
        x: { ticks: { color: '#a0a4ab' } }
      }
    }
  });
})();
</script>`;
}
```

- [ ] **Step 2: Smoke test**

```bash
cd /home/clemi/huginn && bun src/phases/8-html.ts /home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.json
```
Open in browser. Ingestion Intelligence section should render with empty charts (no Phase 9 data yet). Verify no JS errors in console.

- [ ] **Step 3: Commit**

```bash
git add src/phases/8-html.ts
git commit -m "feat: add Ingestion Intelligence section to HTML report"
```

---

## Task 13: HTML — Boilerplate Discovery Section

**Files:**
- Modify: `src/phases/8-html.ts`

- [ ] **Step 1: Implement `sectionBoilerplateDiscovery`**

```typescript
function sectionBoilerplateDiscovery(data: Record<string, unknown>): string {
  const discovery = (data.boilerplateDiscovery as any) ?? null;
  if (!discovery) return "";

  const patterns = ((discovery.patterns as any[]) ?? []).filter((p: any) => !p.alreadyCovered);
  if (patterns.length === 0) {
    return `
<section id="boilerplate-discovery">
  <h2>Boilerplate Discovery</h2>
  <p class="section-desc">No new client-specific boilerplate patterns detected beyond Muninn's existing set.</p>
</section>`;
  }

  const rows = patterns.slice(0, 50).map((p: any) => `
    <tr>
      <td style="font-family:monospace;font-size:.78em;word-break:break-all">${esc(p.normalizedForm)}</td>
      <td>${p.documentCount}</td>
      <td>${p.occurrenceCount}</td>
      <td>${p.tokensAtRisk}</td>
      <td><span style="color:#43a047;font-size:.75em">NEW</span></td>
      <td style="font-family:monospace;font-size:.72em;color:#ff6b35">
        ${esc(p.suggestedRegex)}
        <button class="copy-btn" onclick="navigator.clipboard.writeText('${esc(p.suggestedRegex)}')">copy</button>
      </td>
    </tr>`).join("");

  const allNewRegexes = patterns.map((p: any) => `  ${p.suggestedRegex},`).join("\n");

  return `
<section id="boilerplate-discovery">
  <h2>Boilerplate Discovery</h2>
  <p class="section-desc">${patterns.length} new pattern(s) found — add to Muninn's <code>cleaner.ts</code> BOILERPLATE_PATTERNS array.</p>
  <button class="tree-btn" style="margin-bottom:1rem" onclick="navigator.clipboard.writeText(document.getElementById('bp-patterns').textContent)">Copy all new patterns</button>
  <pre id="bp-patterns" style="background:#0f1419;padding:1rem;border-radius:4px;font-size:.78em;color:#ff6b35;margin-bottom:1rem;white-space:pre-wrap">// Add to cleaner.ts BOILERPLATE_PATTERNS:\n${esc(allNewRegexes)}</pre>
  <table class="data-table" style="font-size:.82em">
    <thead>
      <tr>
        <th>Normalised Form</th><th>Docs</th><th>Occurrences</th><th>Tokens at Risk</th><th>Status</th><th>Suggested Regex</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</section>`;
}
```

- [ ] **Step 2: Smoke test**

```bash
cd /home/clemi/huginn && bun src/phases/8-html.ts /home/clemi/work/RAG/scan-report-2026-03-26T13-37-16.json
```
Open in browser. Boilerplate section should render with empty state message (no data yet). Verify no errors.

- [ ] **Step 3: Commit**

```bash
git add src/phases/8-html.ts
git commit -m "feat: add Boilerplate Discovery section to HTML report"
```

---

## Task 14: End-to-end Smoke Test

Run the full scanner against the test documents to verify Phase 9 JSON output, then generate the HTML report with real Phase 9 data.

- [ ] **Step 1: Run full scan (requires Docker with Tika + Ollama)**

```bash
cd /home/clemi/huginn && docker compose up -d && bun run start
```
Expected: Phase 9 logs appear: `"Phase 9a complete"`, `"Boilerplate discovery complete"`, `"Config recommendations generated"`.

- [ ] **Step 2: Inspect JSON output**

```bash
ls /reports/scan-report-*.json | tail -1 | xargs -I{} sh -c 'cat {} | python3 -m json.tool | grep -A5 "muninnConfig\|corpusTokenSummary\|boilerplateDiscovery\|domainProfile"'
```
Expected: all five new top-level keys present in the JSON.

- [ ] **Step 3: Generate HTML report from the new JSON**

```bash
bun src/phases/8-html.ts $(ls /reports/scan-report-*.json | tail -1)
```
Expected: HTML file written. Open in browser and verify all three new sections (Muninn Config, Ingestion Intelligence, Boilerplate Discovery) render with real data.

- [ ] **Step 4: Verify privacy guard still passes**

The `sanitizeReport` function in `8-report.ts` runs as part of report generation. If it does not throw during the scan, the guard passed. Confirm from the scan log: no `"Content leak guard triggered"` errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: Phase 9 ingestion projection complete — JSON + HTML"
```
