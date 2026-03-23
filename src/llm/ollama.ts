import { CONFIG } from "../config.ts";
import { logger } from "../utils/logger.ts";

const EMBED_TIMEOUT_MS = CONFIG.ollamaEmbedTimeoutMs;
const COMPLETE_TIMEOUT_MS = CONFIG.ollamaCompleteTimeoutMs;
const MAX_RETRIES = 3;

export async function checkOllamaHealth(): Promise<{ ok: boolean; modelsAvailable: string[] }> {
  try {
    const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, modelsAvailable: [] };
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map((m) => m.name);
    return { ok: true, modelsAvailable: models };
  } catch {
    return { ok: false, modelsAvailable: [] };
  }
}

export async function embed(texts: string[]): Promise<Float32Array[]> {
  const results: Float32Array[] = [];

  for (let i = 0; i < texts.length; i += CONFIG.embeddingBatchSize) {
    const batch = texts.slice(i, i + CONFIG.embeddingBatchSize);
    const batchResults = await Promise.all(batch.map((text) => embedOne(text)));
    results.push(...batchResults);
  }

  return results;
}

async function embedOne(text: string, attempt = 0): Promise<Float32Array> {
  try {
    const res = await fetch(`${CONFIG.ollamaUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CONFIG.ollamaEmbedModel,
        prompt: text,
      }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Ollama embed error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as { embedding?: number[] };
    const embedding = data.embedding;
    if (!embedding || embedding.length === 0) {
      throw new Error("Ollama returned empty embedding");
    }

    return new Float32Array(embedding);
  } catch (e) {
    if (attempt < MAX_RETRIES - 1) {
      logger.warn("Ollama embed retry", { attempt: attempt + 1, error: String(e) });
      await Bun.sleep(1000 * (attempt + 1));
      return embedOne(text, attempt + 1);
    }
    throw e;
  }
}

export async function complete(
  prompt: string,
  options?: { temperature?: number; maxTokens?: number }
): Promise<string> {
  return completeWithRetry(prompt, options, 0);
}

async function completeWithRetry(
  prompt: string,
  options: { temperature?: number; maxTokens?: number } | undefined,
  attempt: number
): Promise<string> {
  try {
    const body: Record<string, unknown> = {
      model: CONFIG.ollamaChatModel,
      prompt,
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.1,
        ...(options?.maxTokens ? { num_predict: options.maxTokens } : {}),
      },
    };

    const res = await fetch(`${CONFIG.ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Ollama complete error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as { response?: string };
    return data.response ?? "";
  } catch (e) {
    if (attempt < 1) { // max 2 attempts for completion
      logger.warn("Ollama complete retry", { attempt: attempt + 1, error: String(e) });
      await Bun.sleep(2000);
      return completeWithRetry(prompt, options, attempt + 1);
    }
    throw e;
  }
}

// Parse JSON from LLM response (handles markdown code fences)
export function parseJsonFromLlm<T>(response: string): T {
  const cleaned = response
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  return JSON.parse(cleaned) as T;
}
