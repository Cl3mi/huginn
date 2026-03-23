import { rm, mkdir } from "fs/promises";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { logger } from "../utils/logger.ts";

export interface OfficeparserResult {
  text: string;
  charCount: number;
}

// Wrap officeparser npm package for DOCX/XLSX/PPTX parsing.
// officeparser doesn't support PDFs — route those to Tika.
export async function parseWithOfficeParser(absolutePath: string): Promise<OfficeparserResult> {
  // Dynamic import to avoid issues if package not installed yet
  const op = await import("officeparser");

  // PRIVACY: Use per-invocation isolated temp dir so DOCX content is never co-located
  // with other runs or accessible to concurrent processes.
  const tempDir = `${tmpdir()}/huginn-${randomUUID()}`;
  try {
    await mkdir(tempDir, { recursive: true });
  } catch {
    // mkdir failure is non-fatal — officeparser will use its own fallback
  }

  return new Promise<OfficeparserResult>((resolve, reject) => {
    // officeparser v4 callback is (data, error) — not (error, data)
    const callback = (text: string | undefined, err: Error | undefined) => {
      // Fire-and-forget cleanup — resolve/reject without waiting
      rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (err) {
        reject(err);
      } else {
        resolve({
          text: text ?? "",
          charCount: (text ?? "").length,
        });
      }
    };

    try {
      // officeparser v4 API: parseOffice(path, callback, config?)
      op.parseOffice(absolutePath, callback, {
        ignoreNotes: false,
        newlineDelimiter: "\n",
        outputErrorToConsole: false,
        tempFilesLocation: tempDir,
      });
    } catch (e) {
      rm(tempDir, { recursive: true, force: true }).catch(() => {});
      logger.warn("officeparser threw synchronously", { path: absolutePath, error: String(e) });
      reject(e);
    }
  });
}
