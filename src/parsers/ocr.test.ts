import { expect, test, beforeAll, afterAll } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";

// A tiny valid 1×1 white PNG (67 bytes) — just needs to be a readable image file
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108020000009001" +
  "2e0000000c4944415408d76360f8ff000001000007f0e5300000000049454e44ae426082",
  "hex"
);

const testDir = join(tmpdir(), `huginn-ocr-test-${randomUUID()}`);
const testImage = join(testDir, "test.png");

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });
  await writeFile(testImage, TINY_PNG);
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("returns empty string when binary path does not exist", async () => {
  const { runTesseract } = await import("./ocr.ts");
  const result = await runTesseract(testImage, "/nonexistent/tesseract-binary-xyz");
  expect(result).toBe("");
});

test("returns empty string on spawn failure (bad binary)", async () => {
  const { runTesseract } = await import("./ocr.ts");
  const result = await runTesseract("/nonexistent/image.png", "/nonexistent/tesseract-xyz");
  expect(result).toBe("");
});
