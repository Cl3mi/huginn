import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { checkOllamaHealth } from "../llm/ollama.ts";
import { runRegexTests } from "../utils/regex-patterns.ts";
import { runChunkQualityTests } from "../utils/chunk-quality/tests.ts";
import { handleRequest } from "./routes.ts";
import { healthState } from "./health-state.ts";
import {
  loadSetupState,
  autoRecoverIfPossible,
  setupHolder,
  applySetupState,
  SETUP_FILE_PATH,
} from "./setup-state.ts";

async function initSetup(): Promise<void> {
  const loaded = loadSetupState(SETUP_FILE_PATH);
  if (loaded && loaded.installedChatModel) {
    applySetupState(loaded);
    logger.info("setup state loaded from disk", { model: loaded.installedChatModel });
    return;
  }
  const recovered = await autoRecoverIfPossible(SETUP_FILE_PATH, async () => {
    const { modelsAvailable } = await checkOllamaHealth();
    return modelsAvailable;
  });
  if (recovered) {
    applySetupState(recovered);
    logger.info("setup state auto-recovered from Ollama", { model: recovered.installedChatModel });
    return;
  }
  setupHolder.current = null;
  healthState.setupReady = false;
  logger.info("setup required: no chat model installed");
}

// Retry the Ollama health check while the container is still warming up.
// Without `ollama-init` in front of us, the scanner now starts ~15-30s after
// Ollama and can race the HTTP bind.
async function waitForOllama(): Promise<{ ok: boolean; modelsAvailable: string[] }> {
  const maxAttempts = 12;
  const intervalMs = 2500;
  let last: { ok: boolean; modelsAvailable: string[] } = { ok: false, modelsAvailable: [] };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await checkOllamaHealth();
    if (last.ok) {
      if (attempt > 1) logger.info("Ollama reachable", { attempt });
      return last;
    }
    if (attempt < maxAttempts) {
      logger.info("Ollama not yet reachable, retrying", { attempt, maxAttempts });
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
  return last;
}

async function start() {
  const regexResult = runRegexTests();
  if (!regexResult.passed) {
    logger.error("Regex test suite FAILED — aborting", { failures: regexResult.failures });
    process.exit(1);
  }

  const chunkQualityResult = runChunkQualityTests();
  if (!chunkQualityResult.passed) {
    logger.error("Chunk-quality test suite FAILED — aborting", { failures: chunkQualityResult.failures });
    process.exit(1);
  }

  const { ok: ollamaOk, modelsAvailable } = await waitForOllama();
  healthState.ollamaOk = ollamaOk;
  healthState.modelsAvailable = modelsAvailable;

  if (!ollamaOk) {
    logger.error("Ollama unreachable after retries — aborting (hard gate)");
    process.exit(1);
  }

  await initSetup();

  setInterval(async () => {
    const { ok: o, modelsAvailable: m } = await checkOllamaHealth();
    healthState.ollamaOk = o;
    healthState.modelsAvailable = m;
  }, 30_000);

  Bun.serve({
    port: CONFIG.serverPort,
    idleTimeout: 0,
    fetch: handleRequest,
  });

  logger.info(`Huginn server ready`, { url: `http://localhost:${CONFIG.serverPort}` });
  console.log(`\n  Huginn ready → http://localhost:${CONFIG.serverPort}\n`);
  if (!healthState.setupReady) {
    console.log("  Setup required — open the UI to install a chat model.\n");
  }
}

start().catch(e => {
  console.error("Server failed to start:", e);
  process.exit(1);
});
