import { createInitialState } from "./state.ts";
import { CONFIG } from "./config.ts";
import { logger, setPhase } from "./utils/logger.ts";
import { runRegexTests } from "./utils/regex-patterns.ts";
import { checkTikaHealth } from "./parsers/tika.ts";
import { checkOllamaHealth } from "./llm/ollama.ts";
import { runHarvest } from "./phases/1-harvest.ts";
import { runParse } from "./phases/2-parse.ts";
import { runFingerprint } from "./phases/3-fingerprint.ts";
import { runCluster } from "./phases/4-cluster.ts";
import { runReferences } from "./phases/5-references.ts";
import { runRequirements } from "./phases/6-requirements.ts";
import { runValidate } from "./phases/7-validate.ts";
import { runReport } from "./phases/8-report.ts";
import { randomUUID } from "crypto";

// ============================================================
// Startup self-test
// ============================================================
async function startupChecks(): Promise<{ tikaOk: boolean; ollamaOk: boolean }> {
  setPhase("startup");

  // 1. Regex test suite — HARD GATE: abort if any fail
  logger.info("Running regex pattern test suite...");
  const regexResult = runRegexTests();
  if (!regexResult.passed) {
    logger.error("Regex test suite FAILED — aborting", {
      failures: regexResult.failures,
      testedPatterns: regexResult.testedPatterns,
    });
    console.error("\nREGEX TEST FAILURES:\n" + regexResult.failures.join("\n"));
    process.exit(1);
  }
  logger.info("Regex test suite passed", { testedPatterns: regexResult.testedPatterns });

  // 2. Tika health check
  logger.info("Checking Tika health...", { url: CONFIG.tikaUrl });
  const tikaOk = await checkTikaHealth();
  if (!tikaOk) {
    logger.warn("Tika is not reachable — PDF parsing will be skipped", { url: CONFIG.tikaUrl });
  } else {
    logger.info("Tika is healthy");
  }

  // 3. Ollama health check
  logger.info("Checking Ollama health...", { url: CONFIG.ollamaUrl });
  const { ok: ollamaOk, modelsAvailable } = await checkOllamaHealth();
  if (!ollamaOk) {
    logger.error("Ollama is not reachable — GPU is required, aborting scan", {
      url: CONFIG.ollamaUrl,
    });
    console.error("\nFATAL: Ollama is not reachable. GPU-accelerated Ollama must be running before the scan can start.");
    process.exit(1);
  } else {
    const hasEmbed = modelsAvailable.some((m) => m.includes(CONFIG.ollamaEmbedModel.split(":")[0]!));
    const hasChat = modelsAvailable.some((m) => m.includes(CONFIG.ollamaChatModel.split(":")[0]!));
    if (!hasEmbed) {
      logger.warn("Embed model not found in Ollama", {
        model: CONFIG.ollamaEmbedModel,
        available: modelsAvailable,
      });
    }
    if (!hasChat) {
      logger.warn("Chat model not found in Ollama", {
        model: CONFIG.ollamaChatModel,
        available: modelsAvailable,
      });
    }
    logger.info("Ollama is healthy", { models: modelsAvailable.length });
  }

  return { tikaOk, ollamaOk };
}

// ============================================================
// Main
// ============================================================
async function main() {
  const scanId = `scan-${Date.now()}-${randomUUID().slice(0, 8)}`;

  logger.info("=== Huginn Document Intelligence Scanner ===", {
    scanId,
    documentsRoot: CONFIG.documentsRoot,
    reportOutput: CONFIG.reportOutput,
  });

  // Startup checks
  const { tikaOk, ollamaOk } = await startupChecks();

  // Initialize state
  const state = createInitialState(scanId, CONFIG.documentsRoot);

  // Run phases sequentially, catch errors and save partial state
  const phases: Array<{ name: string; fn: () => Promise<void> }> = [
    {
      name: "1-harvest",
      fn: () => runHarvest(state),
    },
    {
      name: "2-parse",
      fn: () => runParse(state),
    },
    {
      name: "3-fingerprint",
      fn: () => runFingerprint(state, ollamaOk),
    },
    {
      name: "4-cluster",
      fn: () => runCluster(state),
    },
    {
      name: "5-references",
      fn: () => runReferences(state, ollamaOk),
    },
    {
      name: "6-requirements",
      fn: () => runRequirements(state, ollamaOk),
    },
    {
      name: "7-validate",
      fn: () => runValidate(state),
    },
    {
      name: "8-report",
      fn: () => runReport(state, ollamaOk),
    },
  ];

  for (const phase of phases) {
    try {
      await phase.fn();
    } catch (e) {
      logger.error(`Phase ${phase.name} failed`, { error: String(e) });
      console.error(`\nFatal error in phase ${phase.name}:`, e);
      // Attempt to write partial report
      try {
        setPhase("emergency-report");
        logger.info("Attempting emergency partial report write...");
        await runReport(state);
      } catch (reportErr) {
        logger.error("Emergency report write also failed", { error: String(reportErr) });
      }
      process.exit(1);
    }
  }

  logger.info("=== Scan complete ===", {
    scanId,
    files: state.files.length,
    parsed: state.parsed.length,
    versionPairs: state.versionPairs.length,
    requirements: state.requirements.length,
  });
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
