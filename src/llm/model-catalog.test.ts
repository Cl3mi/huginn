import { expect, test, describe } from "bun:test";
import { CATALOG, type CatalogEntry } from "./model-catalog.ts";

describe("CATALOG", () => {
  test("has 13 entries", () => {
    expect(CATALOG.length).toBe(13);
  });

  test("all entry IDs are unique", () => {
    const ids = CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("all entries have notes <= 120 chars (Huginn project convention)", () => {
    for (const entry of CATALOG) {
      expect(entry.notes.length).toBeLessThanOrEqual(120);
    }
  });

  test("entries are sorted by ascending downloadSizeBytes", () => {
    for (let i = 1; i < CATALOG.length; i++) {
      expect(CATALOG[i]!.downloadSizeBytes)
        .toBeGreaterThanOrEqual(CATALOG[i - 1]!.downloadSizeBytes);
    }
  });

  test("minVramGb is 0 or >= 0.7 * raw-param-count for non-MoE entries", () => {
    for (const entry of CATALOG) {
      if (entry.family === "mixtral") continue;
      const numericParams = parseFloat(entry.parameterSize);
      if (entry.minVramGb !== 0) {
        expect(entry.minVramGb).toBeGreaterThanOrEqual(numericParams * 0.7);
      }
    }
  });

  test("has at least one CPU-viable validated entry", () => {
    const cpuValidated = CATALOG.filter((e) => e.minVramGb === 0 && e.huginnValidated);
    expect(cpuValidated.length).toBeGreaterThan(0);
  });

  test("CatalogEntry shape compiles", () => {
    const entry: CatalogEntry = CATALOG[0]!;
    expect(typeof entry.id).toBe("string");
    expect(typeof entry.displayName).toBe("string");
    expect(typeof entry.huginnValidated).toBe("boolean");
  });
});
