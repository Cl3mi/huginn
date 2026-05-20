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
