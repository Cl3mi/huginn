# Sector Profiles & Company Identity — Design Spec
Date: 2026-05-23

## Goal

Make Huginn usable across sectors (pharma, legal, logistics, IT/software, etc.) without hardcoding automotive-German assumptions into the pipeline. A TypeScript profile file per sector provides domain-specific patterns; a company identity setup step enables internal/external document classification.

## Internal Requirement Taxonomy

All phases use a fixed internal taxonomy regardless of sector:

| Internal type | Meaning |
|---|---|
| `MANDATORY` | Shall/must be done — no discretion |
| `RECOMMENDED` | Should be done — strong preference |
| `PERMITTED` | May be done — optional |
| `DECLARATIVE` | States a fact or definition — not a requirement |
| `INFORMATIVE` | Context/background — no obligation |

Sector profiles map their domain-specific language onto these types. Reports and dashboards always display the internal labels.

## Profile System

### Interface (`src/profiles/types.ts`)

```ts
export interface SectorProfile {
  id: string;                          // stable key stored in scan config
  label: string;                       // shown in UI dropdown
  description: string;                 // one-line UI tooltip

  requirementLanguageFamily: RequirementLanguageFamily;
  unitFamily: UnitFamily;

  requirementPatterns: {
    MANDATORY:   RegExp;
    RECOMMENDED: RegExp;
    PERMITTED:   RegExp;
    DECLARATIVE: RegExp;
    // sentences matching none of the above → INFORMATIVE
  };

  normPattern:     RegExp;             // matches standard/norm references in text
  knownNorms:      string[];           // static list for Phase 6 fuzzy lookup
  safetyKeywords:  RegExp;             // triggers safety flag on a requirement
  deliveryKeywords?: RegExp;           // optional Phase 6 context enrichment
}
```

### File structure

```
src/profiles/
├── types.ts           ← SectorProfile interface + CompanyIdentity interface
├── automotive.ts      ← built-in profile; wraps all current hardcoded patterns
└── index.ts           ← barrel: export const PROFILES: SectorProfile[]
```

Adding a sector = create `src/profiles/<sector>.ts` + add one line to `index.ts`. No other files touched.

### `automotive.ts` migration

All sector-specific content currently in `src/utils/regex-patterns.ts` (norm regex, MUSS/SOLL/KANN patterns, safety/delivery keywords, known norms list) and `src/config.ts` (`oemPatterns`) moves into `automotive.ts`. `regex-patterns.ts` retains only structural/generic patterns (heading detection, date formats, MinHash helpers, sentence splitting). `config.ts` `oemPatterns` field is removed.

## Company Identity

### Data shape (`src/profiles/types.ts`)

```ts
export interface CompanyIdentity {
  name: string;      // "Helios Automotive AG" — user-entered in setup wizard
  aliases: string[]; // optional additional names ("Helios", "HAG")
}
```

### Persistence

Stored as `REPORT_OUTPUT/company.json` — outside version control, per deployment. Written once during setup wizard; readable by the scanner at startup.

### Setup wizard extension

The existing first-boot model setup wizard gains a "Your Company" step (required, before scanning is allowed). Free-text field for company name + optional aliases. Stored to `company.json` on save.

## Internal/External Classification

Performed in two steps:
- **Phase 1 (harvest):** trigram-match company identity against the file path (top-level segment = current `customer` field). Fast, no text needed.
- **Phase 2 (parse) — post-parse pass:** for documents not yet classified, trigram-match against first 2000 chars of parsed text. Overwrites `"unknown"` set in Phase 1.

**Algorithm:**
1. Build a trigram set from `companyIdentity.name` and each alias.
2. Compute trigram similarity against the candidate string.
3. If similarity ≥ 0.6 → `documentOrigin: "internal"`; else `"external"`. If text unavailable after Phase 2 → `"unknown"` remains.

**Result field** added to `HarvestedFile`:
```ts
documentOrigin: "internal" | "external" | "unknown";
```

**Downstream uses:**
- Phase 6: entity-ID extraction applied to `external` documents
- Phase 9 report: metadata includes internal/external counts
- Phase 9 narrative: LLM prompt receives "X documents from external parties"
- Dashboard document-distribution section: internal vs. external split

## Pipeline Integration

`SectorProfile` and `CompanyIdentity` are resolved once at scan start in `pipeline.ts` and stored on `ScannerState`:

```ts
// state.ts additions
sectorProfile: SectorProfile;
companyIdentity: CompanyIdentity;
```

### Per-phase changes

| Phase | Change |
|---|---|
| **1 — harvest** | Trigram-match company identity against file path → set initial `documentOrigin` on each `HarvestedFile` |
| **2 — parse** | Post-parse pass: trigram-match against first 2000 chars of text for documents still `"unknown"` |
| **3 — projection** | Use `sectorProfile.requirementLanguageFamily` + `.unitFamily` as `DomainHints` instead of re-detecting |
| **6 — references** | Replace hardcoded norm regex + known norms + OEM patterns with `sectorProfile.normPattern` + `.knownNorms` |
| **7 — requirements** | Replace hardcoded MUSS/SOLL/KANN regex with `sectorProfile.requirementPatterns`; output uses internal taxonomy type names |
| **8 — validate** | Consistency check labels use internal taxonomy terms |
| **9 — report/narrative** | Profile `label` in scan metadata; narrative prompt receives sector label |

**No phases added or removed.** The pipeline shape is unchanged — profiles are pure data injected at startup.

## UI Changes

**Scan settings panel** gets a "Sector Profile" dropdown, populated from `PROFILES` barrel export. Default: `automotive_de`. Selected profile `id` stored in scan config alongside model names.

**Setup wizard** gains a "Your Company" step between model selection and completion.

## What Does Not Change

- Pipeline phase count and order
- `ScannerState` field names for existing phases (only additions)
- `regex-patterns.ts` structural/generic patterns
- Dashboard component structure (internal/external split is additive to document-distribution)
- Docker Compose setup, Tika/Ollama integration

## Out of Scope

- UI for creating/editing profiles (profiles are code files)
- Profile versioning or migration
- Per-client profile overrides (one profile per scan, selected in UI)
- Dashboard theme or label changes beyond taxonomy renaming
