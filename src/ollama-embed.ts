import { getAbmindEnv } from "./env-schema.js";
/**
 * Ollama embedding client — generates vector embeddings via local ollama API.
 * Gated by EMBEDDING_ENABLED env var. When disabled, returns null.
 */

import { logWarn } from "./mem-logger.js";

const TAG = "ollama-embed";

export type OllamaEmbedConfig = {
  enabled: boolean;
  model: string;
  url: string;
  threshold: number;
};

export function loadEmbedConfig(): OllamaEmbedConfig {
  return {
    enabled: getAbmindEnv().embeddingEnabled,
    model: getAbmindEnv().embeddingModel,
    url: getAbmindEnv().embeddingUrl,
    threshold: getAbmindEnv().embeddingSimilarityThreshold,
  };
}

let warnedOnce = false;

export async function embedText(config: OllamaEmbedConfig, text: string): Promise<Float32Array | null> {
  if (!config.enabled) return null;
  try {
    const res = await fetch(`${config.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, input: text }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`ollama ${res.status}`);
    const data = await res.json() as { embeddings: number[][] };
    return new Float32Array(data.embeddings[0]!);
  } catch (err) {
    if (!warnedOnce) {
      logWarn(TAG, `ollama unavailable — Se disabled: ${err instanceof Error ? err.message : String(err)}`);
      warnedOnce = true;
    }
    return null;
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
