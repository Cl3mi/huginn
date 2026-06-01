// src/phases/3-projection.test.ts
import { expect, test } from "bun:test";
import { ProjectionAccumulator, projectDocument } from "./3-projection.ts";
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
    parserUsed: "mammoth",
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
  const { textContent: _omit, ...base } = makeDoc();
  const doc = { ...base, parseSuccess: false } as ParsedDocument;
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
