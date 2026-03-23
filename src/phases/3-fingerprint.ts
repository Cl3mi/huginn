import type { ScannerState, DocumentFingerprint, RequirementDensityVector, StructuralFingerprint, ParsedDocument } from "../state.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { createMinHashSignature } from "../utils/minhash.ts";
import { findAllMatches, PATTERNS } from "../utils/regex-patterns.ts";
import { estimateTokens, truncateToTokens } from "../utils/tokenizer.ts";
import { embed } from "../llm/ollama.ts";

export async function runFingerprint(state: ScannerState, ollamaAvailable: boolean): Promise<void> {
  const t = logger.phaseStart("3-fingerprint");

  const embedInputs: Array<{ docId: string; text: string }> = [];

  for (const doc of state.parsed) {
    const headingTokens = doc.headings.map((h) => h.text);

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

    // deduplicate so repeated headings don't bias Jaccard similarity
    const headingMinHash = createMinHashSignature([...new Set(headingTokens)], 128);

    // use cached text from Phase 2 — avoids re-reading binary files
    const requirementDensity = computeRequirementDensity(doc.textContent ?? "", doc.pageCount ?? 1);

    const fp: DocumentFingerprint = {
      docId: doc.id,
      structural,
      headingMinHash,
      requirementDensity,
    };

    state.fingerprints.push(fp);

    if (ollamaAvailable) {
      // PRIVACY: headings only — no document content in embed inputs
      const embedText = buildEmbedInput(doc.headings.map((h) => h.text));
      embedInputs.push({ docId: doc.id, text: embedText });
    }
  }

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

  // Section-level embeddings (opt-in via SECTION_EMBEDDINGS=1)
  let totalSectionEmbeddings = 0;
  if (ollamaAvailable && CONFIG.sectionEmbeddingsEnabled) {
    logger.info("Section embeddings enabled — computing per-section embeddings");
    for (const doc of state.parsed) {
      if (doc.headings.length === 0) continue;
      const fp = state.fingerprints.find((f) => f.docId === doc.id);
      if (!fp) continue;

      try {
        const sectionInputs = buildSectionEmbedInputs(doc);
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

function computeRequirementDensity(
  text: string,
  pageCount: number
): RequirementDensityVector {
  if (!text) return zeroDensity();

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

// PRIVACY: Heading-only embed input — no document content permitted in LLM inputs.
function buildEmbedInput(headings: string[]): string {
  return truncateToTokens(`HEADINGS: ${headings.slice(0, 50).join(" | ")}`, 300);
}

// PRIVACY: headings only — no document content in section embed inputs
function buildSectionEmbedInputs(
  doc: ParsedDocument
): Array<{ headingPath: string; text: string }> {
  return doc.headings.map((h) => ({
    headingPath: h.text.slice(0, 80),
    text: truncateToTokens(h.text, 150),
  }));
}
