import { expect, test } from "bun:test";
import { estimateTokens, estimateChunkTokens } from "./token-estimator.ts";

test("estimateTokens returns 0 for empty string", () => {
  expect(estimateTokens("")).toBe(0);
});

test("estimateTokens returns positive integer for non-empty text", () => {
  const result = estimateTokens("Hello world");
  expect(result).toBeGreaterThan(0);
  expect(Number.isInteger(result)).toBe(true);
});

test("estimateTokens handles German compound words", () => {
  const result = estimateTokens("Die Karosserieteile werden nach DIN-Norm gefertigt und geprüft.");
  expect(result).toBeGreaterThan(10);
});

test("estimateChunkTokens applies boilerplate compression factor 0.7", () => {
  const text = "Seite 1 von 10 Vertraulich";
  const prose = estimateChunkTokens(text, "prose");
  const boilerplate = estimateChunkTokens(text, "boilerplate");
  expect(boilerplate).toBe(Math.ceil(prose * 0.7));
});

test("estimateChunkTokens applies header compression factor 0.8", () => {
  const text = "1. Anforderungen";
  const prose = estimateChunkTokens(text, "prose");
  const header = estimateChunkTokens(text, "header");
  expect(header).toBe(Math.ceil(prose * 0.8));
});

test("estimateChunkTokens applies no compression for prose and spec_value", () => {
  const text = "Der Werkstoff muss eine Zugfestigkeit von 500 MPa aufweisen.";
  expect(estimateChunkTokens(text, "prose")).toBe(estimateTokens(text));
  expect(estimateChunkTokens(text, "spec_value")).toBe(estimateTokens(text));
});

test("estimateChunkTokens falls back to 1.0 for unknown type", () => {
  const text = "Some text here";
  expect(estimateChunkTokens(text, "unknown_type")).toBe(estimateTokens(text));
});
