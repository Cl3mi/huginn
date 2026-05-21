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
  expect(withHint).toBeGreaterThan(noHint);
});

test("spec_value with measurement units scores higher with matching unit family", async () => {
  const text = "Zugfestigkeit: 500 MPa, Härte: 200 HV, Toleranz: ±0.05 mm";
  const noHint = await scoreBlock(text, "spec_value", {});
  const withHint = await scoreBlock(text, "spec_value", { dominantUnitFamily: "mechanical" });
  expect(withHint).toBeGreaterThan(noHint);
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
