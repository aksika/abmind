import { getAbmindEnv } from "./env-schema.js";
/**
 * Ollama embedding client — generates vector embeddings via local ollama API.
 * Gated by EMBEDDING_ENABLED env var. When disabled, all methods return null/empty.
 */

import { logInfo, logWarn, logTrace } from "./mem-logger.js";
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

type VecCandidateRow = {
  id: number; content_en: string; content_original: string | null; created_at: number;
  memory_type: string | null; embedding: Buffer; trust: number | null; integrity: number | null;
  credibility: number | null; classification: number | null; source_message_ids: string | null;
  semantic_revision: number;
};

const VEC_SELECT_COLS = `em.id, em.content_en, em.content_original, em.created_at, em.memory_type,
  em.embedding, em.trust, em.integrity, em.credibility, em.classification, em.source_message_ids,
  em.semantic_revision`;

/** #1658 — embedding rows must exist and pass the shared-or-owned ceiling. */
function vectorVisibility(
  userId: string,
  maxClassification?: number,
): { where: string; params: (string | number)[] } {
  const vis = sharedOrOwnedClause("em", userId, effectiveMaxClassification(maxClassification));
  return { where: `em.embedding IS NOT NULL AND ${vis.sql}`, params: vis.params };
}

function cosineOfRow(row: VecCandidateRow, queryVector: Float32Array): number {
  const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
  return cosineSimilarity(queryVector, stored);
}

function toVecSearchResult(row: VecCandidateRow, score: number): VecSearchResult {
  return {
    id: row.id, content_en: row.content_en, content_original: row.content_original,
    created_at: row.created_at, memory_type: row.memory_type, score,
    trust: row.trust, integrity: row.integrity, credibility: row.credibility,
    classification: row.classification, source_message_ids: row.source_message_ids,
    semantic_revision: row.semantic_revision,
  };
}

/**
 * #1861 — KNN over the vec0 acceleration index. Returns null when the index
 * cannot be trusted for this query (extension absent, index not covering every
 * embedded row, KNN failure, or a candidate window crowded by rows the caller
 * cannot see), so the caller falls back to the exhaustive full-history scan.
 * vec0 ranks by L2, so cosine is recomputed for every candidate; the window is
 * accepted only when it is complete or already holds `limit` eligible hits.
 */
function vectorSearchViaIndex(
  db: Database.Database,
  queryVector: Float32Array,
  limit: number,
  userId: string,
  threshold: number,
  maxClassification?: number,
): VecSearchResult[] | null {
  try {
    const total = (db.prepare("SELECT COUNT(*) AS c FROM vec_memories").get() as { c: number }).c;
    const embedded = (db.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE embedding IS NOT NULL").get() as { c: number }).c;
    if (embedded === 0) return [];
    if (total < embedded) {
      logTrace(TAG, `vec index incomplete (${total}/${embedded}) — full-history scan`);
      return null;
    }
    const missing = db.prepare(
      `SELECT 1 FROM extracted_memories em
       WHERE em.embedding IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM vec_memories v WHERE v.rowid = em.id)
       LIMIT 1`,
    ).get();
    if (missing) {
      logTrace(TAG, "vec index has missing memory rows — full-history scan");
      return null;
    }
    const k = Math.min(total, Math.max(limit * 4, 256));
    const vis = vectorVisibility(userId, maxClassification);
    const queryBuffer = Buffer.from(queryVector.buffer, queryVector.byteOffset, queryVector.byteLength);
    const rows = db.prepare(
      `SELECT ${VEC_SELECT_COLS} FROM (
         SELECT rowid FROM vec_memories WHERE embedding MATCH ? AND k = ? ORDER BY distance
       ) v JOIN extracted_memories em ON em.id = v.rowid
       WHERE ${vis.where}`,
    ).all(queryBuffer, k, ...vis.params) as VecCandidateRow[];
    const scored = rows
      .map((row) => ({ row, score: cosineOfRow(row, queryVector) }))
      .filter((entry) => entry.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => toVecSearchResult(entry.row, entry.score));
    if (k >= total || scored.length >= limit) return scored;
    logTrace(TAG, `vec index window (k=${k}/${total}) held ${scored.length} eligible hits — full-history scan`);
    return null;
  } catch (err) {
    logTrace(TAG, `vec index search unavailable (${err instanceof Error ? err.message : String(err)}) — full-history scan`);
    return null;
  }
}

/**
 * #1861 — exhaustive scan over every eligible embedded row. Streams one row at
 * a time and keeps a bounded top-`limit` set, so memory does not grow with the
 * store; there is no recency cap. This is the correctness-preserving fallback
 * when the KNN index is unavailable or incomplete.
 */
function vectorSearchByScan(
  db: Database.Database,
  queryVector: Float32Array,
  limit: number,
  userId: string,
  threshold: number,
  maxClassification?: number,
): VecSearchResult[] {
  const vis = vectorVisibility(userId, maxClassification);
  const statement = db.prepare(
    `SELECT ${VEC_SELECT_COLS} FROM extracted_memories em WHERE ${vis.where}`,
  );
  const kept: VecSearchResult[] = [];
  for (const raw of statement.iterate(...vis.params)) {
    const row = raw as VecCandidateRow;
    const score = cosineOfRow(row, queryVector);
    if (score < threshold) continue;
    kept.push(toVecSearchResult(row, score));
    if (kept.length > limit * 4) {
      kept.sort((a, b) => b.score - a.score);
      kept.length = limit;
    }
  }
  kept.sort((a, b) => b.score - a.score);
  return kept.slice(0, limit);
}

export function vectorSearch(
  db: Database.Database,
  queryVector: Float32Array,
  opts: { userId?: string; limit?: number; threshold: number; maxClassification?: number },
): VecSearchResult[] {
  if (typeof opts.userId !== "string" || opts.userId.trim() === "") return [];
  const limit = opts.limit ?? 10;
  if (vecAvailable()) {
    const indexed = vectorSearchViaIndex(db, queryVector, limit, opts.userId, opts.threshold, opts.maxClassification);
    if (indexed !== null) return indexed;
  }
  return vectorSearchByScan(db, queryVector, limit, opts.userId, opts.threshold, opts.maxClassification);
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
