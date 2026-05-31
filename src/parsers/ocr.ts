import { execFile } from "child_process";
import { promisify } from "util";
import { logger } from "../utils/logger.ts";

const execFileAsync = promisify(execFile);
let _warnedMissing = false;

// binaryPath is injectable for tests; defaults to system tesseract
export async function runTesseract(
  imagePath: string,
  binaryPath = "tesseract"
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      binaryPath,
      [imagePath, "stdout", "-l", "deu+eng"],
      { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }
    );
    return stdout.trim();
  } catch (e: unknown) {
    const msg = String(e);
    if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("No such file")) {
      if (!_warnedMissing) {
        logger.warn("tesseract not found — OCR disabled for this run");
        _warnedMissing = true;
      }
      return "";
    }
    logger.warn("tesseract failed", { imagePath, error: msg.slice(0, 200) });
    return "";
  }
}

// Reset the one-time warning flag (used in tests)
export function _resetWarnFlag(): void {
  _warnedMissing = false;
}
