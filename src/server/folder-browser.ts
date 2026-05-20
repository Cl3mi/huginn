import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";

const SUPPORTED = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

export class FolderBrowseError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface FolderEntry {
  name: string;
  type: "dir";
  fileCount: number;
}

export interface FolderBrowseResult {
  path: string;
  entries: FolderEntry[];
}

async function countSupportedFiles(dirPath: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        count += await countSupportedFiles(join(dirPath, entry.name));
      } else {
        const ext = "." + entry.name.split(".").pop()!.toLowerCase();
        if (SUPPORTED.has(ext)) count++;
      }
    }
  } catch { /* unreadable dir — skip */ }
  return count;
}

export async function browseFolder(root: string, requestedPath: string): Promise<FolderBrowseResult> {
  const safeRoot = resolve(root);
  const safePath = resolve(requestedPath);

  if (!safePath.startsWith(safeRoot)) {
    throw new FolderBrowseError(403, `Path '${requestedPath}' is outside the documents root`);
  }

  try {
    const s = await stat(safePath);
    if (!s.isDirectory()) throw new FolderBrowseError(404, `'${requestedPath}' is not a directory`);
  } catch (e) {
    if (e instanceof FolderBrowseError) throw e;
    throw new FolderBrowseError(404, `Path '${requestedPath}' not found`);
  }

  const rawEntries = await readdir(safePath, { withFileTypes: true });
  const dirs = rawEntries.filter(e => e.isDirectory());

  const entries: FolderEntry[] = await Promise.all(
    dirs.map(async (d) => ({
      name: d.name,
      type: "dir" as const,
      fileCount: await countSupportedFiles(join(safePath, d.name)),
    }))
  );

  return { path: safePath, entries };
}
