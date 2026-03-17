import { createHash } from "crypto";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { join, relative, basename, dirname, extname } from "path";
import { glob } from "glob";
import type { ScannerState, FileEntry } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";

// Known OEM name tokens to detect in path segments
const OEM_TOKENS = [
  { token: /\bmerced(es|benz)\b/i, oem: "Mercedes" },
  { token: /\bbmw\b/i, oem: "BMW" },
  { token: /\baudi\b/i, oem: "Audi" },
  { token: /\bvw\b|\bvolkswagen\b/i, oem: "VW" },
  { token: /\bporsche\b/i, oem: "Porsche" },
  { token: /\bdaimler\b/i, oem: "Daimler" },
  { token: /\bstellantis\b/i, oem: "Stellantis" },
];

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
  // Also check for OEM names in segment text
  for (const seg of segments) {
    const matches = findAllMatches(PATTERNS.oemNames, seg);
    if (matches.length > 0) return matches[0];
  }
  return undefined;
}

function inferProjectFromPath(segments: string[], customerSegIndex: number): string | undefined {
  // Project is typically the segment after the customer segment
  const after = segments.slice(customerSegIndex + 1);
  if (after.length > 0) return after[0];
  return undefined;
}

function inferFolderStructure(files: FileEntry[]): ScannerState["folderStructureInference"] {
  if (files.length === 0) {
    return { likelyPattern: "empty", confidence: 0, customerNames: [], projectNames: [] };
  }

  const depths = files.map((f) => f.depth);
  const minDepth = Math.min(...depths);
  const maxDepth = Math.max(...depths);
  const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;

  const customerNames = [...new Set(files.flatMap((f) => f.inferredCustomer ? [f.inferredCustomer] : []))];
  const projectNames = [...new Set(files.flatMap((f) => f.inferredProject ? [f.inferredProject] : []))];

  // Determine pattern based on depth distribution
  let likelyPattern: string;
  let confidence: number;

  if (maxDepth - minDepth <= 1 && avgDepth <= 2) {
    likelyPattern = "flat";
    confidence = 0.7;
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

  return { likelyPattern, confidence, customerNames, projectNames };
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
      continue;
    }

    // Build path segments (split by / or \)
    const segments = relativePath.split(/[/\\]/).filter(Boolean);
    // Remove the filename from segments for customer/project detection
    const dirSegments = segments.slice(0, -1);

    const inferredCustomer = inferCustomerFromPath(dirSegments);
    const customerSegIndex = inferredCustomer
      ? dirSegments.findIndex((s) => OEM_TOKENS.some(({ token }) => token.test(s)) || PATTERNS.oemNames.test(s))
      : -1;

    const inferredProject =
      customerSegIndex >= 0
        ? inferProjectFromPath(dirSegments, customerSegIndex)
        : dirSegments.length > 0 ? dirSegments[0] : undefined;

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
      depth: segments.length - 1, // depth = number of directory levels
      pathSegments: segments,
      ...(inferredCustomer ? { inferredCustomer } : {}),
      ...(inferredProject ? { inferredProject } : {}),
    };

    state.files.push(entry);
  }

  state.folderStructureInference = inferFolderStructure(state.files);

  // Reset oemNames pattern (it's global)
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
  });
}
