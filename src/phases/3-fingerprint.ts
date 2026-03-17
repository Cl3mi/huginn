import { readFile } from "fs/promises";
import type { ScannerState, DocumentFingerprint, RequirementDensityVector, StructuralFingerprint, ParsedDocument } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { createMinHashSignature } from "../utils/minhash.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { estimateTokens, truncateToTokens } from "../utils/tokenizer.ts";
import { embed } from "../llm/ollama.ts";

export async function runFingerprint(state: ScannerState, ollamaAvailable: boolean): Promise<void> {
  const t = logger.phaseStart("3-fingerprint");

  // Batch semantic embedding — process in CONFIG.embeddingBatchSize chunks
  const embedInputs: Array<{ docId: string; text: string }> = [];

  for (const doc of state.parsed) {
    const headingTokens = doc.headings.map((h) => h.text);

    // 3a. Structural fingerprint — pure numbers
    const structural: StructuralFingerprint = {
      h1Count: doc.headings.filter((h) => h.level === 1).length,
      h2Count: doc.headings.filter((h) => h.level === 2).length,
      h3Count: doc.headings.filter((h) => h.level === 3).length,
      h4PlusCount: doc.headings.filter((h) => h.level >= 4).length,
      tableCount: doc.tableCount,
      pageCount: doc.pageCount ?? 0,
      tokenCountEstimate: doc.tokenCountEstimate,
      hasNumberedHeadings: doc.hasNumberedHeadings,
    };

    // 3b. Heading MinHash
    const headingMinHash = createMinHashSignature(headingTokens, 128);

    // 3d. Requirement density — read text ephemerally
    const requirementDensity = await computeRequirementDensity(doc.absolutePath, doc.pageCount ?? 1);

    const fp: DocumentFingerprint = {
      docId: doc.id,
      structural,
      headingMinHash,
      requirementDensity,
    };

    state.fingerprints.push(fp);

    // Collect embed inputs for batch processing (3c)
    if (ollamaAvailable) {
      // IMP-10: embed heading text + first 80 chars of section content for richer semantic signal
      const embedText = await buildEmbedInput(doc.headings.map((h) => h.text), doc.absolutePath);
      embedInputs.push({ docId: doc.id, text: embedText });
    }
  }

  // 3c. Semantic embedding — batch
  if (ollamaAvailable && embedInputs.length > 0) {
    logger.info("Computing semantic embeddings", { count: embedInputs.length });
    for (let i = 0; i < embedInputs.length; i += CONFIG.embeddingBatchSize) {
      const batch = embedInputs.slice(i, i + CONFIG.embeddingBatchSize);
      try {
        const texts = batch.map((b) => b.text);
        const embeddings = await embed(texts);
        for (let j = 0; j < batch.length; j++) {
          const fp = state.fingerprints.find((f) => f.docId === batch[j]!.docId);
          if (fp && embeddings[j]) {
            fp.semanticEmbedding = embeddings[j]!;
          }
        }
      } catch (e) {
        logger.warn("Embedding batch failed, skipping", {
          batchStart: i,
          error: String(e),
        });
      }
    }
  }

  // GAP-03: Section-level embeddings (opt-in via SECTION_EMBEDDINGS=1)
  let totalSectionEmbeddings = 0;
  if (ollamaAvailable && CONFIG.sectionEmbeddingsEnabled) {
    logger.info("Section embeddings enabled — computing per-section embeddings");
    for (const doc of state.parsed) {
      if (doc.headings.length === 0) continue;
      const fp = state.fingerprints.find((f) => f.docId === doc.id);
      if (!fp) continue;

      try {
        const sectionInputs = await buildSectionEmbedInputs(doc);
        if (sectionInputs.length === 0) continue;

        const sectionEmbeddings: DocumentFingerprint["sectionEmbeddings"] = [];
        for (let i = 0; i < sectionInputs.length; i += CONFIG.embeddingBatchSize) {
          const batch = sectionInputs.slice(i, i + CONFIG.embeddingBatchSize);
          const embeddings = await embed(batch.map((s) => s.text));
          for (let j = 0; j < batch.length; j++) {
            if (embeddings[j]) {
              sectionEmbeddings.push({
                headingPath: batch[j]!.headingPath,
                embedding: embeddings[j]!,
              });
            }
          }
        }
        if (sectionEmbeddings.length > 0) {
          fp.sectionEmbeddings = sectionEmbeddings;
          totalSectionEmbeddings += sectionEmbeddings.length;
        }
      } catch (e) {
        logger.warn("Section embedding failed for doc, skipping", { docId: doc.id, error: String(e) });
      }
    }
  }

  const withEmbeddings = state.fingerprints.filter((f) => f.semanticEmbedding).length;
  logger.phaseEnd("3-fingerprint", t, {
    fingerprints: state.fingerprints.length,
    withSemanticEmbeddings: withEmbeddings,
    ...(CONFIG.sectionEmbeddingsEnabled ? { sectionEmbeddings: totalSectionEmbeddings } : {}),
  });
}

// Read text ephemerally for density computation — NOT stored in state
async function computeRequirementDensity(
  absolutePath: string,
  pageCount: number
): Promise<RequirementDensityVector> {
  let text = "";
  try {
    const buf = await readFile(absolutePath);
    // For density estimation, treat raw buffer as text (UTF-8 best effort)
    text = buf.toString("utf-8", 0, Math.min(buf.length, 500_000)); // cap at 500KB
  } catch {
    return zeroDensity();
  }

  const pages = Math.max(pageCount, 1);

  const mussCount = findAllMatches(PATTERNS.muss, text).length;
  const sollCount = findAllMatches(PATTERNS.soll, text).length;
  const kannCount = findAllMatches(PATTERNS.kann, text).length;
  const informativCount = findAllMatches(PATTERNS.informativ, text).length;
  const quantCount = findAllMatches(PATTERNS.quantitativeValue, text).length;
  const fikbCount = findAllMatches(PATTERNS.fikb, text).length + findAllMatches(PATTERNS.kbMaster, text).length;

  return {
    mussPerPage: mussCount / pages,
    sollPerPage: sollCount / pages,
    kannPerPage: kannCount / pages,
    informativPerPage: informativCount / pages,
    quantitativeValuesPerPage: quantCount / pages,
    fikbReferencesPerPage: fikbCount / pages,
  };
}

function zeroDensity(): RequirementDensityVector {
  return {
    mussPerPage: 0, sollPerPage: 0, kannPerPage: 0,
    informativPerPage: 0, quantitativeValuesPerPage: 0, fikbReferencesPerPage: 0,
  };
}

// IMP-10: Build embed input from headings + first 80 chars of each section (ephemeral)
// German automotive headings like "4.2.1 Anforderungen" carry minimal signal alone.
// Adding section context significantly improves cosine similarity for version pair detection.
async function buildEmbedInput(headings: string[], absolutePath: string): Promise<string> {
  let fullText = "";
  try {
    const buf = await readFile(absolutePath);
    fullText = buf.toString("utf-8", 0, Math.min(buf.length, 200_000));
  } catch {
    // Ephemeral read failed — fall back to headings only
  }

  if (!fullText) {
    return truncateToTokens(`HEADINGS: ${headings.slice(0, 50).join(" | ")}`, 300);
  }

  // Build heading → first 80 chars of content mapping
  const lines = fullText.split("\n");
  const headingSet = new Set(headings.map((h) => h.toLowerCase().trim()));
  const enriched: string[] = [];
  let inSection = false;
  let currentHeading = "";
  let sectionChars = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (headingSet.has(trimmed.toLowerCase()) && trimmed.length >= 3 && trimmed.length <= 120) {
      currentHeading = trimmed;
      inSection = true;
      sectionChars = 0;
    } else if (inSection && trimmed.length > 0 && sectionChars < 80) {
      const snippet = trimmed.slice(0, 80 - sectionChars);
      if (enriched.length === 0 || enriched[enriched.length - 1] !== `${currentHeading}: ${snippet}`) {
        enriched.push(`${currentHeading}: ${snippet}`);
      }
      sectionChars += trimmed.length;
      if (sectionChars >= 80) inSection = false;
    }
  }

  // If enrichment didn't work well, fall back to plain headings
  const parts = enriched.length > 0 ? enriched.slice(0, 30) : headings.slice(0, 50);
  return truncateToTokens(`HEADINGS: ${parts.join(" | ")}`, 300);
}

// GAP-03: Build per-section embed inputs for section-level embeddings
// Each section = heading text + first 200 chars of content under that heading
async function buildSectionEmbedInputs(
  doc: ParsedDocument
): Promise<Array<{ headingPath: string; text: string }>> {
  let fullText = "";
  try {
    const buf = await readFile(doc.absolutePath);
    fullText = buf.toString("utf-8", 0, Math.min(buf.length, 500_000));
  } catch {
    return [];
  }

  const headingTexts = doc.headings.map((h) => h.text);
  const headingSet = new Set(headingTexts.map((h) => h.toLowerCase().trim()));
  const sections: Array<{ headingPath: string; text: string }> = [];

  const lines = fullText.split("\n");
  let currentHeading = "";
  let contentLines: string[] = [];

  const flushSection = () => {
    if (!currentHeading) return;
    const content = contentLines.join(" ").replace(/\s+/g, " ").trim().slice(0, 200);
    const embedText = truncateToTokens(`${currentHeading}: ${content}`, 150);
    sections.push({ headingPath: currentHeading.slice(0, 80), text: embedText });
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (headingSet.has(trimmed.toLowerCase()) && trimmed.length >= 3 && trimmed.length <= 120) {
      flushSection();
      currentHeading = trimmed;
      contentLines = [];
    } else if (trimmed.length > 0) {
      contentLines.push(trimmed);
    }
  }
  flushSection();

  return sections;
}
