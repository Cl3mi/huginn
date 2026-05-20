// src/utils/domain-detector.test.ts
import { expect, test } from "bun:test";
import { detectDomainSignals, buildDomainProfile, type DomainSignalSample } from "./domain-detector.ts";

test("detectDomainSignals identifies german_modal family", () => {
  const text = "Das Bauteil muss eine Zugfestigkeit von 500 MPa aufweisen. Der Werkstoff soll korrosionsbeständig sein.";
  const signals = detectDomainSignals(text);
  expect(signals.reqFamilyHits.german_modal).toBeGreaterThan(0);
});

test("detectDomainSignals identifies rfc2119 family", () => {
  const text = "The implementation MUST support TLS 1.3. Servers SHOULD prefer ECDHE cipher suites.";
  const signals = detectDomainSignals(text);
  expect(signals.reqFamilyHits.rfc2119).toBeGreaterThan(0);
});

test("detectDomainSignals identifies mechanical unit family", () => {
  const text = "Toleranz ±0.05 mm, Zugfestigkeit 500 MPa, Gewicht 2.5 kg";
  const signals = detectDomainSignals(text);
  expect(signals.unitFamilyHits.mechanical).toBeGreaterThan(0);
});

test("detectDomainSignals identifies pharma unit family", () => {
  const text = "Dosierung 50 mg täglich, Konzentration 0.9 mg/mL, Batch 1200 μg";
  const signals = detectDomainSignals(text);
  expect(signals.unitFamilyHits.pharma).toBeGreaterThan(0);
});

test("buildDomainProfile returns dominant family from samples", () => {
  const samples: DomainSignalSample[] = [
    { reqFamilyHits: { german_modal: 5, rfc2119: 0, legal: 0, french_modal: 0 }, unitFamilyHits: { mechanical: 3, electrical: 0, pharma: 0, financial: 0, logistics: 0 }, refFormatHits: {} },
    { reqFamilyHits: { german_modal: 3, rfc2119: 1, legal: 0, french_modal: 0 }, unitFamilyHits: { mechanical: 5, electrical: 0, pharma: 0, financial: 0, logistics: 0 }, refFormatHits: {} },
  ];
  const profile = buildDomainProfile(samples, []);
  expect(profile.requirementLanguageFamily).toBe("german_modal");
  expect(profile.dominantUnitFamily).toBe("mechanical");
});

test("buildDomainProfile returns none when no signals found", () => {
  const samples: DomainSignalSample[] = [
    { reqFamilyHits: { german_modal: 0, rfc2119: 0, legal: 0, french_modal: 0 }, unitFamilyHits: { mechanical: 0, electrical: 0, pharma: 0, financial: 0, logistics: 0 }, refFormatHits: {} },
  ];
  const profile = buildDomainProfile(samples, []);
  expect(profile.requirementLanguageFamily).toBe("none");
  expect(profile.dominantUnitFamily).toBe("none");
});
