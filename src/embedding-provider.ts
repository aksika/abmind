/**
 * #173 — Embedding provider slot.
 *
 * Pluggable embedding backend. Pick once at install via EMBEDDING_PROVIDER env var.
 * Switching providers on a live DB requires `abmind embed --reset` to drop all
 * embeddings (dimension mismatch is a hard boot error — no silent corruption).
 *
 * Two built-in providers:
 * - OllamaProvider: default. POST {url}/api/embed, body { model, input }
 * - OpenAIProvider: covers OpenAI + any OpenAI-compatible API (Voyage, Together,
 *   local vLLM). POST {url}/embeddings, body { model, input: string[] }.
 *   Real batch support: 100 texts per HTTP request.
 */

import { getAbmindEnv } from "./env-schema.js";
import { logWarn } from "./mem-logger.js";

const TAG = "embed-provider";

export interface IEmbeddingProvider {
  /** Embed a single text. Returns null on failure (network, disabled, etc). */
  embedText(text: string): Promise<Float32Array | null>;
  /** Batch embed. Provider may chunk internally for efficiency. */
  batchEmbed(texts: string[]): Promise<Array<Float32Array | null>>;
  /** Expected embedding dimensions. Comes from EMBEDDING_DIMENSIONS env. */
  readonly dimensions: number;
  /** Human-readable provider name for logs/status. */
  readonly name: string;
}

// ── Ollama ──────────────────────────────────────────────────────────────────

export class OllamaProvider implements IEmbeddingProvider {
  readonly name = "ollama";
  readonly dimensions: number;
  private warnedOnce = false;

  constructor(
    private url: string,
    private model: string,
    dimensions: number,
  ) {
    this.dimensions = dimensions;
  }

  async embedText(text: string): Promise<Float32Array | null> {
    try {
      const res = await fetch(`${this.url}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: text }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}`);
      const data = await res.json() as { embeddings: number[][] };
      return new Float32Array(data.embeddings[0]!);
    } catch (err) {
      if (!this.warnedOnce) {
        logWarn(TAG, `ollama unavailable — Se disabled: ${err instanceof Error ? err.message : String(err)}`);
        this.warnedOnce = true;
      }
      return null;
    }
  }

  async batchEmbed(texts: string[]): Promise<Array<Float32Array | null>> {
    // Ollama does not support batch input — fall back to sequential calls.
    const out: Array<Float32Array | null> = [];
    for (const text of texts) out.push(await this.embedText(text));
    return out;
  }
}

// ── OpenAI / OpenAI-compatible ──────────────────────────────────────────────

const OPENAI_BATCH_CEILING = 100;

export class OpenAIProvider implements IEmbeddingProvider {
  readonly name = "openai";
  readonly dimensions: number;
  private warnedOnce = false;

  constructor(
    private url: string,
    private model: string,
    private apiKey: string,
    dimensions: number,
  ) {
    this.dimensions = dimensions;
  }

  async embedText(text: string): Promise<Float32Array | null> {
    const result = await this.batchEmbed([text]);
    return result[0] ?? null;
  }

  async batchEmbed(texts: string[]): Promise<Array<Float32Array | null>> {
    if (texts.length === 0) return [];
    const out: Array<Float32Array | null> = [];
    for (let i = 0; i < texts.length; i += OPENAI_BATCH_CEILING) {
      const chunk = texts.slice(i, i + OPENAI_BATCH_CEILING);
      const embeddings = await this.callBatch(chunk);
      out.push(...embeddings);
    }
    return out;
  }

  private async callBatch(chunk: string[]): Promise<Array<Float32Array | null>> {
    try {
      const body: Record<string, unknown> = { model: this.model, input: chunk };
      // OpenAI text-embedding-3-* supports dimension shortening; pass through.
      if (this.dimensions > 0) body.dimensions = this.dimensions;
      const res = await fetch(`${this.url}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text().catch(() => "?")}`);
      const data = await res.json() as { data: Array<{ embedding: number[]; index: number }> };
      // Ensure order matches input (OpenAI returns `index` field)
      const ordered: Array<Float32Array | null> = new Array(chunk.length).fill(null);
      for (const item of data.data) {
        if (item.index >= 0 && item.index < chunk.length) {
          ordered[item.index] = new Float32Array(item.embedding);
        }
      }
      return ordered;
    } catch (err) {
      if (!this.warnedOnce) {
        logWarn(TAG, `openai-compatible endpoint unavailable — Se disabled: ${maskErrorApiKey(err, this.apiKey)}`);
        this.warnedOnce = true;
      }
      return new Array(chunk.length).fill(null);
    }
  }
}

/**
 * Strip an API key from an error message if it accidentally got embedded
 * (some HTTP clients stringify headers on error).
 */
function maskErrorApiKey(err: unknown, apiKey: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (!apiKey || apiKey.length < 8) return msg;
  return msg.split(apiKey).join("***");
}

// ── Factory ─────────────────────────────────────────────────────────────────

/** Create the configured embedding provider from env. */
export function createEmbeddingProvider(): IEmbeddingProvider {
  const env = getAbmindEnv();
  const dims = env.embeddingDimensions;
  if (env.embeddingProvider === "openai") {
    if (!env.embeddingApiKey) {
      logWarn(TAG, "EMBEDDING_PROVIDER=openai but EMBEDDING_API_KEY is empty — calls will fail");
    }
    return new OpenAIProvider(env.embeddingUrl, env.embeddingModel, env.embeddingApiKey, dims);
  }
  return new OllamaProvider(env.embeddingUrl, env.embeddingModel, dims);
}
