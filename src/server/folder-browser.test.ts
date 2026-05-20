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
  writeFileSync(join(TMP, "documents", "note.txt"), ""); // unsupported — not counted
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

const ROOT = join(TMP, "documents");

describe("browseFolder", () => {
  test("lists immediate subdirectories with file counts", async () => {
    const result = await browseFolder(ROOT, ROOT);
    expect(result.path).toBe(ROOT);
    const names = result.entries.map(e => e.name).sort();
    expect(names).toEqual(["project-alpha", "project-beta"]);
    const alpha = result.entries.find(e => e.name === "project-alpha")!;
    expect(alpha.type).toBe("dir");
    expect(alpha.fileCount).toBe(3);
  });

  test("counts only supported extensions (.docx .xlsx .pptx .pdf)", async () => {
    const result = await browseFolder(ROOT, ROOT);
    const beta = result.entries.find(e => e.name === "project-beta")!;
    expect(beta.fileCount).toBe(0);
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
});
