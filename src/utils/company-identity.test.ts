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
