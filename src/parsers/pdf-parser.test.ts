import { expect, test, describe } from "bun:test";

// TextItem shape as returned by pdfjs-dist getTextContent()
interface TextItem {
  str: string;
  transform: number[]; // [a, b, c, fontSize, x, y]
  fontName: string;
}

function item(str: string, fontSize: number, fontName: string, y: number, prevY = y + 60): TextItem {
  return { str, transform: [1, 0, 0, fontSize, 100, y], fontName };
}

describe("extractHeadings", () => {
  test("scores numbered heading ≥ 4 — included", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    // "1. Introduction" at 18pt (> 1.3×12 body) + numbered = 3+3 = 6
    const items: TextItem[] = [
      item("Body text here normal.", 12, "Arial", 700),
      item("Body text here normal.", 12, "Arial", 685),
      item("Body text here normal.", 12, "Arial", 670),
      item("1. Introduction", 18, "ArialBold", 600),
    ];
    const headings = extractHeadings(items);
    expect(headings).toContain("1. Introduction");
  });

  test("scores plain body text < 4 — excluded", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    const items: TextItem[] = [
      item("Body text here normal.", 12, "Arial", 700),
      item("More body text here.", 12, "Arial", 685),
      item("Yet more text here.", 12, "Arial", 670),
    ];
    const headings = extractHeadings(items);
    expect(headings).toHaveLength(0);
  });

  test("all-caps short line scores 1 pt — needs another signal to reach 4", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    // "SCOPE" all-caps (1pt) + large font 18pt (3pt) = 4 → included
    const items: TextItem[] = [
      item("body text normal size here.", 12, "Arial", 700),
      item("body text normal size here.", 12, "Arial", 685),
      item("body text normal size here.", 12, "Arial", 670),
      item("SCOPE", 18, "Arial", 600),
    ];
    const headings = extractHeadings(items);
    expect(headings).toContain("SCOPE");
  });

  test("item with str shorter than 3 chars is skipped", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    const items: TextItem[] = [
      item("body text normal size here.", 12, "Arial", 700),
      item("body text normal size here.", 12, "Arial", 685),
      item("1.", 18, "ArialBold", 600), // too short even with score 6
    ];
    const headings = extractHeadings(items);
    expect(headings).toHaveLength(0);
  });

  test("returns empty array for empty input", async () => {
    const { extractHeadings } = await import("./pdf-parser.ts");
    expect(extractHeadings([])).toEqual([]);
  });
});

describe("scanned page threshold", () => {
  test("page with ≥ 100 chars is not scanned", async () => {
    const { isScannedPage } = await import("./pdf-parser.ts");
    expect(isScannedPage("x".repeat(100))).toBe(false);
  });

  test("page with < 100 chars is scanned", async () => {
    const { isScannedPage } = await import("./pdf-parser.ts");
    expect(isScannedPage("x".repeat(99))).toBe(true);
  });
});
