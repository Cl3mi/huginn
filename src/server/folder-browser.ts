import { readdir, stat } from "fs/promises";
import { join, resolve } from "path";

const SUPPORTED = new Set([".docx", ".xlsx", ".pptx", ".pdf"]);

export class FolderBrowseError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export type FolderEntry =
  | { name: string; type: "dir"; fileCount: number }
  | { name: string; type: "file"; ext: string; size: number };

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

  if (safePath !== safeRoot && !safePath.startsWith(safeRoot + "/")) {
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

  const dirEntries: FolderEntry[] = await Promise.all(
    rawEntries
      .filter(e => e.isDirectory())
      .map(async (d) => ({
        name: d.name,
        type: "dir" as const,
        fileCount: await countSupportedFiles(join(safePath, d.name)),
      }))
  );

  type FileEntry = Extract<FolderEntry, { type: "file" }>;
  const fileCandidates: (FileEntry | null)[] = await Promise.all(
    rawEntries
      .filter(e => e.isFile())
      .map(async (f): Promise<FileEntry | null> => {
        const ext = "." + f.name.split(".").pop()!.toLowerCase();
        if (!SUPPORTED.has(ext)) return null;
        let size = 0;
        try { size = (await stat(join(safePath, f.name))).size; } catch { /* skip */ }
        return { name: f.name, type: "file", ext, size };
      })
  );
  const fileEntries: FolderEntry[] = fileCandidates.filter((e): e is FileEntry => e !== null);

  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  dirEntries.sort((a, b) => collator.compare(a.name, b.name));
  fileEntries.sort((a, b) => collator.compare(a.name, b.name));

  return { path: safePath, entries: [...dirEntries, ...fileEntries] };
}
