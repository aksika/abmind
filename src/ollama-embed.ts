import { getAbmindEnv } from "./env-schema.js";
/**
 * Ollama embedding client — generates vector embeddings via local ollama API.
 * Gated by EMBEDDING_ENABLED env var. When disabled, all methods return null/empty.
 */

import { logInfo, logWarn } from "./mem-logger.js";
import type Database from "better-sqlite3";
import { requireNativeDep } from "../cli/lib/native-dep.js";
import { sharedOrOwnedClause, effectiveMaxClassification } from "./memory-visibility.js";

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

// ── sqlite-vec index (graceful degradation) ─────────────────────────────────

let _vecAvailable = false;

/** Try to load sqlite-vec extension. Call once at DB init. Dims comes from EMBEDDING_DIMENSIONS. */
export function initVec(db: Database.Database, dimensions: number): void {
  try {
    const sqliteVec = requireNativeDep("sqlite-vec") as { load: (db: unknown) => void };
    sqliteVec.load(db);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${dimensions}])`);
    _vecAvailable = true;
  } catch {
    logWarn(TAG, "sqlite-vec not available — falling back to brute-force vector search");
  }
}

/** Whether sqlite-vec is loaded and usable. */
export function vecAvailable(): boolean { return _vecAvailable; }

/** Backfill vec_memories from existing embeddings (one-time migration). */
export function backfillVecIndex(db: Database.Database): number {
  if (!_vecAvailable) return 0;
  const count = (db.prepare("SELECT COUNT(*) as c FROM vec_memories").get() as { c: number }).c;
  if (count > 0) return 0;
  const rows = db.prepare("SELECT id, embedding FROM extracted_memories WHERE embedding IS NOT NULL").all() as Array<{ id: number | bigint; embedding: Buffer }>;
  for (const row of rows) db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (${Number(row.id)}, ?)`).run(row.embedding);
  return rows.length;
}

/** Insert a single embedding into the vec index. */
export function vecInsert(db: Database.Database, rowid: number | bigint, embedding: Buffer): void {
  if (!_vecAvailable) return;
  try {
    db.prepare(`INSERT OR REPLACE INTO vec_memories (rowid, embedding) VALUES (${Number(rowid)}, ?)`).run(embedding);
  } catch {
    // vec0 virtual table may reject INSERT OR REPLACE — fall back to DELETE + INSERT
    try {
      db.prepare(`DELETE FROM vec_memories WHERE rowid = ${Number(rowid)}`).run();
      db.prepare(`INSERT INTO vec_memories (rowid, embedding) VALUES (${Number(rowid)}, ?)`).run(embedding);
    } catch {
      // best effort — vec_memories is an acceleration index, not source of truth
    }
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

/**
 * Search extracted_memories by vector similarity.
 * Returns ids + scores above threshold, sorted descending.
 */
export type VecSearchResult = {
  id: number; content_en: string; content_original: string | null; created_at: number;
  memory_type: string | null; score: number; trust: number | null; integrity: number | null;
  credibility: number | null; classification: number | null; source_message_ids: string | null;
  semantic_revision: number;
};

export function vectorSearch(
  db: Database.Database,
  queryVector: Float32Array,
  opts: { userId?: string; limit?: number; threshold: number; maxClassification?: number },
): VecSearchResult[] {
  if (typeof opts.userId !== "string" || opts.userId.trim() === "") return [];
  const conditions = ["embedding IS NOT NULL"];
  const params: (number | string)[] = [];
  // #1658: shared-or-owned predicate with the permanent class-3 ceiling.
  const vis = sharedOrOwnedClause("", opts.userId, effectiveMaxClassification(opts.maxClassification));
  conditions.push(vis.sql);
  params.push(...vis.params);

  // Cap the scan to the most recent 500 embedded memories to avoid O(n) over entire DB
  const scanLimit = 500;

  const rows = db.prepare(
    `SELECT id, content_en, content_original, created_at, memory_type, embedding, trust, integrity, credibility, classification, source_message_ids, semantic_revision FROM extracted_memories WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ${scanLimit}`
  ).all(...params) as Array<{
    id: number; content_en: string; content_original: string | null; created_at: number;
    memory_type: string | null; embedding: Buffer; trust: number | null; integrity: number | null;
    credibility: number | null; classification: number | null; source_message_ids: string | null;
    semantic_revision: number;
  }>;

  const scored: VecSearchResult[] = [];
  for (const row of rows) {
    const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
    const score = cosineSimilarity(queryVector, stored);
    if (score >= opts.threshold) {
      scored.push({ id: row.id, content_en: row.content_en, content_original: row.content_original, created_at: row.created_at, memory_type: row.memory_type, score, trust: row.trust, integrity: row.integrity, credibility: row.credibility, classification: row.classification, source_message_ids: row.source_message_ids, semantic_revision: row.semantic_revision });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, opts.limit ?? 10);
}

/**
 * Batch-embed all extracted_memories that have NULL embedding.
 * Returns count of newly embedded memories.
 */
export async function batchEmbed(
  config: OllamaEmbedConfig,
  db: Database.Database,
): Promise<number> {
  if (!config.enabled) return 0;

  // #1660: sealed class-3 rows keep embedding NULL for their whole life — no
  // maintenance or backfill job may populate them from either projection.
  const rows = db.prepare("SELECT id, user_id, semantic_revision, content_en FROM extracted_memories WHERE embedding IS NULL AND classification < 3").all() as Array<{ id: number; user_id: string; semantic_revision: number; content_en: string }>;
  if (rows.length === 0) return 0;

  logInfo(TAG, `Batch embedding ${rows.length} memories...`);
  const update = db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?");
  let count = 0;

  for (const row of rows) {
    const vec = await embedText(config, row.content_en);
    if (vec) {
      update.run(Buffer.from(vec.buffer), row.id, row.user_id, row.semantic_revision);
      count++;
    }
  }

  logInfo(TAG, `Batch embedded ${count}/${rows.length} memories`);
  return count;
}
