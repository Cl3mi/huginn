import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { join, relative, basename, dirname, extname } from "path";
import { glob } from "glob";
import type { ScannerState, FileEntry } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";

// OEM tokens in path segments — containing segment is customer, next segment is project
const OEM_TOKENS = [
  { token: /\bmerced(es|benz)\b/i, oem: "Mercedes" },
  { token: /\bbmw\b/i, oem: "BMW" },
  { token: /\baudi\b/i, oem: "Audi" },
  { token: /\bvw\b|\bvolkswagen\b/i, oem: "VW" },
  { token: /\bporsche\b/i, oem: "Porsche" },
  { token: /\bdaimler\b/i, oem: "Daimler" },
  { token: /\bstellantis\b/i, oem: "Stellantis" },
];

// Platform/project codes where the segment itself IS the project (e.g. G5X, G45, F30)
const BMW_PLATFORM_CODE = /^G\d{1,2}X$|^G\d{2,3}$|^F\d{2}X?$/i;

const DOC_CATEGORY_RFQ = /^rfq$/i;
const DOC_CATEGORY_QUOTATION = /^quot(?:ation)?s?$|^angebot[e]?$/i;

async function computeSha256Stream(absolutePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absolutePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function inferCustomerFromPath(segments: string[]): string | undefined {
  for (const seg of segments) {
    for (const { token, oem } of OEM_TOKENS) {
      if (token.test(seg)) return oem;
    }
  }
  for (const seg of segments) {
    const matches = findAllMatches(PATTERNS.oemNames, seg);
    if (matches.length > 0) return matches[0];
  }
  return undefined;
}

function inferProjectFromPath(segments: string[], customerSegIndex: number): string | undefined {
  const after = segments.slice(customerSegIndex + 1);
  if (after.length > 0) return after[0];
  return undefined;
}

function inferBmwOemFromPlatformCode(segments: string[]): string | undefined {
  for (const seg of segments) {
    if (BMW_PLATFORM_CODE.test(seg)) return "BMW";
  }
  return undefined;
}

function inferDocumentCategoryFromPath(segments: string[]): "rfq" | "quotation" | undefined {
  for (const seg of segments) {
    if (DOC_CATEGORY_RFQ.test(seg)) return "rfq";
    if (DOC_CATEGORY_QUOTATION.test(seg)) return "quotation";
  }
  return undefined;
}

function inferFolderStructure(files: FileEntry[]): ScannerState["folderStructureInference"] {
  if (files.length === 0) {
    return { likelyPattern: "empty", confidence: 0, customerNames: [], projectNames: [], documentCategories: [] };
  }

  const depths = files.map((f) => f.depth);
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;

  const customerNames = [...new Set(files.flatMap((f) => f.inferredCustomer ? [f.inferredCustomer] : []))];
  const projectNames = [...new Set(files.flatMap((f) => f.inferredProject ? [f.inferredProject] : []))];
  const documentCategories = [...new Set(files.flatMap((f) => f.inferredDocumentCategory ? [f.inferredDocumentCategory] : []))];

  let likelyPattern: string;
  let confidence: number;

  if (maxDepth - minDepth <= 1 && avgDepth <= 2) {
    likelyPattern = "flat";
    confidence = 0.7;
  } else if (documentCategories.length > 0 && projectNames.length > 0) {
    // project codes as top-level dirs, doc-category subdirs (e.g. G5X/rfq/, G6X/quotations/)
    likelyPattern = "project/doc-category/docs";
    confidence = 0.85;
  } else if (customerNames.length > 0 && projectNames.length > 0) {
    likelyPattern = "customer/project/offer-version/docs";
    confidence = 0.75;
  } else if (avgDepth >= 3) {
    likelyPattern = "deep-nested";
    confidence = 0.5;
  } else {
    likelyPattern = "unknown";
    confidence = 0.3;
  }

  return { likelyPattern, confidence, customerNames, projectNames, documentCategories };
}

export async function runHarvest(state: ScannerState): Promise<void> {
  const t = logger.phaseStart("1-harvest");

  const pattern = `**/*.{${CONFIG.allExtensions.map((e) => e.slice(1)).join(",")}}`;
  const files = await glob(pattern, {
    cwd: state.documentsRoot,
    absolute: false,
    nodir: true,
  });

  logger.info("Files found by glob", { count: files.length, root: state.documentsRoot });

  const extensionCounts: Record<string, number> = {};
  let docIndex = 0;
  let hashErrors = 0; // FINDING-013: track files that could not be hashed

  for (const relativePath of files) {
    const absolutePath = join(state.documentsRoot, relativePath);
    const ext = extname(relativePath).toLowerCase();
    extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;

    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch (e) {
      logger.warn("Cannot stat file, skipping", { path: absolutePath, error: String(e) });
      continue;
    }

    let sha256: string;
    try {
      sha256 = await computeSha256Stream(absolutePath);
    } catch (e) {
      logger.warn("Cannot hash file, skipping", { path: absolutePath, error: String(e) });
      hashErrors++;
      continue;
    }

    const segments = relativePath.split(/[/\\]/).filter(Boolean);
    const dirSegments = segments.slice(0, -1);

    let inferredCustomer = inferCustomerFromPath(dirSegments);
    // PATTERNS.oemNames is global — reset lastIndex after each .test() call
    const customerSegIndex = inferredCustomer
      ? dirSegments.findIndex((s) => {
          const matchedOemToken = OEM_TOKENS.some(({ token }) => token.test(s));
          const matchedOemName = PATTERNS.oemNames.test(s);
          PATTERNS.oemNames.lastIndex = 0;
          return matchedOemToken || matchedOemName;
        })
      : -1;

    if (!inferredCustomer) {
      inferredCustomer = inferBmwOemFromPlatformCode(dirSegments);
    }

    const inferredProject =
      customerSegIndex >= 0
        ? inferProjectFromPath(dirSegments, customerSegIndex)
        : dirSegments.length > 0 ? dirSegments[0] : undefined;

    const inferredDocumentCategory = inferDocumentCategoryFromPath(dirSegments);

    docIndex++;
    const id = `doc-${String(docIndex).padStart(3, "0")}`;

    const entry: FileEntry = {
      id,
      path: relativePath,
      absolutePath,
      filename: basename(relativePath),
      extension: ext,
      sizeBytes: fileStat.size,
      sha256,
      modifiedAt: fileStat.mtime,
      createdAt: fileStat.birthtime,
      depth: segments.length - 1,
      pathSegments: segments,
      ...(inferredCustomer ? { inferredCustomer } : {}),
      ...(inferredProject ? { inferredProject } : {}),
      ...(inferredDocumentCategory ? { inferredDocumentCategory } : {}),
    };

    state.files.push(entry);
  }

  state.folderStructureInference = inferFolderStructure(state.files);

  const oemByCustomer: Record<string, number> = {};
  for (const f of state.files) {
    if (f.inferredCustomer) {
      oemByCustomer[f.inferredCustomer] = (oemByCustomer[f.inferredCustomer] ?? 0) + 1;
    }
  }

  logger.phaseEnd("1-harvest", t, {
    totalFiles: state.files.length,
    byExtension: extensionCounts,
    byCustomer: oemByCustomer,
    folderPattern: state.folderStructureInference.likelyPattern,
    ...(hashErrors > 0 ? { hashErrors } : {}),
  });
}
