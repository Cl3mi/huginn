import { expect, test, beforeAll, afterAll } from "bun:test";
import { writeFile, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import * as XLSX from "xlsx";

const testDir = join(tmpdir(), `huginn-xlsx-test-${randomUUID()}`);
let xlsxPath: string;
let xlsxWithImagePath: string;

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080200000090" +
  "012e0000000c4944415408d76360f8ff000001000007f0e5300000000049454e44ae426082",
  "hex"
);

beforeAll(async () => {
  await mkdir(testDir, { recursive: true });

  // Create a real XLSX using SheetJS
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet([["Name", "Value"], ["Alpha", 1], ["Beta", 2]]);
  const ws2 = XLSX.utils.aoa_to_sheet([["Col A", "Col B"], ["X", "Y"]]);
  XLSX.utils.book_append_sheet(wb, ws1, "Sheet1");
  XLSX.utils.book_append_sheet(wb, ws2, "Sheet2");
  xlsxPath = join(testDir, "test.xlsx");
  await writeFile(xlsxPath, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  // XLSX with image in xl/media/ — inject via JSZip after generation
  const JSZip = (await import("jszip")).default;
  const baseBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const zip = await JSZip.loadAsync(baseBuffer);
  zip.file("xl/media/image1.png", TINY_PNG);
  xlsxWithImagePath = join(testDir, "with-image.xlsx");
  await writeFile(xlsxWithImagePath, await zip.generateAsync({ type: "nodebuffer" }));
});

afterAll(async () => {
  await rm(testDir, { recursive: true, force: true });
});

test("extracts text from all sheets", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.text).toContain("Alpha");
  expect(result.text).toContain("Col A");
});

test("pageCount equals sheet count", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.pageCount).toBe(2);
});

test("headingsFromStructure is empty (XLSX has no heading semantics)", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.headingsFromStructure).toEqual([]);
});

test("imageCount counts image files in xl/media/", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxWithImagePath);
  expect(result.imageCount).toBe(1);
});

test("scannedPageRatio is 0 for XLSX", async () => {
  const { parseXlsx } = await import("./xlsx-parser.ts");
  const result = await parseXlsx(xlsxPath);
  expect(result.scannedPageRatio).toBe(0);
  expect(result.scannedPageIndices).toEqual([]);
});
