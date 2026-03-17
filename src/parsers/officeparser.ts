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

  return new Promise<OfficeparserResult>((resolve, reject) => {
    // officeparser v4 callback is (data, error) — not (error, data)
    const callback = (text: string | undefined, err: Error | undefined) => {
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
        tempFilesLocation: "/tmp",
      });
    } catch (e) {
      logger.warn("officeparser threw synchronously", { path: absolutePath, error: String(e) });
      reject(e);
    }
  });
}
