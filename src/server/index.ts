import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";
import { checkTikaHealth } from "../parsers/tika.ts";
import { checkOllamaHealth } from "../llm/ollama.ts";
import { runRegexTests } from "../utils/regex-patterns.ts";
import { handleRequest } from "./routes.ts";
import { healthState } from "./health-state.ts";

async function start() {
  const regexResult = runRegexTests();
  if (!regexResult.passed) {
    logger.error("Regex test suite FAILED — aborting", { failures: regexResult.failures });
    process.exit(1);
  }

  const [tikaOk, { ok: ollamaOk, modelsAvailable }] = await Promise.all([
    checkTikaHealth(),
    checkOllamaHealth(),
  ]);
  healthState.tikaOk = tikaOk;
  healthState.ollamaOk = ollamaOk;
  healthState.modelsAvailable = modelsAvailable;

  if (!tikaOk) logger.warn("Tika unreachable — PDF parsing will be skipped");
  if (!ollamaOk) logger.warn("Ollama unreachable — LLM features disabled");

  setInterval(async () => {
    const [t, { ok: o, modelsAvailable: m }] = await Promise.all([
      checkTikaHealth(),
      checkOllamaHealth(),
    ]);
    healthState.tikaOk = t;
    healthState.ollamaOk = o;
    healthState.modelsAvailable = m;
  }, 30_000);

  Bun.serve({
    port: CONFIG.serverPort,
    idleTimeout: 0, // disable — SSE streams are long-lived; per-stream keepalive in handleStatus
    fetch: handleRequest,
  });

  logger.info(`Huginn server ready`, { url: `http://localhost:${CONFIG.serverPort}` });
  console.log(`\n  Huginn ready → http://localhost:${CONFIG.serverPort}\n`);
}

start().catch(e => {
  console.error("Server failed to start:", e);
  process.exit(1);
});
