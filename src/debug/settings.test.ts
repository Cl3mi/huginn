// src/debug/settings.test.ts
import { expect, test } from "bun:test";
import { mergeDebugSettings } from "./settings.ts";
import type { DebugSettings } from "./settings.ts";

const base: DebugSettings = {
  enabled: false,
  decisionAudit: false,
  patternCoverage: false,
  llmTrace: false,
  zeroOutputDocs: false,
};

test("mergeDebugSettings applies boolean patches", () => {
  const result = mergeDebugSettings(base, { enabled: true, decisionAudit: true });
  expect(result.enabled).toBe(true);
  expect(result.decisionAudit).toBe(true);
  expect(result.patternCoverage).toBe(false);
});

test("mergeDebugSettings ignores non-boolean values", () => {
  // @ts-expect-error testing invalid input
  const result = mergeDebugSettings(base, { enabled: "yes" });
  expect(result.enabled).toBe(false);
});

test("mergeDebugSettings does not mutate original", () => {
  mergeDebugSettings(base, { enabled: true });
  expect(base.enabled).toBe(false);
});
