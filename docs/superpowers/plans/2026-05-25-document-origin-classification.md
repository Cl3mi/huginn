# Document Origin Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-word-match origin heuristic with a multi-signal, evidence-accumulating classifier that produces `internal | external | unknown` with a full audit trail per document.

**Architecture:** A pure classifier utility (`src/utils/origin-classifier.ts`) collects typed signals from path fields, DOCX/PDF metadata, text content, and doc type — then scores and thresholds them. Phase 2 consolidates all signals and writes `originClassification` + `documentOrigin` on every parsed doc. Phase 8 validate adds a coverage check; Phase 9 report surfaces counts in JSON and human.md.

**Tech Stack:** Bun + TypeScript strict mode (`exactOptionalPropertyTypes: true`). Tests via `bun test`. No new dependencies.

---

## File Map

| Action | File | Responsibility |
|---|---|---|
| Modify | `src/state.ts` | Add `OriginSignal`, `OriginClassification` interfaces; widen `documentOrigin`; add `originClassification?` and `pdfAuthorHint?` to `ParsedDocument` |
| Create | `src/utils/origin-classifier.ts` | Pure functions: `collectOriginSignals`, `classifyOrigin`; `DocxAuthorMeta` interface |
| Create | `src/utils/origin-classifier.test.ts` | Bun unit tests for classifier logic |
| Modify | `src/phases/1-harvest.ts` | Remove `matchesCompany` call and `documentOrigin` assignment |
| Modify | `src/phases/2-parse.ts` | Add `extractDocxAuthorMeta`; capture PDF author hint from Tika; replace lines 542–551 with classifier loop |
| Modify | `src/phases/8-validate.ts` | Add `ORIGIN_CLASSIFICATION_COVERAGE` consistency check |
| Modify | `src/phases/9-report.ts` | Add `documentOrigin` + `originClassification` to parsed map; add `originSummary` top-level; add human.md section |
| Modify | `src/dashboard/components/document-distribution.ts` | Add origin donut chart + unknown docs list |

---

## Task 1: Add types to `src/state.ts`

**Files:**
- Modify: `src/state.ts`

- [ ] **Step 1: Add `OriginSignal` and `OriginClassification` interfaces**

In `src/state.ts`, insert after the existing imports and before `export interface FileEntry`:

```typescript
export interface OriginSignal {
  signal: string;                          // e.g. "path_segment_match"
  direction: "internal" | "external";
  weight: number;
}

export interface OriginClassification {
  result: "internal" | "external" | "unknown";
  internalScore: number;
  externalScore: number;
  confidence: "high" | "medium" | "low" | "none";
  signals: OriginSignal[];
}
```

- [ ] **Step 2: Widen `documentOrigin` on `FileEntry`**

Find the line in `FileEntry`:
```typescript
  documentOrigin?: "internal" | "external";   // set by Phase 1/2 via company identity matching
```

Replace with:
```typescript
  documentOrigin?: "internal" | "external" | "unknown";   // set by Phase 2 classifier
```

- [ ] **Step 3: Add `pdfAuthorHint?` and `originClassification?` to `ParsedDocument`**

Find the comment block `// Runtime cache — set in Phase 2...` in `ParsedDocument` (near the `textContent?` field). Add two new fields immediately after it:

```typescript
  // Runtime hint — set in Phase 2 from Tika PDF metadata. NEVER serialized to JSON.
  pdfAuthorHint?: string;
  // Classification result — set by Phase 2 classifier. Serialized to JSON.
  originClassification?: OriginClassification;
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

Expected: no errors. If errors, fix before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts
git commit -m "feat(types): add OriginSignal, OriginClassification; widen documentOrigin"
```

---

## Task 2: Create `src/utils/origin-classifier.ts` with TDD

**Files:**
- Create: `src/utils/origin-classifier.ts`
- Create: `src/utils/origin-classifier.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/utils/origin-classifier.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import {
  collectOriginSignals,
  classifyOrigin,
  type DocxAuthorMeta,
} from "./origin-classifier.ts";
import type { ParsedDocument } from "../state.ts";

// Minimal ParsedDocument stub — only the fields the classifier reads.
// Uses Object.assign to avoid exactOptionalPropertyTypes conflicts when spreading Partial<>.
function makeDoc(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  const base = {
    id: "doc-001",
    path: "Docs/Report.docx",
    absolutePath: "/docs/Report.docx",
    filename: "Report.docx",
    extension: ".docx",
    sizeBytes: 1000,
    sha256: "abc",
    modifiedAt: new Date(),
    createdAt: new Date(),
    depth: 1,
    pathSegments: ["Docs", "Report.docx"],
    charCount: 500,
    tokenCountEstimate: 100,
    language: "de",
    headings: [],
    hasNumberedHeadings: false,
    tableCount: 0,
    parserUsed: "officeparser" as const,
    isScannedPdf: false,
    isOcrRequired: false,
    parseSuccess: true,
    dateSignals: {
      mtime: "2024-01-01",
      ctime: "2024-01-01",
      mtimeReliable: true,
      bestDate: "2024-01-01",
    },
    recommendedChunkStrategy: "heading_sections" as const,
    chunkStrategyReasoning: {
      recommended: "heading_sections" as const,
      confidence: 0.8,
      signals: {
        headingCount: 5,
        headingDepth: 2,
        avgTokensPerSection: 200,
        tableCount: 0,
        hasNestedHeadings: false,
        isXlsx: false,
        pdfClassification: "not_pdf",
      },
    },
    requirementMetadataReliable: true,
  };
  return Object.assign(base, overrides) as ParsedDocument;
}

const identity = { name: "Vertex Systems GmbH", aliases: ["Vertex", "VSG"] };

describe("classifyOrigin — thresholds", () => {
  test("no signals → unknown / none", () => {
    const result = classifyOrigin([]);
    expect(result.result).toBe("unknown");
    expect(result.confidence).toBe("none");
    expect(result.internalScore).toBe(0);
    expect(result.externalScore).toBe(0);
  });

  test("single content_match_weak (+1) → unknown (below threshold 4)", () => {
    const result = classifyOrigin([
      { signal: "content_match_weak", direction: "internal", weight: 1 },
    ]);
    expect(result.result).toBe("unknown");
  });

  test("doctype_internal (+2) alone → unknown (below threshold 4)", () => {
    const result = classifyOrigin([
      { signal: "doctype_internal", direction: "internal", weight: 2 },
    ]);
    expect(result.result).toBe("unknown");
  });

  test("path_segment_match (+4) alone → internal", () => {
    const result = classifyOrigin([
      { signal: "path_segment_match", direction: "internal", weight: 4 },
    ]);
    expect(result.result).toBe("internal");
  });

  test("oem_folder_detected (+3) alone → external", () => {
    const result = classifyOrigin([
      { signal: "oem_folder_detected", direction: "external", weight: 3 },
    ]);
    expect(result.result).toBe("external");
  });

  test("metadata_author_match (+5) alone → internal", () => {
    const result = classifyOrigin([
      { signal: "metadata_author_match", direction: "internal", weight: 5 },
    ]);
    expect(result.result).toBe("internal");
  });

  test("content_match_strong (+3) + doctype_internal (+2) = 5 → internal", () => {
    const result = classifyOrigin([
      { signal: "content_match_strong", direction: "internal", weight: 3 },
      { signal: "doctype_internal", direction: "internal", weight: 2 },
    ]);
    expect(result.result).toBe("internal");
    expect(result.internalScore).toBe(5);
  });

  test("oem_folder (+3) + doctype_external_strong (+3) = 6 → external", () => {
    const result = classifyOrigin([
      { signal: "oem_folder_detected", direction: "external", weight: 3 },
      { signal: "doctype_external_strong", direction: "external", weight: 3 },
    ]);
    expect(result.result).toBe("external");
    expect(result.externalScore).toBe(6);
  });

  test("tie: internal 4 vs external 4 → unknown", () => {
    const result = classifyOrigin([
      { signal: "path_segment_match", direction: "internal", weight: 4 },
      { signal: "oem_folder_detected", direction: "external", weight: 3 },
      { signal: "doctype_external_weak", direction: "external", weight: 1 },
    ]);
    expect(result.result).toBe("unknown");
  });

  test("higher internal wins over lower external", () => {
    const result = classifyOrigin([
      { signal: "metadata_author_match", direction: "internal", weight: 5 },
      { signal: "oem_folder_detected", direction: "external", weight: 3 },
    ]);
    expect(result.result).toBe("internal");
  });
});

describe("classifyOrigin — confidence", () => {
  test("unknown → none", () => {
    expect(classifyOrigin([]).confidence).toBe("none");
  });

  test("path_segment_match (+4) alone → low (score 4, gap 4 < 6, score < 5)", () => {
    const r = classifyOrigin([{ signal: "path_segment_match", direction: "internal", weight: 4 }]);
    expect(r.confidence).toBe("low");
  });

  test("metadata_author_match (+5) + path_segment_match (+4) = 9 → high", () => {
    const r = classifyOrigin([
      { signal: "metadata_author_match", direction: "internal", weight: 5 },
      { signal: "path_segment_match", direction: "internal", weight: 4 },
    ]);
    expect(r.confidence).toBe("high");
    expect(r.internalScore).toBe(9);
  });

  test("content_match_strong (+3) + doctype_internal (+2) = 5 → medium", () => {
    const r = classifyOrigin([
      { signal: "content_match_strong", direction: "internal", weight: 3 },
      { signal: "doctype_internal", direction: "internal", weight: 2 },
    ]);
    expect(r.confidence).toBe("medium");
  });
});

describe("collectOriginSignals — path", () => {
  test("no company identity match in path → no path signal", () => {
    const doc = makeDoc({ pathSegments: ["Mercedes", "Docs", "Report.docx"] });
    const signals = collectOriginSignals(doc, identity);
    expect(signals.some(s => s.signal === "path_segment_match")).toBe(false);
  });

  test("segment matches company significant word → path_segment_match", () => {
    const doc = makeDoc({ pathSegments: ["vertex", "Docs", "Report.docx"] });
    const signals = collectOriginSignals(doc, identity);
    const match = signals.find(s => s.signal === "path_segment_match");
    expect(match).toBeDefined();
    expect(match?.direction).toBe("internal");
    expect(match?.weight).toBe(4);
  });

  test("alias significant word in segment → path_segment_match", () => {
    const doc = makeDoc({ pathSegments: ["VSG", "Reports", "file.docx"] });
    const signals = collectOriginSignals(doc, identity);
    expect(signals.some(s => s.signal === "path_segment_match")).toBe(true);
  });
});

describe("collectOriginSignals — content", () => {
  test("0 mentions → no content signal", () => {
    const doc = makeDoc({ textContent: "Some unrelated text without the company." });
    const signals = collectOriginSignals(doc, identity);
    expect(signals.some(s => s.signal.startsWith("content_match"))).toBe(false);
  });

  test("1 mention → content_match_weak", () => {
    const doc = makeDoc({ textContent: "Document prepared by Vertex Systems." });
    const signals = collectOriginSignals(doc, identity);
    const match = signals.find(s => s.signal === "content_match_weak");
    expect(match).toBeDefined();
    expect(match?.weight).toBe(1);
  });

  test("3+ mentions → content_match_strong (not weak)", () => {
    const doc = makeDoc({
      textContent: "Vertex Vertex Vertex authored this document.",
    });
    const signals = collectOriginSignals(doc, identity);
    expect(signals.some(s => s.signal === "content_match_strong")).toBe(true);
    expect(signals.some(s => s.signal === "content_match_weak")).toBe(false);
  });
});

describe("collectOriginSignals — metadata", () => {
  test("DOCX creator matches identity → metadata_author_match", () => {
    const doc = makeDoc();
    const meta: DocxAuthorMeta = { creator: "Vertex Systems Engineer" };
    const signals = collectOriginSignals(doc, identity, meta);
    expect(signals.some(s => s.signal === "metadata_author_match")).toBe(true);
  });

  test("DOCX company field matches → metadata_company_match", () => {
    const doc = makeDoc();
    const meta: DocxAuthorMeta = { company: "Vertex Systems GmbH" };
    const signals = collectOriginSignals(doc, identity, meta);
    expect(signals.some(s => s.signal === "metadata_company_match")).toBe(true);
  });

  test("PDF author matches → metadata_author_match", () => {
    const doc = makeDoc();
    const signals = collectOriginSignals(doc, identity, undefined, "Vertex Systems");
    expect(signals.some(s => s.signal === "metadata_author_match")).toBe(true);
  });

  test("unrelated author → no metadata signal", () => {
    const doc = makeDoc();
    const meta: DocxAuthorMeta = { creator: "Mercedes-Benz AG" };
    const signals = collectOriginSignals(doc, identity, meta);
    expect(signals.some(s => s.signal.startsWith("metadata_"))).toBe(false);
  });
});

describe("collectOriginSignals — structural", () => {
  test("inferredCustomer set → oem_folder_detected", () => {
    const doc = makeDoc({ inferredCustomer: "BMW" });
    const signals = collectOriginSignals(doc, identity);
    expect(signals.some(s => s.signal === "oem_folder_detected")).toBe(true);
  });

  test("rfq doc category → doc_category_rfq", () => {
    const doc = makeDoc({ inferredDocumentCategory: "rfq" });
    const signals = collectOriginSignals(doc, identity);
    expect(signals.some(s => s.signal === "doc_category_rfq")).toBe(true);
  });

  test("lastenheft doc type → doctype_external_strong", () => {
    const doc = makeDoc({ detectedDocType: "lastenheft" });
    const signals = collectOriginSignals(doc, identity);
    const s = signals.find(s => s.signal === "doctype_external_strong");
    expect(s?.weight).toBe(3);
  });

  test("arbeitsanweisung doc type → doctype_internal", () => {
    const doc = makeDoc({ detectedDocType: "arbeitsanweisung" });
    const signals = collectOriginSignals(doc, identity);
    const s = signals.find(s => s.signal === "doctype_internal");
    expect(s?.weight).toBe(2);
  });

  test("fmea doc type → doctype_internal", () => {
    const doc = makeDoc({ detectedDocType: "fmea" });
    const signals = collectOriginSignals(doc, identity);
    expect(signals.some(s => s.signal === "doctype_internal")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect ALL to fail (functions not defined)**

```bash
bun test src/utils/origin-classifier.test.ts
```

Expected: import errors / "cannot find module". If any test passes, check why before proceeding.

- [ ] **Step 3: Implement `src/utils/origin-classifier.ts`**

Create `src/utils/origin-classifier.ts`:

```typescript
import { matchesCompany, extractSignificantWords } from "./company-identity.ts";
import type { ParsedDocument, OriginSignal, OriginClassification } from "../state.ts";
import type { CompanyIdentity } from "../profiles/types.ts";

export interface DocxAuthorMeta {
  creator?: string;          // dc:creator from docProps/core.xml
  lastModifiedBy?: string;   // cp:lastModifiedBy from docProps/core.xml
  company?: string;          // <Company> from docProps/app.xml
}

const INTERNAL_DOCTYPES = new Set([
  "arbeitsanweisung", "protokoll", "handbuch", "lessons_learned", "8d_report",
  "kontrollplan", "serienfreigabe", "empb", "aenderungsantrag", "reklamation", "fmea",
]);

const EXTERNAL_STRONG_DOCTYPES = new Set(["lastenheft", "sla", "norm"]);
const EXTERNAL_WEAK_DOCTYPES   = new Set(["qualitätsvorgabe", "pruefspezifikation"]);

function countCompanyMentions(text: string, identity: CompanyIdentity): number {
  const normalized = text.toLowerCase();
  const allWords = [identity.name, ...identity.aliases].flatMap(extractSignificantWords);
  return allWords.reduce((sum, w) => {
    let count = 0;
    let pos = 0;
    while ((pos = normalized.indexOf(w, pos)) !== -1) { count++; pos += w.length; }
    return sum + count;
  }, 0);
}

export function collectOriginSignals(
  doc: ParsedDocument,
  identity: CompanyIdentity,
  docxMeta?: DocxAuthorMeta,
  pdfAuthor?: string,
): OriginSignal[] {
  const signals: OriginSignal[] = [];

  // — metadata_author_match (+5 internal) —
  const authorFields = [
    docxMeta?.creator,
    docxMeta?.lastModifiedBy,
    pdfAuthor,
  ].filter((f): f is string => typeof f === "string" && f.length > 0);
  if (authorFields.some(f => matchesCompany(f, identity))) {
    signals.push({ signal: "metadata_author_match", direction: "internal", weight: 5 });
  }

  // — metadata_company_match (+4 internal) —
  if (docxMeta?.company && matchesCompany(docxMeta.company, identity)) {
    signals.push({ signal: "metadata_company_match", direction: "internal", weight: 4 });
  }

  // — path_segment_match (+4 internal) —
  // A significant word from any identity name/alias equals a full path segment (dir only, not filename)
  const identityWords = new Set(
    [identity.name, ...identity.aliases].flatMap(extractSignificantWords),
  );
  const dirSegments = doc.pathSegments.slice(0, -1);
  const matchedPath = dirSegments.some(seg =>
    extractSignificantWords(seg).some(w => identityWords.has(w)),
  );
  if (matchedPath) {
    signals.push({ signal: "path_segment_match", direction: "internal", weight: 4 });
  }

  // — content signals (+3 strong / +1 weak internal) —
  const sample = (doc.textContent ?? "").slice(0, 2000);
  if (sample.length > 0) {
    const count = countCompanyMentions(sample, identity);
    if (count >= 3) {
      signals.push({ signal: "content_match_strong", direction: "internal", weight: 3 });
    } else if (count >= 1) {
      signals.push({ signal: "content_match_weak", direction: "internal", weight: 1 });
    }
  }

  // — doctype_internal (+2 internal) —
  if (doc.detectedDocType && INTERNAL_DOCTYPES.has(doc.detectedDocType)) {
    signals.push({ signal: "doctype_internal", direction: "internal", weight: 2 });
  }

  // — oem_folder_detected (+3 external) —
  if (doc.inferredCustomer) {
    signals.push({ signal: "oem_folder_detected", direction: "external", weight: 3 });
  }

  // — doctype_external_strong (+3 external) —
  if (doc.detectedDocType && EXTERNAL_STRONG_DOCTYPES.has(doc.detectedDocType)) {
    signals.push({ signal: "doctype_external_strong", direction: "external", weight: 3 });
  }

  // — doc_category_rfq (+2 external) —
  if (doc.inferredDocumentCategory === "rfq" || doc.inferredDocumentCategory === "quotation") {
    signals.push({ signal: "doc_category_rfq", direction: "external", weight: 2 });
  }

  // — doctype_external_weak (+2 external) —
  if (doc.detectedDocType && EXTERNAL_WEAK_DOCTYPES.has(doc.detectedDocType)) {
    signals.push({ signal: "doctype_external_weak", direction: "external", weight: 2 });
  }

  return signals;
}

export function classifyOrigin(signals: OriginSignal[]): OriginClassification {
  const internalScore = signals
    .filter(s => s.direction === "internal")
    .reduce((sum, s) => sum + s.weight, 0);
  const externalScore = signals
    .filter(s => s.direction === "external")
    .reduce((sum, s) => sum + s.weight, 0);

  let result: "internal" | "external" | "unknown";
  if (internalScore >= 4 && internalScore > externalScore)      result = "internal";
  else if (externalScore >= 3 && externalScore > internalScore) result = "external";
  else                                                           result = "unknown";

  const gap         = Math.abs(internalScore - externalScore);
  const winnerScore = result === "internal" ? internalScore
                    : result === "external" ? externalScore : 0;

  let confidence: OriginClassification["confidence"];
  if      (result === "unknown")              confidence = "none";
  else if (winnerScore >= 8 || gap >= 6)     confidence = "high";
  else if (winnerScore >= 5 || gap >= 3)     confidence = "medium";
  else                                        confidence = "low";

  return { result, internalScore, externalScore, confidence, signals };
}
```

- [ ] **Step 4: Run tests — expect all to pass**

```bash
bun test src/utils/origin-classifier.test.ts
```

Expected output: all tests green. If any fail, fix the implementation (not the tests).

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/utils/origin-classifier.ts src/utils/origin-classifier.test.ts
git commit -m "feat(classifier): add multi-signal origin classifier with tests"
```

---

## Task 3: Remove early classification from Phase 1

**Files:**
- Modify: `src/phases/1-harvest.ts`

- [ ] **Step 1: Remove the `documentOrigin` assignment block**

Find this block in `src/phases/1-harvest.ts` (near the `docIndex++` line):

```typescript
    const documentOrigin: "internal" | "external" | undefined =
      state.companyIdentity
        ? matchesCompany(relativePath, state.companyIdentity) ? "internal" : "external"
        : undefined;
```

And the corresponding spread in the `FileEntry` object:

```typescript
      ...(documentOrigin !== undefined ? { documentOrigin } : {}),
```

Remove both. The `FileEntry` entry no longer sets `documentOrigin` — Phase 2 owns it.

- [ ] **Step 2: Remove the `matchesCompany` import if it's now unused**

Check the import at the top of `1-harvest.ts`:

```typescript
import { matchesCompany } from "../utils/company-identity.ts";
```

If `matchesCompany` is no longer referenced anywhere in the file after the removal, delete this import line.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: no errors. (`documentOrigin` is optional on `FileEntry`, so removing the assignment is valid.)

- [ ] **Step 4: Commit**

```bash
git add src/phases/1-harvest.ts
git commit -m "refactor(harvest): remove early documentOrigin — Phase 2 owns classification"
```

---

## Task 4: Integrate classifier in Phase 2

**Files:**
- Modify: `src/phases/2-parse.ts`

### Step group A — DOCX author metadata extraction

- [ ] **Step 1: Add `extractDocxAuthorMeta` function**

In `src/phases/2-parse.ts`, add this function immediately after the existing `extractDateFromDocxCoreXml` function (around line 153):

```typescript
// Extract author and company metadata from DOCX — reads docProps/core.xml and docProps/app.xml
async function extractDocxAuthorMeta(absolutePath: string): Promise<DocxAuthorMeta> {
  const meta: DocxAuthorMeta = {};
  try {
    const { stdout: coreXml } = await execFileAsync(
      "unzip",
      ["-p", absolutePath, "docProps/core.xml"],
      { maxBuffer: 100 * 1024, timeout: 5000 },
    );
    const creator = coreXml.match(/<dc:creator[^>]*>([^<]+)<\/dc:creator>/)?.[1]?.trim();
    const lastBy  = coreXml.match(/<cp:lastModifiedBy[^>]*>([^<]+)<\/cp:lastModifiedBy>/)?.[1]?.trim();
    if (creator) meta.creator = creator;
    if (lastBy)  meta.lastModifiedBy = lastBy;
  } catch { /* unzip failed or not a DOCX — skip */ }
  try {
    const { stdout: appXml } = await execFileAsync(
      "unzip",
      ["-p", absolutePath, "docProps/app.xml"],
      { maxBuffer: 100 * 1024, timeout: 5000 },
    );
    const company = appXml.match(/<Company>([^<]+)<\/Company>/)?.[1]?.trim();
    if (company) meta.company = company;
  } catch { /* no app.xml — skip */ }
  return meta;
}
```

- [ ] **Step 2: Add required imports to Phase 2**

At the top of `src/phases/2-parse.ts`, add imports for the classifier and its types:

```typescript
import { collectOriginSignals, classifyOrigin, type DocxAuthorMeta } from "../utils/origin-classifier.ts";
```

### Step group B — Capture PDF author hint

- [ ] **Step 3: Set `pdfAuthorHint` during PDF parsing**

In `src/phases/2-parse.ts`, find the `parsePdfFile` function. After the `const tikaResult = await parseWithTika(file.absolutePath);` call (look for it near line 658), extract the author before the `return` statement and set it on the returned doc:

Find the `return {` statement that concludes `parsePdfFile` and, before it, extract the author:

```typescript
  // Capture author hint for origin classifier — not serialized
  const pdfAuthorHint =
    tikaResult.metadata["Author"] ??
    tikaResult.metadata["dc:creator"] ??
    tikaResult.metadata["meta:author"];
```

Then add to the returned object (near the other spread patterns):

```typescript
    ...(pdfAuthorHint ? { pdfAuthorHint } : {}),
```

Note: use `exactOptionalPropertyTypes`-safe spread pattern — never `pdfAuthorHint: undefined`.

### Step group C — Replace fallback classification loop

- [ ] **Step 4: Replace lines 542–551 with the multi-signal classifier loop**

Find this block in `runParse` in `src/phases/2-parse.ts`:

```typescript
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

Replace it entirely with:

```typescript
  if (state.companyIdentity) {
    for (const doc of state.parsed) {
      let docxMeta: DocxAuthorMeta | undefined;
      if (doc.extension === ".docx") {
        docxMeta = await extractDocxAuthorMeta(doc.absolutePath);
      }
      const signals = collectOriginSignals(doc, state.companyIdentity, docxMeta, doc.pdfAuthorHint);
      const classification = classifyOrigin(signals);
      doc.originClassification = classification;
      doc.documentOrigin = classification.result;
    }
  }
```

- [ ] **Step 5: Remove the now-unused `matchesCompany` import from Phase 2**

Find at the top of `2-parse.ts`:

```typescript
import { matchesCompany } from "../utils/company-identity.ts";
```

Remove it (only if `matchesCompany` is no longer referenced anywhere in the file — do a quick search first).

- [ ] **Step 6: Typecheck**

```bash
bun run typecheck
```

Expected: no errors. Fix any before proceeding.

- [ ] **Step 7: Commit**

```bash
git add src/phases/2-parse.ts
git commit -m "feat(parse): integrate multi-signal origin classifier in Phase 2"
```

---

## Task 5: Add consistency check in Phase 8 validate

**Files:**
- Modify: `src/phases/8-validate.ts`

- [ ] **Step 1: Add `ORIGIN_CLASSIFICATION_COVERAGE` check**

In `src/phases/8-validate.ts`, find the end of the existing checks — look for the line where `state.consistencyChecks = checks;` is assigned (near the bottom of `runValidate`). Add before that assignment:

```typescript
  // ORIGIN_CLASSIFICATION_COVERAGE — skip if no company identity configured
  if (state.companyIdentity) {
    const internalCount = state.parsed.filter(d => d.documentOrigin === "internal").length;
    const externalCount = state.parsed.filter(d => d.documentOrigin === "external").length;
    const unknownCount  = state.parsed.filter(d => d.documentOrigin === "unknown").length;
    const classifiedCount = internalCount + externalCount;
    const rate = state.parsed.length > 0 ? classifiedCount / state.parsed.length : 1;
    const lowConfCount = state.parsed.filter(
      d => d.originClassification?.confidence === "low",
    ).length;

    let interpretation = `${(rate * 100).toFixed(0)}% classified (${internalCount} internal, ${externalCount} external, ${unknownCount} unknown)`;
    if (lowConfCount > 0 && rate >= 0.7) {
      interpretation += ` — ${lowConfCount} low-confidence: add company aliases`;
    }

    checks.push(check(
      "ORIGIN_CLASSIFICATION_COVERAGE",
      rate,
      0.7,
      "above",
      "WARNING",
      clamp(interpretation),
    ));
  }
```

- [ ] **Step 2: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/phases/8-validate.ts
git commit -m "feat(validate): add ORIGIN_CLASSIFICATION_COVERAGE consistency check"
```

---

## Task 6: Add origin data to Phase 9 report

**Files:**
- Modify: `src/phases/9-report.ts`

### Step group A — JSON serialization

- [ ] **Step 1: Add `documentOrigin` to the `files` map in `serializeState`**

In `serializeState` in `9-report.ts`, find the `files: state.files.map(...)` block. The mapped object currently ends with `inferredDocumentCategory`. Add after it:

```typescript
      ...(f.documentOrigin !== undefined ? { documentOrigin: f.documentOrigin } : {}),
```

- [ ] **Step 2: Add `documentOrigin` and `originClassification` to the `parsed` map**

In `serializeState`, find the `parsed: state.parsed.map(...)` block. It currently ends with `detectedDocType: d.detectedDocType`. Add after it:

```typescript
      ...(d.documentOrigin !== undefined ? { documentOrigin: d.documentOrigin } : {}),
      ...(d.originClassification !== undefined ? { originClassification: d.originClassification } : {}),
```

- [ ] **Step 3: Add `originSummary` as a top-level field in `serializeState`**

In `serializeState`, compute the summary as a local const and add it using the codebase's spread-for-optional pattern. Add this immediately before the `return {` statement of `serializeState`:

```typescript
  const originSummary = state.companyIdentity !== null ? (() => {
    const internal = state.parsed.filter(d => d.documentOrigin === "internal").length;
    const external = state.parsed.filter(d => d.documentOrigin === "external").length;
    const unknown  = state.parsed.filter(d => d.documentOrigin === "unknown").length;
    const total    = state.parsed.length;
    return {
      internal,
      external,
      unknown,
      classificationRate: total > 0 ? (internal + external) / total : 0,
      highConfidence: state.parsed.filter(d => d.originClassification?.confidence === "high").length,
      lowConfidence:  state.parsed.filter(d => d.originClassification?.confidence === "low").length,
    };
  })() : undefined;
```

Then in the returned object, add `originSummary` immediately after the `summary` block using the codebase spread pattern:

```typescript
    ...(originSummary !== undefined ? { originSummary } : {}),
```

### Step group B — Human-readable report

- [ ] **Step 4: Add Origin Classification section to human.md**

In `9-report.ts`, find the function that generates the human markdown (look for the `push(` calls that build the markdown string — the report has sections built with `push()`. Find where to insert a new section, e.g. after the "Document Distribution" section.

Add this helper section builder before the `return` at the end of the human markdown function:

```typescript
  // — Origin Classification section —
  if (state.companyIdentity) {
    push("## Document Origin Classification\n");
    const internal = state.parsed.filter(d => d.documentOrigin === "internal").length;
    const external = state.parsed.filter(d => d.documentOrigin === "external").length;
    const unknown  = state.parsed.filter(d => d.documentOrigin === "unknown").length;
    const rate     = state.parsed.length > 0 ? (internal + external) / state.parsed.length : 0;
    push(`**Internal:** ${internal} | **External:** ${external} | **Unknown:** ${unknown} (${(rate * 100).toFixed(0)}% classified)\n`);

    const unknownDocs = state.parsed.filter(d => d.documentOrigin === "unknown");
    if (unknownDocs.length > 0) {
      push("### Unknown documents (need review)");
      for (const doc of unknownDocs.slice(0, 10)) {
        const signalSummary = doc.originClassification && doc.originClassification.signals.length > 0
          ? doc.originClassification.signals.map(s => `${s.signal}(${s.direction[0]}+${s.weight})`).join(", ")
          : "no signals fired";
        push(`- ${doc.id}  ${doc.path.slice(0, 80)}  — ${signalSummary}`);
      }
      push("");
    }

    const lowConf = state.parsed.filter(d => d.originClassification?.confidence === "low");
    if (lowConf.length > 0) {
      push("### Low-confidence classifications");
      for (const doc of lowConf.slice(0, 5)) {
        const c = doc.originClassification!;
        const topSignals = c.signals.map(s => s.signal).join("+");
        push(`- ${doc.id}  ${doc.filename.slice(0, 60)}  — ${c.result} (score ${c.internalScore} vs ${c.externalScore}) via ${topSignals}`);
      }
      push("");
    }
  }
```

- [ ] **Step 5: Typecheck**

```bash
bun run typecheck
```

Expected: no errors. Fix any issues with the IIFE or optional chaining.

- [ ] **Step 6: Commit**

```bash
git add src/phases/9-report.ts
git commit -m "feat(report): add originSummary to JSON and Origin Classification section to human.md"
```

---

## Task 7: Add origin breakdown to dashboard

**Files:**
- Modify: `src/dashboard/components/document-distribution.ts`

- [ ] **Step 1: Add the origin donut chart HTML to `renderDocumentDistribution`**

In `src/dashboard/components/document-distribution.ts`, the function `renderDocumentDistribution(data: ReportData)` builds an HTML string. Find the section with the existing chart containers (`<div class="chart-container">` blocks).

Add a new chart container after the last existing chart container block, before the closing `</div>` of the charts row:

```html
<div class="chart-container">
  <h3 style="font-family:'IBM Plex Mono',monospace;font-size:.8rem;color:#a0a4ab;margin-bottom:.5rem">ORIGIN</h3>
  <canvas id="origin-chart"></canvas>
</div>
```

- [ ] **Step 2: Add the origin Chart.js initialization in the `<script>` block**

In the same function, find the `document.addEventListener('DOMContentLoaded', ...)` block where the other charts are initialized (e.g. `ext-chart`, `lang-chart`). Add the origin donut initialization:

```javascript
      // Origin breakdown donut
      var originData = (function() {
        var internal = 0, external = 0, unknown = 0;
        var os = (_d && _d.originSummary) ? _d.originSummary : null;
        if (os) { internal = os.internal || 0; external = os.external || 0; unknown = os.unknown || 0; }
        return { internal: internal, external: external, unknown: unknown };
      })();
      if (document.getElementById('origin-chart')) {
        new Chart(document.getElementById('origin-chart'), {
          type: 'doughnut',
          data: {
            labels: ['Internal', 'External', 'Unknown'],
            datasets: [{ data: [originData.internal, originData.external, originData.unknown],
              backgroundColor: ['#43a047', '#ff6b35', '#555a64'], borderWidth: 0 }]
          },
          options: { plugins: { legend: { position: 'bottom', labels: { color: '#c9d1d9', font: { family: "'Fira Code', monospace", size: 11 } } } }, cutout: '65%' }
        });
      }
```

- [ ] **Step 3: Add unknown docs list below the chart row**

After the charts row, add a section that lists unknown-origin documents if any exist. Find where the document table is rendered (after the chart divs). Add before the document table:

```javascript
      // Unknown origin docs — show if any exist
      var unknownOriginDocs = (_d && _d.parsed ? _d.parsed : []).filter(function(p){ return p.documentOrigin === 'unknown'; });
      if (unknownOriginDocs.length > 0) {
        var unknownSection = document.createElement('div');
        unknownSection.style.cssText = 'margin:1rem 0;padding:.75rem;background:#1a1f2e;border-left:3px solid #555a64;font-family:"Fira Code",monospace;font-size:.8rem';
        unknownSection.innerHTML = '<span style="color:#a0a4ab">UNCLASSIFIED ORIGIN (' + unknownOriginDocs.length + ')</span><ul style="margin:.5rem 0 0;padding-left:1.2rem;color:#c9d1d9">'
          + unknownOriginDocs.slice(0, 8).map(function(p){
              var sigs = (p.originClassification && p.originClassification.signals && p.originClassification.signals.length > 0)
                ? p.originClassification.signals.map(function(s){ return s.signal; }).join(', ')
                : 'no signals';
              return '<li>' + _esc(p.filename || p.id) + ' <span style="color:#555a64">— ' + _esc(sigs) + '</span></li>';
            }).join('')
          + '</ul>';
        document.querySelector('[data-dist-container]')?.prepend(unknownSection);
      }
```

Note: this requires the chart container wrapper to have `data-dist-container` attribute — check the existing HTML structure in the function and add the attribute if missing, or adjust the selector to match what exists.

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 5: Run full scanner on test docs to verify end-to-end**

```bash
DOCUMENTS_ROOT=./_test-docs REPORT_OUTPUT=./reports TIKA_URL=http://localhost:19998 OLLAMA_URL=http://localhost:11435 bun run src/index.ts
```

Expected: scanner completes, `reports/` contains a new JSON file. Check the JSON for:
- `originSummary` at top level
- Per-doc `originClassification` with `result`, `confidence`, `signals` in the `parsed` array
- Human.md contains "## Document Origin Classification" section

Note: Ollama and Tika are intentionally unreachable in this command (wrong ports). The scanner will exit early if Ollama is a hard gate — if so, use the Docker run instead.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/components/document-distribution.ts
git commit -m "feat(dashboard): add origin breakdown donut chart and unknown docs list"
```

---

## Final typecheck

- [ ] **Step: Verify no TypeScript errors across entire project**

```bash
bun run typecheck
```

Expected: 0 errors. If any remain, fix before declaring done.
