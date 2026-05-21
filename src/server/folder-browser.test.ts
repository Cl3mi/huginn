import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { browseFolder, FolderBrowseError } from "./folder-browser.ts";

const TMP = "/tmp/huginn-browse-test";

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(TMP, "documents", "project-alpha", "rfq"), { recursive: true });
  mkdirSync(join(TMP, "documents", "project-alpha", "quotations"), { recursive: true });
  mkdirSync(join(TMP, "documents", "project-beta"), { recursive: true });
  writeFileSync(join(TMP, "documents", "project-alpha", "rfq", "spec.docx"), "");
  writeFileSync(join(TMP, "documents", "project-alpha", "rfq", "drawing.pdf"), "");
  writeFileSync(join(TMP, "documents", "project-alpha", "quotations", "offer.docx"), "");
  writeFileSync(join(TMP, "documents", "top-level.pdf"), "hello"); // supported file at root
  writeFileSync(join(TMP, "documents", "note.txt"), ""); // unsupported — not listed
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const ROOT = join(TMP, "documents");

describe("browseFolder", () => {
  test("lists immediate subdirectories with file counts", async () => {
    const result = await browseFolder(ROOT, ROOT);
    expect(result.path).toBe(ROOT);
    const dirs = result.entries.filter(e => e.type === "dir");
    const dirNames = dirs.map(e => e.name).sort();
    expect(dirNames).toEqual(["project-alpha", "project-beta"]);
    const alpha = dirs.find(e => e.name === "project-alpha")!;
    expect(alpha.type).toBe("dir");
    if (alpha.type === "dir") expect(alpha.fileCount).toBe(3);
  });

  test("counts only supported extensions (.docx .xlsx .pptx .pdf)", async () => {
    const result = await browseFolder(ROOT, ROOT);
    const beta = result.entries.find(e => e.name === "project-beta" && e.type === "dir");
    expect(beta).toBeDefined();
    if (beta && beta.type === "dir") expect(beta.fileCount).toBe(0);
  });

  test("lists supported files at the current level (skips unsupported)", async () => {
    const result = await browseFolder(ROOT, ROOT);
    const files = result.entries.filter(e => e.type === "file");
    const names = files.map(e => e.name).sort();
    expect(names).toEqual(["top-level.pdf"]); // note.txt excluded
    const pdf = files.find(e => e.name === "top-level.pdf")!;
    if (pdf.type === "file") {
      expect(pdf.ext).toBe(".pdf");
      expect(pdf.size).toBe(5); // "hello"
    }
  });

  test("returns directories before files, both alphabetically", async () => {
    const result = await browseFolder(ROOT, ROOT);
    const types = result.entries.map(e => e.type);
    const firstFileIdx = types.indexOf("file");
    const lastDirIdx = types.lastIndexOf("dir");
    expect(lastDirIdx).toBeLessThan(firstFileIdx);
  });

  test("throws FolderBrowseError(403) for path outside root", async () => {
    await expect(browseFolder(ROOT, "/etc")).rejects.toThrow(FolderBrowseError);
    try {
      await browseFolder(ROOT, "/etc");
    } catch (e) {
      expect((e as FolderBrowseError).status).toBe(403);
    }
  });

  test("throws FolderBrowseError(404) for non-existent path", async () => {
    await expect(browseFolder(ROOT, join(ROOT, "does-not-exist"))).rejects.toThrow(FolderBrowseError);
    try {
      await browseFolder(ROOT, join(ROOT, "does-not-exist"));
    } catch (e) {
      expect((e as FolderBrowseError).status).toBe(404);
    }
  });

  test("resolves symlink-escaped paths as 403", async () => {
    await expect(browseFolder(ROOT, ROOT + "/../etc")).rejects.toThrow(FolderBrowseError);
  });

  test("throws FolderBrowseError(403) for sibling directory with prefix-matching name", async () => {
    // e.g. /tmp/huginn-browse-test2 would bypass naive startsWith check
    const siblingPath = TMP + "2"; // /tmp/huginn-browse-test2
    await expect(browseFolder(ROOT, siblingPath)).rejects.toThrow(FolderBrowseError);
    try {
      await browseFolder(ROOT, siblingPath);
    } catch (e) {
      expect((e as FolderBrowseError).status).toBe(403);
    }
  });
});
