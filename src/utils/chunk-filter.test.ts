// src/utils/chunk-filter.test.ts
import { expect, test } from "bun:test";
import { filterChunk } from "./chunk-filter.ts";

test("rejects chunks shorter than 20 chars", () => {
  const result = filterChunk("too short");
  expect(result.passed).toBe(false);
  expect(result.rejectionReason).toBe("too_short");
});

test("rejects chunks with letter ratio below 25%", () => {
  // 3 letters out of 20 non-whitespace = 15%
  const result = filterChunk("123 456 789 012 345 abc");
  expect(result.passed).toBe(false);
  expect(result.rejectionReason).toBe("low_letter_ratio");
});

test("rejects chunks with punctuation ratio above 40%", () => {
  // heavy punctuation
  const result = filterChunk("...,,,;;;::: text here !!!???()[]{}");
  expect(result.passed).toBe(false);
  expect(result.rejectionReason).toBe("high_punctuation");
});

test("passes normal prose text", () => {
  const result = filterChunk("Der Werkstoff muss eine Zugfestigkeit von mindestens 500 MPa aufweisen.");
  expect(result.passed).toBe(true);
  expect(result.rejectionReason).toBeUndefined();
});

test("passes exactly-20-char text with good ratios", () => {
  const result = filterChunk("abcdefghijklmnopqrstu"); // 21 letters
  expect(result.passed).toBe(true);
});
