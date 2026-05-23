# Sector Profiles & Company Identity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Huginn pipeline sector-agnostic by introducing TypeScript profile files that drive norm extraction, requirement classification, and company identity matching.

**Architecture:** A `SectorProfile` interface (in `src/profiles/types.ts`) carries sector-specific patterns. The active profile is resolved once at scan start in `pipeline.ts` and stored on `ScannerState`. Each phase that was previously hardcoded to German automotive patterns now reads from `state.sectorProfile`. A separate `CompanyIdentity` setup step and word-matching utility enable internal/external document classification.

**Tech Stack:** Bun + TypeScript strict mode, `exactOptionalPropertyTypes: true`, no new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-23-sector-profiles-design.md`

---

## File Map

**New files:**
- `src/profiles/types.ts` — `SectorProfile`, `CompanyIdentity`, `ReqType`
- `src/profiles/automotive.ts` — built-in automotive profile (migrates hardcoded patterns)
- `src/profiles/index.ts` — barrel export, `PROFILES` array
- `src/utils/company-identity.ts` — load/save/match company identity
- `src/utils/company-identity.test.ts` — word-matching tests

**Modified files:**
- `src/state.ts` — add `documentOrigin` to `FileEntry`; rename `RequirementDensityVector` fields; change `ExtractedRequirement.type` to internal taxonomy; add `sectorProfile` + `companyIdentity` to `ScannerState`
- `src/pipeline.ts` — add `sectorProfileId` to `ScanSettings`; resolve profile + identity at startup
- `src/server/setup-state.ts` — add `companyIdentity` to `SetupState`
- `src/server/routes.ts` — add company identity API; pass `sectorProfileId` to pipeline
- `src/phases/1-harvest.ts` — set `documentOrigin` via path word-match
- `src/phases/2-parse.ts` — post-parse pass: set `documentOrigin` via text word-match
- `src/phases/4-fingerprint.ts` — use profile patterns for density; rename density fields
- `src/phases/5-cluster.ts` — update to renamed density field names
- `src/phases/6-references.ts` — use `state.sectorProfile.normPattern` + `normCanonical` + `entityIdPatterns`
- `src/phases/7-requirements.ts` — use `state.sectorProfile.requirementPatterns`; output internal taxonomy
- `src/phases/9-report.ts` — update "MUSS/SOLL/KANN" string references; include profile label
- `src/phases/9-html.ts` — update `TYPE_COLOR` map to internal taxonomy
- `src/dashboard/components/requirements-landscape.ts` — update `TYPE_COLORS` to internal taxonomy
- `src/dashboard/lib/report-types.ts` — update `type` union to internal taxonomy
- `src/dashboard/_fixtures/sample-reports.ts` — update fixture type values
- `src/dashboard/html-template.ts` — update `TC` color map
- `src/ui/index.html` — sector profile dropdown in scan settings; company name in setup wizard

---

## Task 1: Create `src/profiles/types.ts`

**Files:**
- Create: `src/profiles/types.ts`

- [ ] **Step 1: Write the file**

```ts
import type { RequirementLanguageFamily, UnitFamily } from "../utils/quality-scorer.ts";
import type { ExtractedReference } from "../state.ts";

export type ReqType =
  | "MANDATORY"
  | "RECOMMENDED"
  | "PERMITTED"
  | "DECLARATIVE"
  | "INFORMATIVE";

export interface SectorProfile {
  id: string;
  label: string;
  description: string;
  requirementLanguageFamily: RequirementLanguageFamily;
  unitFamily: UnitFamily;
  requirementPatterns: {
    MANDATORY:   RegExp;
    RECOMMENDED: RegExp;
    PERMITTED:   RegExp;
    DECLARATIVE: RegExp;
  };
  normPattern:   RegExp;
  normCanonical: Record<string, string>;
  safetyKeywords:    RegExp;
  deliveryKeywords?: RegExp;
  classifyNormType?: (rawText: string) => ExtractedReference["type"];
  entityIdPatterns?: Array<{ pattern: RegExp; type: ExtractedReference["type"] }>;
}

export interface CompanyIdentity {
  name: string;
  aliases: string[];
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors (new file only adds types, nothing imports it yet).

- [ ] **Step 3: Commit**

```bash
git add src/profiles/types.ts
git commit -m "feat(profiles): add SectorProfile and CompanyIdentity interfaces"
```

---

## Task 2: Create `src/profiles/automotive.ts`

This migrates all hardcoded patterns from `regex-patterns.ts`, `config.ts` (oemPatterns), and `6-references.ts` (AUTOMOTIVE_NORM_CANONICAL) into a single profile file.

**Files:**
- Create: `src/profiles/automotive.ts`

- [ ] **Step 1: Write the file**

```ts
import type { SectorProfile } from "./types.ts";
import type { ExtractedReference } from "../state.ts";

function classifyNormType(rawText: string): ExtractedReference["type"] {
  if (/^\s*VDA/i.test(rawText))  return "vda_norm";
  if (/^\s*IATF/i.test(rawText)) return "iatf_norm";
  if (/^\s*DIN/i.test(rawText))  return "din_norm";
  if (/^\s*EN\s/i.test(rawText)) return "en_norm";
  return "iso_norm";
}

// Static canonical lookup for automotive norms — copied from 6-references.ts
// AUTOMOTIVE_NORM_CANONICAL. DO NOT trim this list; it powers certain-confidence
// normalization without an LLM call.
const normCanonical: Record<string, string> = {
  "ISO 9001": "ISO 9001:2015",
  "ISO 9001:2015": "ISO 9001:2015",
  "DIN EN ISO 9001": "ISO 9001:2015",
  "EN ISO 9001": "ISO 9001:2015",
  "ISO 14001": "ISO 14001:2015",
  "ISO 14001:2015": "ISO 14001:2015",
  "ISO 45001": "ISO 45001:2018",
  "ISO 45001:2018": "ISO 45001:2018",
  "IATF 16949": "IATF 16949:2016",
  "IATF 16949:2016": "IATF 16949:2016",
  "ISO/TS 16949": "IATF 16949:2016",
  "ISO TS 16949": "IATF 16949:2016",
  "TS 16949": "IATF 16949:2016",
  "ISO 26262": "ISO 26262:2018",
  "ISO 26262:2018": "ISO 26262:2018",
  "ISO 26262-2": "ISO 26262-2:2018",
  "IEC 61508": "IEC 61508:2010",
  "IEC 61508:2010": "IEC 61508:2010",
  "ISO/IEC 61508": "IEC 61508:2010",
  "ISO 13849": "ISO 13849-1:2015",
  "ISO 13849-1": "ISO 13849-1:2015",
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
  "ASPICE": "Automotive SPICE PAM 3.1",
  "Automotive SPICE": "Automotive SPICE PAM 3.1",
  "A-SPICE": "Automotive SPICE PAM 3.1",
  "AIAG FMEA": "AIAG & VDA FMEA Handbook 1st Edition",
  "AIAG MSA": "AIAG MSA 4th Edition",
  "AIAG APQP": "AIAG APQP 2nd Edition",
  "AIAG PPAP": "AIAG PPAP 4th Edition",
  "ISO 10204": "ISO 10204:2004",
  "DIN EN 10204": "ISO 10204:2004",
  "EN 10204": "ISO 10204:2004",
  "DIN EN 1090": "DIN EN 1090-2:2018",
  "ISO 1101": "ISO 1101:2017",
  "ISO 286": "ISO 286-1:2010",
  "REACH": "REACH Regulation (EC) 1907/2006",
  "RoHS": "RoHS Directive 2011/65/EU",
  "DIN EN 13523": "DIN EN 13523",
  "DIN 1055": "DIN 1055",
  "ISO 9241": "ISO 9241",
  "DIN EN ISO 14001": "ISO 14001:2015",
};

export const automotiveDe: SectorProfile = {
  id: "automotive_de",
  label: "Automotive (DE)",
  description: "German automotive — ISO/VDA/IATF norms, MUSS/SOLL/KANN requirements",
  requirementLanguageFamily: "german_modal",
  unitFamily: "mechanical",

  requirementPatterns: {
    MANDATORY:   /\b(muss|müssen|ist\s+zu|sind\s+zu|hat\s+zu|haben\s+zu|shall|must)\b/gi,
    RECOMMENDED: /\b(soll|sollen|sollte|sollten|should)\b/gi,
    PERMITTED:   /\b(kann|können|darf|dürfen|may|can)\b/gi,
    DECLARATIVE: /(?:\b\d[\d.,]*\s*(?:mm|cm|MPa|bar|°C|%|kN|rpm|μm|nm)\b|[A-Z]{2,4}[-_]\d{3,}(?:\s+Rev\.?\s*\d+)?)/gi,
  },

  normPattern: /\b(ISO|DIN|EN|DIN\s?EN|VDA|IATF)\s*[\d]{1,6}(?:[.,]\d+)?(?:[:\-\/]\d{1,5})?(?:[:\-]\d+)?(?!\w)/gi,
  normCanonical,

  safetyKeywords:   /\b(sicherheitsrelevant|sicherheitskritisch|Sicherheit|FMEA|Dichtheit|dicht|Explosion|explosionsgefahr|kritisch|safety|safety-relevant)\b/gi,
  deliveryKeywords: /\b(Lieferung|Lieferant|Lieferbedingung|Incoterms|EXW|FCA|DAP|DDP|Versand|Transport|delivery|supplier)\b/gi,

  classifyNormType,

  entityIdPatterns: [
    { pattern: /\bQV[-\s]?\d{3,6}(?:[-\s]v?\d+)?(?!\w)/gi,                                  type: "quality_spec" },
    { pattern: /\bFIKB[-\s]?\d{2,6}(?!\w)/gi,                                                type: "fikb" },
    { pattern: /\bKB[-_]?Master[-_\s]?(?:Nummer|Nr\.?)[-\s:]*\d{1,8}(?!\w)/gi,              type: "kb_master" },
  ],
};
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add src/profiles/automotive.ts
git commit -m "feat(profiles): add built-in automotive_de sector profile"
```

---

## Task 3: Create `src/profiles/index.ts` and profile test

**Files:**
- Create: `src/profiles/index.ts`

- [ ] **Step 1: Write the barrel**

```ts
import type { SectorProfile } from "./types.ts";
import { automotiveDe } from "./automotive.ts";

export { automotiveDe } from "./automotive.ts";
export type { SectorProfile, CompanyIdentity, ReqType } from "./types.ts";

export const PROFILES: SectorProfile[] = [automotiveDe];

export function resolveProfile(id: string): SectorProfile {
  return PROFILES.find((p) => p.id === id) ?? automotiveDe;
}
```

- [ ] **Step 2: Write a sanity test in automotive.ts to ensure profile integrity**

Add to the bottom of `src/profiles/automotive.ts`:

```ts
// Inline integrity check — runs at import time during tests.
// Keeps profile authors honest: all required patterns must be non-empty regexes.
if (process.env["NODE_ENV"] === "test") {
  const p = automotiveDe;
  if (!p.normPattern.source || !p.safetyKeywords.source) {
    throw new Error("automotive profile: missing required pattern");
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/profiles/index.ts src/profiles/automotive.ts
git commit -m "feat(profiles): add PROFILES barrel and resolveProfile helper"
```

---

## Task 4: Update `src/state.ts` — internal taxonomy + new fields

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Add `documentOrigin` to `FileEntry`**

In `src/state.ts`, find the `FileEntry` interface (line 4). Add after `inferredDocumentCategory`:

```ts
  documentOrigin?: "internal" | "external";   // set by Phase 1/2 via company identity matching
```

- [ ] **Step 2: Rename `RequirementDensityVector` fields**

Replace the entire `RequirementDensityVector` interface (lines 83–90):

```ts
export interface RequirementDensityVector {
  mandatoryPerPage:   number;  // was mussPerPage
  recommendedPerPage: number;  // was sollPerPage
  permittedPerPage:   number;  // was kannPerPage
  informativePerPage: number;  // was informativPerPage
  quantitativeValuesPerPage: number;
  entityRefPerPage:   number;  // was fikbReferencesPerPage — generic OEM/entity IDs
}
```

- [ ] **Step 3: Change `ExtractedRequirement.type` to internal taxonomy**

Replace line 133:
```ts
  type: "MANDATORY" | "RECOMMENDED" | "PERMITTED" | "INFORMATIVE" | "DECLARATIVE";
```

- [ ] **Step 4: Change `ExtractedRequirement.category` to English**

Replace line 134:
```ts
  category: "Material" | "Tolerance" | "Testing" | "Packaging" | "Delivery" | "Safety" | "Other";
```

- [ ] **Step 5: Update `linkedFikb` field comment on line 140**

Replace:
```ts
  linkedFikb?: string;           // FIKB/KB_Master number if present
```
With:
```ts
  linkedEntityRef?: string;      // OEM/entity requirement ID if present (e.g. FIKB, KB_Master)
```

- [ ] **Step 6: Add `sectorProfile` and `companyIdentity` to `ScannerState`**

Add these two imports at the top of `src/state.ts` (after the existing comment):

```ts
import type { SectorProfile, CompanyIdentity } from "./profiles/types.ts";
```

In the `ScannerState` interface, add after `documentsRoot`:

```ts
  sectorProfile: SectorProfile;
  companyIdentity: CompanyIdentity | null;
```

- [ ] **Step 7: Update `createInitialState`**

`createInitialState` takes a new `profile` parameter. Update signature and body:

```ts
import { automotiveDe } from "./profiles/automotive.ts";

export function createInitialState(
  scanId: string,
  documentsRoot: string,
  profile: SectorProfile = automotiveDe,
  companyIdentity: CompanyIdentity | null = null,
): ScannerState {
  return {
    scanId,
    startedAt: new Date(),
    documentsRoot,
    sectorProfile: profile,
    companyIdentity,
    files: [],
    // ... rest unchanged
  };
}
```

- [ ] **Step 8: Fix `domainProfile` default in `createInitialState`**

The `domainProfile.qualityScorerProfile` default `"automotive_de"` is still valid — leave it.

- [ ] **Step 9: Typecheck (expect errors — fix in later tasks)**

Run: `bun run typecheck`
Expected: errors in phases 4, 5, 7, dashboard, 9-html, 9-report. These are fixed task-by-task. List the errors for reference.

- [ ] **Step 10: Commit current state.ts changes**

```bash
git add src/state.ts
git commit -m "refactor(state): internal requirement taxonomy, renamed density fields, sector profile fields"
```

---

## Task 5: Create `src/utils/company-identity.ts` and tests

**Files:**
- Create: `src/utils/company-identity.ts`
- Create: `src/utils/company-identity.test.ts`

- [ ] **Step 1: Write the utility**

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { CompanyIdentity } from "../profiles/types.ts";

export const COMPANY_FILE_PATH =
  process.env["COMPANY_FILE_PATH"] ?? "/app/state/company.json";

const STOP_WORDS = new Set([
  "gmbh", "ag", "ltd", "inc", "corp", "co", "plc", "se", "sa",
  "the", "and", "von", "der", "die", "das", "und",
]);

export function extractSignificantWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[\s\-_&,./\\]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
}

export function matchesCompany(text: string, identity: CompanyIdentity): boolean {
  const normalized = text.toLowerCase();
  const candidates = [identity.name, ...identity.aliases];
  for (const candidate of candidates) {
    const words = extractSignificantWords(candidate);
    if (words.length > 0 && words.some((w) => normalized.includes(w))) return true;
  }
  return false;
}

export function loadCompanyIdentity(filePath: string): CompanyIdentity | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CompanyIdentity>;
    if (typeof parsed.name !== "string" || parsed.name.trim().length === 0) return null;
    return {
      name: parsed.name.trim(),
      aliases: Array.isArray(parsed.aliases) ? parsed.aliases.filter((a): a is string => typeof a === "string") : [],
    };
  } catch {
    return null;
  }
}

export function saveCompanyIdentity(filePath: string, identity: CompanyIdentity): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(identity, null, 2), "utf8");
}
```

- [ ] **Step 2: Write the test file**

```ts
import { describe, test, expect } from "bun:test";
import { extractSignificantWords, matchesCompany } from "./company-identity.ts";

describe("extractSignificantWords", () => {
  test("strips stopwords", () => {
    expect(extractSignificantWords("Helios Automotive AG")).toEqual(["helios", "automotive"]);
  });
  test("strips short words", () => {
    expect(extractSignificantWords("CO AG GmbH")).toEqual([]);
  });
  test("splits on hyphens", () => {
    expect(extractSignificantWords("Apex-Components GmbH")).toEqual(["apex", "components"]);
  });
  test("handles single-word company", () => {
    expect(extractSignificantWords("Siemens")).toEqual(["siemens"]);
  });
});

describe("matchesCompany", () => {
  const id: import("../profiles/types.ts").CompanyIdentity = {
    name: "Helios Automotive AG",
    aliases: ["HAG"],
  };

  test("matches primary name word in path segment", () => {
    expect(matchesCompany("Helios-Nova-BMS", id)).toBe(true);
  });
  test("matches alias (short, 3 chars — HAG)", () => {
    expect(matchesCompany("hag-internal-docs", id)).toBe(true);
  });
  test("no match for unrelated supplier", () => {
    expect(matchesCompany("Vertex Systems GmbH", id)).toBe(false);
  });
  test("no match for empty text", () => {
    expect(matchesCompany("", id)).toBe(false);
  });
  test("matches word in longer text", () => {
    expect(matchesCompany("This document is owned by Helios and confidential.", id)).toBe(true);
  });
});
```

- [ ] **Step 3: Run the tests**

Run: `bun test src/utils/company-identity.test.ts`
Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/utils/company-identity.ts src/utils/company-identity.test.ts
git commit -m "feat(utils): add company identity matching utility"
```

---

## Task 6: Update `src/server/setup-state.ts` for company identity

**Files:**
- Modify: `src/server/setup-state.ts`

- [ ] **Step 1: Add `companyIdentity` to `SetupState`**

In `src/server/setup-state.ts`, update the `SetupState` type and bump `schemaVersion` to `2`:

```ts
import type { CompanyIdentity } from "../profiles/types.ts";

export type SetupState = {
  schemaVersion: 2;
  installedChatModel: string | null;
  installedAt: string | null;
  fitReportAtInstall: {
    detected: DetectedHardware;
    candidates: RankedEntry[];
  } | null;
  companyIdentity: CompanyIdentity | null;
};

const CURRENT_SCHEMA_VERSION = 2;
```

- [ ] **Step 2: Update `loadSetupState` schema check**

The existing check `if (parsed.schemaVersion !== CURRENT_SCHEMA_VERSION)` will invalidate old v1 files — this is intentional, users will re-enter setup.

- [ ] **Step 3: Update `applySetupState`**

No change needed — `applySetupState` already writes the full state object.

- [ ] **Step 4: Update `autoRecoverIfPossible` to include `companyIdentity: null`**

In `autoRecoverIfPossible`, add `companyIdentity: null` to the `SetupState` literal:

```ts
const state: SetupState = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  installedChatModel: largest.id,
  installedAt: new Date().toISOString(),
  fitReportAtInstall: null,
  companyIdentity: null,
};
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: errors only in `routes.ts` where `SetupState` is used — will be fixed in Task 16.

- [ ] **Step 6: Commit**

```bash
git add src/server/setup-state.ts
git commit -m "feat(setup): add companyIdentity to SetupState (schema v2)"
```

---

## Task 7: Update `src/pipeline.ts` — profile injection

**Files:**
- Modify: `src/pipeline.ts`

- [ ] **Step 1: Add `sectorProfileId` to `ScanSettings`**

In the `ScanSettings` interface:

```ts
export interface ScanSettings {
  embedModel: string;
  chatModel: string;
  llmSampleRate: number;
  sectionEmbeddings: boolean;
  sectorProfileId: string;  // default: "automotive_de"
}
```

- [ ] **Step 2: Add imports and resolve profile + companyIdentity at scan start**

Add to imports at the top:

```ts
import { resolveProfile } from "./profiles/index.ts";
import { COMPANY_FILE_PATH, loadCompanyIdentity } from "./utils/company-identity.ts";
```

In `runPipeline`, after `process.env["SECTION_EMBEDDINGS"] = ...`, add:

```ts
  const profile = resolveProfile(settings.sectorProfileId);
  const companyIdentity = loadCompanyIdentity(COMPANY_FILE_PATH);
```

Replace the `createInitialState` call:

```ts
  const state = createInitialState(scanId, folder, profile, companyIdentity);
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: error in `routes.ts` (ScanSettings missing sectorProfileId) — fixed in Task 16.

- [ ] **Step 4: Commit**

```bash
git add src/pipeline.ts
git commit -m "feat(pipeline): inject sector profile and company identity at scan start"
```

---

## Task 8: Update `src/phases/1-harvest.ts` — documentOrigin via path

**Files:**
- Modify: `src/phases/1-harvest.ts`

- [ ] **Step 1: Import company matching**

Add import at top:

```ts
import { matchesCompany } from "../utils/company-identity.ts";
```

- [ ] **Step 2: Add documentOrigin to each `FileEntry` based on path**

In the `for (const relativePath of files)` loop, after `const segments = ...`, add before the `entry` construction:

```ts
    const documentOrigin: "internal" | "external" | undefined =
      state.companyIdentity
        ? matchesCompany(relativePath, state.companyIdentity) ? "internal" : "external"
        : undefined;
```

Add to the `entry` object (after `inferredDocumentCategory` line):

```ts
      ...(documentOrigin !== undefined ? { documentOrigin } : {}),
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors in this file.

- [ ] **Step 4: Commit**

```bash
git add src/phases/1-harvest.ts
git commit -m "feat(harvest): classify documentOrigin from path via company identity"
```

---

## Task 9: Update `src/phases/2-parse.ts` — documentOrigin via text

**Files:**
- Modify: `src/phases/2-parse.ts`

- [ ] **Step 1: Import company matching**

Add import:

```ts
import { matchesCompany } from "../utils/company-identity.ts";
```

- [ ] **Step 2: Add post-parse documentOrigin pass**

At the end of `runParse`, before the `logger.phaseEnd` call, add:

```ts
  if (state.companyIdentity) {
    for (const doc of state.parsed) {
      if (doc.documentOrigin !== undefined) continue;  // already set by harvest
      const sample = (doc.textContent ?? "").slice(0, 2000);
      if (sample.length === 0) continue;
      doc.documentOrigin = matchesCompany(sample, state.companyIdentity)
        ? "internal"
        : "external";
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add src/phases/2-parse.ts
git commit -m "feat(parse): refine documentOrigin via first-2000-char text match"
```

---

## Task 10: Update `src/phases/4-fingerprint.ts` — profile patterns + renamed fields

**Files:**
- Modify: `src/phases/4-fingerprint.ts`

- [ ] **Step 1: Update `computeRequirementDensity` signature to accept profile patterns**

Find `computeRequirementDensity` (currently at line ~116). Change its signature and body:

```ts
import { findAllMatches } from "../utils/regex-patterns.ts";
import type { SectorProfile } from "../profiles/types.ts";

function computeRequirementDensity(
  text: string,
  pages: number,
  profile: SectorProfile,
): RequirementDensityVector {
  const mandatoryCount  = findAllMatches(new RegExp(profile.requirementPatterns.MANDATORY.source,  "gi"), text).length;
  const recommendedCount = findAllMatches(new RegExp(profile.requirementPatterns.RECOMMENDED.source, "gi"), text).length;
  const permittedCount  = findAllMatches(new RegExp(profile.requirementPatterns.PERMITTED.source,   "gi"), text).length;
  const informativeCount = text.split(/[.!?]+/).filter((s) => s.trim().length > 5).length;  // sentence count as proxy

  const entityCount = profile.entityIdPatterns
    ? profile.entityIdPatterns.reduce((sum, { pattern }) =>
        sum + findAllMatches(new RegExp(pattern.source, "gi"), text).length, 0)
    : 0;

  const quantMatches = findAllMatches(PATTERNS.quantitativeValue, text);

  return {
    mandatoryPerPage:   mandatoryCount  / pages,
    recommendedPerPage: recommendedCount / pages,
    permittedPerPage:   permittedCount  / pages,
    informativePerPage: informativeCount / pages,
    quantitativeValuesPerPage: quantMatches.length / pages,
    entityRefPerPage:   entityCount / pages,
  };
}
```

- [ ] **Step 2: Update the call site**

Find where `computeRequirementDensity(doc.textContent ?? "", doc.pageCount ?? 1)` is called (line ~32). Change to:

```ts
const requirementDensity = computeRequirementDensity(
  doc.textContent ?? "",
  doc.pageCount ?? 1,
  state.sectorProfile,
);
```

- [ ] **Step 3: Update `zeroDensity()`**

```ts
function zeroDensity(): RequirementDensityVector {
  return {
    mandatoryPerPage: 0, recommendedPerPage: 0, permittedPerPage: 0,
    informativePerPage: 0, quantitativeValuesPerPage: 0, entityRefPerPage: 0,
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors in this file; `5-cluster.ts` still errors on renamed fields.

- [ ] **Step 5: Commit**

```bash
git add src/phases/4-fingerprint.ts
git commit -m "refactor(fingerprint): use profile patterns for requirement density, rename fields"
```

---

## Task 11: Update `src/phases/5-cluster.ts` — renamed density fields

**Files:**
- Modify: `src/phases/5-cluster.ts`

- [ ] **Step 1: Update density field references**

Find lines 120–121 in `5-cluster.ts`:
```ts
const densA = fpA.requirementDensity.mussPerPage + fpA.requirementDensity.sollPerPage;
const densB = fpB.requirementDensity.mussPerPage + fpB.requirementDensity.sollPerPage;
```

Replace with:
```ts
const densA = fpA.requirementDensity.mandatoryPerPage + fpA.requirementDensity.recommendedPerPage;
const densB = fpB.requirementDensity.mandatoryPerPage + fpB.requirementDensity.recommendedPerPage;
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors in phases 4 and 5.

- [ ] **Step 3: Commit**

```bash
git add src/phases/5-cluster.ts
git commit -m "refactor(cluster): update to renamed requirement density fields"
```

---

## Task 12: Update `src/phases/6-references.ts` — profile-driven norm extraction

**Files:**
- Modify: `src/phases/6-references.ts`

- [ ] **Step 1: Remove `AUTOMOTIVE_NORM_CANONICAL` constant and `staticNormLookup`**

Delete lines 13–82 (the `AUTOMOTIVE_NORM_CANONICAL` object and `staticNormLookup` function).

- [ ] **Step 2: Add profile-based static lookup**

Add a new `staticNormLookup` that uses the profile:

```ts
function staticNormLookup(rawNorm: string, profile: import("../profiles/types.ts").SectorProfile): string | undefined {
  const normalized = rawNorm.trim();
  if (profile.normCanonical[normalized]) return profile.normCanonical[normalized];
  for (const [key, canonical] of Object.entries(profile.normCanonical)) {
    if (normalized.toLowerCase().startsWith(key.toLowerCase())) return canonical;
  }
  return undefined;
}
```

- [ ] **Step 3: Update `normalizeLlm` to accept profile**

Change signature:
```ts
async function normalizeLlm(
  rawNorms: string[],
  ollamaAvailable: boolean,
  profile: import("../profiles/types.ts").SectorProfile,
): Promise<Map<string, NormEntry>> {
```

In Step 1 of normalizeLlm, replace `staticNormLookup(norm)` with `staticNormLookup(norm, profile)`.

- [ ] **Step 4: Update `extractRawRefs` to use profile norm pattern**

Change `extractRawRefs` to receive the profile and use its normPattern:

```ts
function extractRawRefs(
  text: string,
  profile: import("../profiles/types.ts").SectorProfile,
): RawRefExtractions {
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
```

- [ ] **Step 5: Update `pushRef` norm classification to use profile**

In `runReferences`, replace the five `pushRef("iso_norm", ...)` ... `pushRef("iatf_norm", ...)` calls with:

```ts
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
```

- [ ] **Step 6: Update call sites for `extractRawRefs` and `normalizeLlm`**

In `runReferences`:
```ts
const refs = extractRawRefs(text, state.sectorProfile);
// ...
const normMap = await normalizeLlm(allRawNorms, ollamaAvailable, state.sectorProfile);
```

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors in phase 6. Still errors in phase 7 and dashboard.

- [ ] **Step 8: Commit**

```bash
git add src/phases/6-references.ts
git commit -m "refactor(references): use profile normPattern, normCanonical, entityIdPatterns"
```

---

## Task 13: Update `src/phases/7-requirements.ts` — profile patterns + internal taxonomy

**Files:**
- Modify: `src/phases/7-requirements.ts`

- [ ] **Step 1: Update `classifyType` to use profile**

Replace the existing `classifyType` function (lines 11–22) with:

```ts
import type { ReqType } from "../profiles/types.ts";

function classifyType(text: string, profile: import("../profiles/types.ts").SectorProfile): ReqType {
  const reset = (re: RegExp) => { re.lastIndex = 0; };
  const { MANDATORY, RECOMMENDED, PERMITTED, DECLARATIVE } = profile.requirementPatterns;
  if (MANDATORY.test(text))   { reset(MANDATORY);   return "MANDATORY"; }
  reset(MANDATORY);
  if (RECOMMENDED.test(text)) { reset(RECOMMENDED); return "RECOMMENDED"; }
  reset(RECOMMENDED);
  if (PERMITTED.test(text))   { reset(PERMITTED);   return "PERMITTED"; }
  reset(PERMITTED);
  if (DECLARATIVE.test(text)) { reset(DECLARATIVE); return "DECLARATIVE"; }
  reset(DECLARATIVE);
  return "INFORMATIVE";
}
```

- [ ] **Step 2: Update `classifyCategory` to use English terms**

Replace the return values in `classifyCategory` (and the function signature):

```ts
function classifyCategory(
  text: string,
  profile: import("../profiles/types.ts").SectorProfile,
): import("../state.ts").ExtractedRequirement["category"] {
  const lower = text.toLowerCase();
  void lower;
  const safetyRe = profile.safetyKeywords;
  if (safetyRe.test(text)) { safetyRe.lastIndex = 0; return "Safety"; }
  safetyRe.lastIndex = 0;
  if (PATTERNS.materialKeywords.test(text))   { PATTERNS.materialKeywords.lastIndex = 0;   return "Material"; }
  if (PATTERNS.toleranceKeywords.test(text))  { PATTERNS.toleranceKeywords.lastIndex = 0;  return "Tolerance"; }
  if (PATTERNS.testingKeywords.test(text))    { PATTERNS.testingKeywords.lastIndex = 0;    return "Testing"; }
  if (PATTERNS.packagingKeywords.test(text))  { PATTERNS.packagingKeywords.lastIndex = 0;  return "Packaging"; }
  const delivRe = profile.deliveryKeywords;
  if (delivRe && delivRe.test(text)) { delivRe.lastIndex = 0; return "Delivery"; }
  return "Other";
}
```

- [ ] **Step 3: Update `isSafetyRelevant` to use profile**

```ts
function isSafetyRelevant(text: string, profile: import("../profiles/types.ts").SectorProfile): boolean {
  const result = profile.safetyKeywords.test(text);
  profile.safetyKeywords.lastIndex = 0;
  return result;
}
```

- [ ] **Step 4: Update `extractLinkedFikb` to use `entityIdPatterns`**

Rename function and use profile:

```ts
function extractLinkedEntityRef(
  text: string,
  profile: import("../profiles/types.ts").SectorProfile,
): string | undefined {
  if (!profile.entityIdPatterns || profile.entityIdPatterns.length === 0) return undefined;
  for (const { pattern } of profile.entityIdPatterns) {
    const pat = new RegExp(pattern.source, "gi");
    const matches = findAllMatches(pat, text);
    if (matches.length > 0) return matches[0]!.slice(0, 30);
  }
  return undefined;
}
```

- [ ] **Step 5: Update all call sites to pass `state.sectorProfile`**

Find all calls to `classifyType(sentence)`, `classifyCategory(sentence)`, `isSafetyRelevant(sentence)`, `extractLinkedFikb(sentence)` in the phase and add `state.sectorProfile` as the second argument. Also rename `extractLinkedFikb` to `extractLinkedEntityRef`.

- [ ] **Step 6: Update the pushed requirement object**

Find where `ExtractedRequirement` objects are pushed (look for `state.requirements.push({`). Update:
- `type: classifyType(...)` → already returns new type
- `category: classifyCategory(...)` → already returns English
- `linkedFikb:` → rename to `linkedEntityRef:`
- `source` field: keep as-is

- [ ] **Step 7: Update LLM-recovered requirements**

In the LLM recovery path (if present), ensure `type` values emitted by the LLM are mapped to the internal taxonomy. Look for any hardcoded `"MUSS"`, `"SOLL"`, `"KANN"`, etc. and replace with `"MANDATORY"`, `"RECOMMENDED"`, `"PERMITTED"`.

- [ ] **Step 8: Update negation filter for generic profile**

The negation filter at line ~74 (`nicht muss`, `muss nicht`, etc.) is German-specific. Wrap it to only apply when profile is `german_modal`:

```ts
if (profile.requirementLanguageFamily === "german_modal") {
  const negated = /nicht\s+muss|muss\s+nicht|nicht\s+soll|soll\s+nicht/i.test(sentence);
  if (negated) return { confirmed: false, negated: true, uncertain: false };
}
```

- [ ] **Step 9: Typecheck**

Run: `bun run typecheck`
Expected: errors remain only in dashboard, 9-html, 9-report.

- [ ] **Step 10: Commit**

```bash
git add src/phases/7-requirements.ts
git commit -m "refactor(requirements): use profile patterns, output internal taxonomy MANDATORY/RECOMMENDED/PERMITTED"
```

---

## Task 14: Update `src/phases/9-report.ts` + `src/phases/9-html.ts`

**Files:**
- Modify: `src/phases/9-report.ts`
- Modify: `src/phases/9-html.ts`
- Modify: `src/phases/9-narrative.ts` (add sector label to LLM context)

- [ ] **Step 1: Update hardcoded "MUSS/SOLL/KANN" strings in `9-report.ts`**

Find all occurrences of `"MUSS/SOLL/KANN"` in `9-report.ts` (lines 337, 447, 681). Replace:

Line 337:
```ts
`Use MANDATORY/RECOMMENDED/PERMITTED as retrieval filter for ${reliableDocs} reliable doc types. Exclude planning/meeting/tracker docs from metadata filtering.`
```

Line 447:
```ts
`> ⚠️ **${unreliableReqDocs.length} document(s)** have requirement-type keywords but are NOT reliable for requirement metadata (wrong doc type). Do not use MANDATORY/RECOMMENDED as retrieval filter for: ${shownUnreliable.join(", ")}${moreUnreliable}`
```

Line 681:
```ts
const reqMeta = reqReliable > 0 ? "✅ Use MANDATORY/RECOMMENDED as retrieval filter" : "❌ Do not use requirement type as filter";
```

- [ ] **Step 2: Add profile label to scan metadata in `9-report.ts`**

Find where scan metadata is written to the report (look for `scanId`, `startedAt`). Add:
```ts
push(`- **Sector Profile:** ${state.sectorProfile.label}`);
```

- [ ] **Step 2b: Pass sector label to narrative prompt in `9-narrative.ts`**

In `src/phases/9-narrative.ts`, find where the LLM prompt is constructed (look for the prompt template string). Add the sector label as context at the top of the prompt or in the system context. For example, find the prompt construction and prepend:

```ts
const sectorCtx = `Sector: ${state.sectorProfile.label}.\n`;
// Then prepend sectorCtx to the existing prompt string
```

- [ ] **Step 3: Update `TYPE_COLOR` in `9-html.ts`**

Find line ~720 in `9-html.ts`:
```ts
function TYPE_COLOR(t) { return { MUSS: '#d32f2f', KANN: '#1e88e5', SOLL: '#ff6b35', DEKLARATIV: '#43a047' }[t] || '#607d8b'; }
```
Replace with:
```ts
function TYPE_COLOR(t) { return { MANDATORY: '#d32f2f', RECOMMENDED: '#ff6b35', PERMITTED: '#1e88e5', DECLARATIVE: '#43a047' }[t] || '#607d8b'; }
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: errors remain in dashboard components.

- [ ] **Step 5: Commit**

```bash
git add src/phases/9-report.ts src/phases/9-html.ts
git commit -m "refactor(report): internal taxonomy labels, add sector profile to scan metadata"
```

---

## Task 15: Update dashboard — internal taxonomy labels

**Files:**
- Modify: `src/dashboard/components/requirements-landscape.ts`
- Modify: `src/dashboard/lib/report-types.ts`
- Modify: `src/dashboard/_fixtures/sample-reports.ts`
- Modify: `src/dashboard/html-template.ts`

- [ ] **Step 1: Update `report-types.ts` type union**

In `src/dashboard/lib/report-types.ts` line 76, replace:
```ts
type: 'MANDATORY' | 'RECOMMENDED' | 'PERMITTED' | 'INFORMATIVE' | 'DECLARATIVE';
```

- [ ] **Step 2: Update `requirements-landscape.ts` color map**

In `src/dashboard/components/requirements-landscape.ts` line 24:
```ts
const TYPE_COLORS: Record<string, string> = {
  MANDATORY: '#d32f2f', RECOMMENDED: '#ff6b35', PERMITTED: '#1e88e5',
  DECLARATIVE: '#43a047', INFORMATIVE: '#607d8b',
};
```

Line 139, find the inline `TYPE_COLORS` JS string in the template and apply the same mapping:
```ts
var TYPE_COLORS = {MANDATORY:'#d32f2f',RECOMMENDED:'#ff6b35',PERMITTED:'#1e88e5',DECLARATIVE:'#43a047',INFORMATIVE:'#607d8b'};
```

- [ ] **Step 3: Update sample fixtures**

In `src/dashboard/_fixtures/sample-reports.ts`, update `type` values:
- `'MUSS'` → `'MANDATORY'`
- `'SOLL'` → `'RECOMMENDED'`
- `'KANN'` → `'PERMITTED'`
- `'DEKLARATIV'` → `'DECLARATIVE'`
- `'INFORMATIV'` → `'INFORMATIVE'`

Also update `category` values to English where they appear (e.g. `'Prüfung'` → `'Testing'`, `'Dokumentation'` → `'Other'`, `'Referenz'` → `'Other'`).

- [ ] **Step 4: Update `html-template.ts` color map**

Find line ~1464:
```ts
var TC={'MUSS':'#d32f2f','SOLL':'#ff6b35','KANN':'#1e88e5','DEKLARATIV':'#43a047','INFORMATIV':'#607d8b'};
```
Replace with:
```ts
var TC={'MANDATORY':'#d32f2f','RECOMMENDED':'#ff6b35','PERMITTED':'#1e88e5','DECLARATIVE':'#43a047','INFORMATIVE':'#607d8b'};
```

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors across all files.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/requirements-landscape.ts src/dashboard/lib/report-types.ts src/dashboard/_fixtures/sample-reports.ts src/dashboard/html-template.ts
git commit -m "refactor(dashboard): update requirement type labels to internal taxonomy"
```

---

## Task 16: Update `src/server/routes.ts` — company identity API + sectorProfileId

**Files:**
- Modify: `src/server/routes.ts`

- [ ] **Step 1: Add imports**

```ts
import { COMPANY_FILE_PATH, loadCompanyIdentity, saveCompanyIdentity } from "../utils/company-identity.ts";
import type { CompanyIdentity } from "../profiles/types.ts";
import { PROFILES } from "../profiles/index.ts";
```

- [ ] **Step 2: Add `sectorProfileId` to the scan handler's settings resolution**

Find the `handleScan` section (around line 86–90). Add:

```ts
    sectorProfileId: body.settings?.sectorProfileId ?? "automotive_de",
```

- [ ] **Step 3: Fix `SetupState` usage** 

Any places that read `setupHolder.current` may now need to handle the new `companyIdentity` field — add `companyIdentity: null` where a `SetupState` is constructed inline.

- [ ] **Step 4: Add `GET /api/company` handler**

```ts
function handleGetCompany(): Response {
  const identity = loadCompanyIdentity(COMPANY_FILE_PATH);
  return json(identity ?? { name: "", aliases: [] });
}
```

- [ ] **Step 5: Add `POST /api/company` handler**

```ts
async function handleSaveCompany(req: Request): Promise<Response> {
  let body: Partial<CompanyIdentity>;
  try { body = await req.json() as Partial<CompanyIdentity>; } catch { return json({ error: "Invalid JSON" }, 400); }
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return json({ error: "name is required" }, 400);
  }
  const identity: CompanyIdentity = {
    name: body.name.trim().slice(0, 120),
    aliases: Array.isArray(body.aliases)
      ? body.aliases.filter((a): a is string => typeof a === "string").map((a) => a.trim().slice(0, 80)).slice(0, 10)
      : [],
  };
  saveCompanyIdentity(COMPANY_FILE_PATH, identity);
  if (setupHolder.current) {
    setupHolder.current = { ...setupHolder.current, companyIdentity: identity };
  }
  return json({ ok: true });
}
```

- [ ] **Step 6: Add `GET /api/profiles` handler**

```ts
function handleGetProfiles(): Response {
  return json(PROFILES.map((p) => ({ id: p.id, label: p.label, description: p.description })));
}
```

- [ ] **Step 7: Register the new routes**

In the route dispatcher, add:

```ts
if (path === "/api/company" && req.method === "GET") return handleGetCompany();
if (path === "/api/company" && req.method === "POST") return handleSaveCompany(req);
if (path === "/api/profiles" && req.method === "GET") return handleGetProfiles();
```

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add src/server/routes.ts
git commit -m "feat(api): add /api/company and /api/profiles endpoints; pass sectorProfileId to scan"
```

---

## Task 17: Update `src/ui/index.html` — sector dropdown + company name in wizard

**Files:**
- Modify: `src/ui/index.html`

- [ ] **Step 1: Add sector profile dropdown to scan settings panel**

Find the scan settings section in the HTML (look for `sample-rate` or `section-embeddings`). Add a new field before the existing ones:

```html
<div class="field">
  <label for="sector-profile">Sector Profile</label>
  <select class="select-field" id="sector-profile"></select>
  <div class="field-hint">Document domain — determines norm patterns and requirement language.</div>
</div>
```

- [ ] **Step 2: Populate the sector dropdown on page load**

In the JS section, add a function that calls `GET /api/profiles` and populates `#sector-profile`:

```js
async function loadProfiles() {
  try {
    const r = await fetch('/api/profiles');
    const profiles = await r.json();
    const sel = document.getElementById('sector-profile');
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.label;
      opt.title = p.description;
      sel.appendChild(opt);
    }
    sel.value = 'automotive_de';
  } catch (e) {
    console.warn('Could not load profiles', e);
  }
}
```

Call `loadProfiles()` in the page initialization (alongside existing init calls).

- [ ] **Step 3: Include `sectorProfileId` in the scan request body**

Find the scan start handler (around line 1153). Update the `settings` object:

```js
const settings = {
  llmSampleRate: parseFloat(document.getElementById('sample-rate').value),
  sectionEmbeddings: document.getElementById('section-embeddings').value === 'true',
  sectorProfileId: document.getElementById('sector-profile').value || 'automotive_de',
};
```

- [ ] **Step 4: Add company name step to the setup wizard**

Find the wizard HTML (`#screen-wizard`). After the model download completes (find `btn-wizard-install` click handler), add a "Your Company" step shown before marking setup complete:

In HTML, add a company step div inside `#screen-wizard`:

```html
<div id="wizard-company-step" style="display:none;margin-top:1rem;">
  <div style="font-family:var(--font-heading);font-size:1.125rem;font-weight:600;margin-bottom:.5rem;">Your Company Name</div>
  <div class="field-hint" style="margin-bottom:.75rem;">Used to classify documents as internal or external. Can be updated later in settings.</div>
  <input type="text" class="path-input" id="wizard-company-name" placeholder="e.g. Helios Automotive AG" style="width:100%;margin-bottom:.5rem;">
  <div class="field-hint" id="wizard-company-hint" style="margin-bottom:.75rem;">Optional aliases (comma-separated): e.g. Helios, HAG</div>
  <input type="text" class="path-input" id="wizard-company-aliases" placeholder="optional aliases" style="width:100%;margin-bottom:1rem;">
  <button class="btn-primary" id="btn-wizard-company-save">Save and continue</button>
  <button class="btn-secondary" id="btn-wizard-company-skip" style="margin-left:.5rem;">Skip for now</button>
</div>
```

- [ ] **Step 5: Wire the company step JS**

After model install completes (find where the wizard progress ends and setup is marked done), show `#wizard-company-step` instead of immediately completing. Add handlers:

```js
// After model install success:
document.getElementById('wizard-company-step').style.display = 'block';
document.getElementById('wizard-progress').style.display = 'none';

async function saveWizardCompany() {
  const name = document.getElementById('wizard-company-name').value.trim();
  const aliasRaw = document.getElementById('wizard-company-aliases').value.trim();
  const aliases = aliasRaw ? aliasRaw.split(',').map(a => a.trim()).filter(Boolean) : [];
  if (name) {
    try {
      await fetch('/api/company', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name, aliases}),
      });
    } catch { /* non-fatal */ }
  }
  completeWizardSetup();  // existing function that transitions to the main screen
}

document.getElementById('btn-wizard-company-save').addEventListener('click', saveWizardCompany);
document.getElementById('btn-wizard-company-skip').addEventListener('click', completeWizardSetup);
```

- [ ] **Step 6: Run the app and verify**

Start the server: `bun run src/server/index.ts` (or via Docker). Open `http://localhost:3000`. Verify:
- Sector Profile dropdown appears in scan settings, populated with "Automotive (DE)"
- In the setup wizard (after model install), the company name step appears
- Saving a company name persists to `company.json`

- [ ] **Step 7: Typecheck**

Run: `bun run typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/ui/index.html
git commit -m "feat(ui): add sector profile dropdown and company name wizard step"
```

---

## Task 18: End-to-end smoke test

- [ ] **Step 1: Run all tests**

```bash
bun test
```
Expected: all tests pass.

- [ ] **Step 2: Run the scanner against test corpus**

```bash
DOCUMENTS_ROOT=./_test-docs REPORT_OUTPUT=./reports TIKA_URL=http://localhost:19998 OLLAMA_URL=http://localhost:11435 bun run src/index.ts
```
Expected: scanner runs to completion, report written to `./reports/`. Requirement types in JSON report show `MANDATORY`/`RECOMMENDED`/`PERMITTED`.

- [ ] **Step 3: Verify report JSON**

```bash
cat reports/scan-report-*.json | bun -e "const d=JSON.parse(await Bun.stdin.text()); console.log('Profile:', d.sectorProfile?.label ?? d.scanId); const types=[...new Set(d.requirements.map(r=>r.type))]; console.log('Req types:', types);"
```
Expected output: `Profile: Automotive (DE)` and types array contains only internal taxonomy values.

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "test: verify sector profiles end-to-end with test corpus"
```
