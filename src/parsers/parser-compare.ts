import type { ParserComparison } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";

// Compares officeparser vs Tika results for the same Office document.
// This comparison is FREE EVALUATION DATA for production decisions.
// Results are logged and stored in state for the Phase 8 report.

interface CompareInput {
  docId: string;
  officeparserChars: number;
  officeparserHeadings: string[];
  tikaChars: number;
  tikaHeadings: string[];
}

export function compareParserResults(input: CompareInput): ParserComparison {
  const { docId, officeparserChars, officeparserHeadings, tikaChars, tikaHeadings } = input;

  const charDeltaPercent =
    officeparserChars === 0 && tikaChars === 0
      ? 0
      : Math.abs(officeparserChars - tikaChars) / Math.max(officeparserChars, tikaChars, 1);

  const headingCountDelta = Math.abs(officeparserHeadings.length - tikaHeadings.length);

  let divergenceLevel: ParserComparison["divergenceLevel"];
  if (charDeltaPercent > CONFIG.parserDivergenceThreshold) {
    divergenceLevel = "major";
  } else if (charDeltaPercent > 0.05 || headingCountDelta > 3) {
    divergenceLevel = "minor";
  } else {
    divergenceLevel = "none";
  }

  if (divergenceLevel !== "none") {
    logger.warn("Parser divergence detected", {
      docId,
      officeparserChars,
      tikaChars,
      charDeltaPercent: (charDeltaPercent * 100).toFixed(1) + "%",
      headingCountDelta,
      divergenceLevel,
    });
  }

  return {
    officeParserChars: officeparserChars,
    tikaChars,
    charDeltaPercent,
    headingCountDelta,
    divergenceLevel,
  };
}
