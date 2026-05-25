import { describe, expect, test } from "bun:test";
import {
  collectOriginSignals,
  classifyOrigin,
  type DocxAuthorMeta,
} from "./origin-classifier.ts";
import type { ParsedDocument } from "../state.ts";

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
    dateSignals: { mtime: "2024-01-01", ctime: "2024-01-01", mtimeReliable: true, bestDate: "2024-01-01" },
    recommendedChunkStrategy: "heading_sections" as const,
    chunkStrategyReasoning: {
      recommended: "heading_sections" as const,
      confidence: 0.8,
      signals: { headingCount: 5, headingDepth: 2, avgTokensPerSection: 200, tableCount: 0, hasNestedHeadings: false, isXlsx: false, pdfClassification: "not_pdf" },
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
  test("single content_match_weak (+1) → unknown", () => {
    expect(classifyOrigin([{ signal: "content_match_weak", direction: "internal", weight: 1 }]).result).toBe("unknown");
  });
  test("doctype_internal (+2) alone → unknown", () => {
    expect(classifyOrigin([{ signal: "doctype_internal", direction: "internal", weight: 2 }]).result).toBe("unknown");
  });
  test("internalScore=3, externalScore=0 → unknown (threshold is 4 by design)", () => {
    expect(classifyOrigin([{ signal: "content_match_strong", direction: "internal", weight: 3 }]).result).toBe("unknown");
  });
  test("path_segment_match (+4) alone → internal", () => {
    expect(classifyOrigin([{ signal: "path_segment_match", direction: "internal", weight: 4 }]).result).toBe("internal");
  });
  test("oem_folder_detected (+3) alone → external", () => {
    expect(classifyOrigin([{ signal: "oem_folder_detected", direction: "external", weight: 3 }]).result).toBe("external");
  });
  test("metadata_author_match (+5) alone → internal", () => {
    expect(classifyOrigin([{ signal: "metadata_author_match", direction: "internal", weight: 5 }]).result).toBe("internal");
  });
  test("content_match_strong (+3) + doctype_internal (+2) = 5 → internal", () => {
    const r = classifyOrigin([{ signal: "content_match_strong", direction: "internal", weight: 3 }, { signal: "doctype_internal", direction: "internal", weight: 2 }]);
    expect(r.result).toBe("internal");
    expect(r.internalScore).toBe(5);
  });
  test("oem_folder (+3) + doctype_external_strong (+3) = 6 → external", () => {
    const r = classifyOrigin([{ signal: "oem_folder_detected", direction: "external", weight: 3 }, { signal: "doctype_external_strong", direction: "external", weight: 3 }]);
    expect(r.result).toBe("external");
    expect(r.externalScore).toBe(6);
  });
  test("tie: internal 4 vs external 4 → unknown", () => {
    expect(classifyOrigin([{ signal: "path_segment_match", direction: "internal", weight: 4 }, { signal: "oem_folder_detected", direction: "external", weight: 3 }, { signal: "doctype_external_weak", direction: "external", weight: 1 }]).result).toBe("unknown");
  });
  test("higher internal wins over lower external", () => {
    expect(classifyOrigin([{ signal: "metadata_author_match", direction: "internal", weight: 5 }, { signal: "oem_folder_detected", direction: "external", weight: 3 }]).result).toBe("internal");
  });
});

describe("classifyOrigin — confidence", () => {
  test("unknown → none", () => { expect(classifyOrigin([]).confidence).toBe("none"); });
  test("path_segment_match (+4) alone → low", () => {
    expect(classifyOrigin([{ signal: "path_segment_match", direction: "internal", weight: 4 }]).confidence).toBe("low");
  });
  test("score 9 → high", () => {
    const r = classifyOrigin([{ signal: "metadata_author_match", direction: "internal", weight: 5 }, { signal: "path_segment_match", direction: "internal", weight: 4 }]);
    expect(r.confidence).toBe("high");
    expect(r.internalScore).toBe(9);
  });
  test("score 5 → medium", () => {
    expect(classifyOrigin([{ signal: "content_match_strong", direction: "internal", weight: 3 }, { signal: "doctype_internal", direction: "internal", weight: 2 }]).confidence).toBe("medium");
  });
});

describe("collectOriginSignals — path", () => {
  test("no match in path → no path signal", () => {
    expect(collectOriginSignals(makeDoc({ pathSegments: ["Mercedes", "Docs", "Report.docx"] }), identity).some(s => s.signal === "path_segment_match")).toBe(false);
  });
  test("segment matches company word → path_segment_match weight 4", () => {
    const match = collectOriginSignals(makeDoc({ pathSegments: ["vertex", "Docs", "Report.docx"] }), identity).find(s => s.signal === "path_segment_match");
    expect(match?.weight).toBe(4);
  });
  test("alias in segment → path_segment_match", () => {
    expect(collectOriginSignals(makeDoc({ pathSegments: ["VSG", "Reports", "file.docx"] }), identity).some(s => s.signal === "path_segment_match")).toBe(true);
  });
});

describe("collectOriginSignals — content", () => {
  test("0 mentions → no content signal", () => {
    expect(collectOriginSignals(makeDoc({ textContent: "Some unrelated text." }), identity).some(s => s.signal.startsWith("content_match"))).toBe(false);
  });
  test("1 mention → content_match_weak weight 1", () => {
    const match = collectOriginSignals(makeDoc({ textContent: "Document prepared by Vertex Systems." }), identity).find(s => s.signal === "content_match_weak");
    expect(match?.weight).toBe(1);
  });
  test("3+ mentions → content_match_strong only", () => {
    const sigs = collectOriginSignals(makeDoc({ textContent: "Vertex Vertex Vertex authored this." }), identity);
    expect(sigs.some(s => s.signal === "content_match_strong")).toBe(true);
    expect(sigs.some(s => s.signal === "content_match_weak")).toBe(false);
  });
});

describe("collectOriginSignals — metadata", () => {
  test("DOCX creator matches → metadata_author_match", () => {
    expect(collectOriginSignals(makeDoc(), identity, { creator: "Vertex Systems Engineer" }).some(s => s.signal === "metadata_author_match")).toBe(true);
  });
  test("DOCX company matches → metadata_company_match", () => {
    expect(collectOriginSignals(makeDoc(), identity, { company: "Vertex Systems GmbH" }).some(s => s.signal === "metadata_company_match")).toBe(true);
  });
  test("PDF author matches → metadata_author_match", () => {
    expect(collectOriginSignals(makeDoc(), identity, undefined, "Vertex Systems").some(s => s.signal === "metadata_author_match")).toBe(true);
  });
  test("unrelated author → no metadata signal", () => {
    expect(collectOriginSignals(makeDoc(), identity, { creator: "Mercedes-Benz AG" }).some(s => s.signal.startsWith("metadata_"))).toBe(false);
  });
});

describe("collectOriginSignals — structural", () => {
  test("inferredCustomer → oem_folder_detected", () => {
    expect(collectOriginSignals(makeDoc({ inferredCustomer: "BMW" }), identity).some(s => s.signal === "oem_folder_detected")).toBe(true);
  });
  test("rfq category → doc_category_rfq", () => {
    expect(collectOriginSignals(makeDoc({ inferredDocumentCategory: "rfq" }), identity).some(s => s.signal === "doc_category_rfq")).toBe(true);
  });
  test("lastenheft → doctype_external_strong weight 3", () => {
    expect(collectOriginSignals(makeDoc({ detectedDocType: "lastenheft" }), identity).find(s => s.signal === "doctype_external_strong")?.weight).toBe(3);
  });
  test("arbeitsanweisung → doctype_internal weight 2", () => {
    expect(collectOriginSignals(makeDoc({ detectedDocType: "arbeitsanweisung" }), identity).find(s => s.signal === "doctype_internal")?.weight).toBe(2);
  });
  test("fmea → doctype_internal", () => {
    expect(collectOriginSignals(makeDoc({ detectedDocType: "fmea" }), identity).some(s => s.signal === "doctype_internal")).toBe(true);
  });
});
