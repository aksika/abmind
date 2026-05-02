import { localISO } from "./local-time.js";
/**
 * recall-engine — simplified recall pipeline (v2).
 *
 * Stages:
 *   Sf: Three-query fuzzy search (porter FTS5 + trigram content_en + trigram content_original)
 *   Ss: Signature Hamming distance (semantic approximate, no ollama, cap 5, threshold 0.65)
 *   Se: Embedding cosine similarity (async, optional — needs ollama)
 *   S6: Consolidation file search (daily/weekly/quarterly .md)
 *
 * Priority ordering: Sf → Se → Ss → S6. Dedup by memory ID. MMR reranking (λ=0.7).
 * If Sf fills the limit, Ss and Se are skipped for performance.
 * S6 always runs (different data source).
 * No S7 fallback — return empty on zero results.
 */

import type Database from "better-sqlite3";
import type { MemoryIndex } from "./memory-index.js";
import { searchConsolidationFiles } from "./consolidation-search.js";
import { applyMMR } from "./mmr.js";
import { embedText, vectorSearch, loadEmbedConfig } from "./ollama-embed.js";
import { trigramSearch } from "./trigram-search.js";
import type { SfOptions } from "./trigram-search.js";
import { logWarn, logDebug } from "./mem-logger.js";

const TAG = "recall";

// ── Types ───────────────────────────────────────────────────────────────────

export type RecallHit = {
  id?: number;
  content: string;
  date: string;
  source: string;
  score: number;
  source_ids?: string;
  contentOriginal?: string;
  memoryType?: string;
  trust?: number;
  integrity?: number;
  credibility?: number;
  classification?: number;
  timelineContext?: string;
  interferenceWarning?: string;
  topic?: string;
  emotionTags?: string;
  importanceFlags?: string;
  confidence?: number;
  createdAt?: number;
};

export type StageResult = {
  hits: RecallHit[];
  ms: number;
};

export type RecallResult = {
  results: RecallHit[];
  stages: Record<string, StageResult>;
  shortCircuitAfter: string | null;
  extractedIds: number[];
};

export type RecallContext = {
  hour?: number;        // 0-23, local time
  dayOfWeek?: number;   // 0-6, 0=Sunday
  topic?: string;       // current conversation topic
};

export type RecallParams = {
  translated: string[];
  original?: string;
  userId: string;
  limit?: number;
  maxClassification?: number;
  timeStart?: number;
  timeEnd?: number;
  stages?: string[];
  shortCircuitThreshold?: number;
  topic?: string;
  tier?: "core" | "general";
  emotion?: string;
  includeExpired?: boolean;
  resolution?: "signal" | "compact" | "standard" | "full";
  currentContext?: RecallContext;
  /** Set false for readonly DB connections (e.g. benchmarks). Default true. */
  trackRecalls?: boolean;
};

export type RecallDeps = {
  db: Database.Database;
  index: MemoryIndex;
  memoryDir: string;
  /** Optional — when provided, Se stage uses it instead of loading a fresh ollama client (#173). */
  embeddingProvider?: import("./embedding-provider.js").IEmbeddingProvider;
};

// ── Constants ───────────────────────────────────────────────────────────────

const ALL_STAGES = ["Sf", "Ss", "Se", "S6"];
const DEFAULT_LIMIT = 10;
const SS_THRESHOLD = 0.65;
const SS_CAP = 5;

// Context boost weights (env-tunable)
const CTX_HOUR_BOOST = parseFloat(process.env.RECALL_CONTEXT_HOUR_BOOST ?? "0.02");
const CTX_DOW_BOOST = parseFloat(process.env.RECALL_CONTEXT_DOW_BOOST ?? "0.015");
const CTX_TOPIC_BOOST = parseFloat(process.env.RECALL_CONTEXT_TOPIC_BOOST ?? "0.03");

// ── Context Boost ───────────────────────────────────────────────────────────

function hourBucket(hour: number): number {
  if (hour >= 6 && hour < 12) return 0;  // morning
  if (hour >= 12 && hour < 18) return 1; // afternoon
  if (hour >= 18 && hour < 23) return 2; // evening
  return 3; // night
}

function isWeekend(dow: number): boolean { return dow === 0 || dow === 6; }

export function applyContextBoost(results: RecallHit[], ctx: RecallContext): RecallHit[] {
  if (!ctx.hour && ctx.hour !== 0 && !ctx.dayOfWeek && ctx.dayOfWeek !== 0 && !ctx.topic) return results;

  let boostedCount = 0;
  const boosted = results.map(hit => {
    let boost = 0;
    const ts = hit.createdAt;
    if (ts && (ctx.hour != null || ctx.dayOfWeek != null)) {
      const d = new Date(ts);
      if (ctx.hour != null && hourBucket(d.getHours()) === hourBucket(ctx.hour)) {
        boost += CTX_HOUR_BOOST;
      }
      if (ctx.dayOfWeek != null) {
        const storedDow = d.getDay();
        if (storedDow === ctx.dayOfWeek) boost += CTX_DOW_BOOST;
        else if (isWeekend(storedDow) === isWeekend(ctx.dayOfWeek)) boost += CTX_DOW_BOOST * 0.5;
      }
    }
    if (ctx.topic && hit.topic && hit.topic !== "general" && hit.topic === ctx.topic) {
      boost += CTX_TOPIC_BOOST;
    }
    if (boost > 0) boostedCount++;
    return boost > 0 ? { ...hit, score: hit.score + boost } : hit;
  });

  if (boostedCount > 0) {
    logDebug(TAG, `context-boost applied to ${boostedCount}/${results.length} candidates`);
  }
  return boosted;
}

// ── Spacing boost (#244) ────────────────────────────────────────────────────

const DAY_MS = 86400000;

function spacingBoost(timestamps: number[]): number {
  if (timestamps.length < 2) return 1.0;
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) intervals.push(timestamps[i]! - timestamps[i - 1]!);
  const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
  if (avg >= 7 * DAY_MS) return 1.3;
  if (avg >= 1 * DAY_MS) return 1.15;
  return 1.0;
}

function applySpacingBoost(results: RecallHit[], db: Database.Database): RecallHit[] {
  if (results.length === 0) return results;
  const ids = results.filter(r => r.id != null).map(r => r.id!);
  if (ids.length === 0) return results;
  const ph = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT id, recall_timestamps FROM extracted_memories WHERE id IN (${ph})`).all(...ids) as Array<{ id: number; recall_timestamps: string | null }>;
  const tsMap = new Map(rows.map(r => [r.id, JSON.parse(r.recall_timestamps ?? "[]") as number[]]));
  return results.map(hit => {
    if (!hit.id) return hit;
    const ts = tsMap.get(hit.id);
    if (!ts || ts.length < 2) return hit;
    const mult = spacingBoost(ts);
    return mult > 1.0 ? { ...hit, score: hit.score * mult } : hit;
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

// ── Engine ──────────────────────────────────────────────────────────────────

export async function recallSearch(deps: RecallDeps, params: RecallParams): Promise<RecallResult> {
  const limit = params.limit ?? DEFAULT_LIMIT;
  const activeStages = new Set(params.stages ?? ALL_STAGES);
  const query = params.translated.join(" ");

  // --- Se: fire embedding async at start ---
  const embedConfig = loadEmbedConfig();
  let embeddingPromise: Promise<Float32Array | null> | null = null;
  if (embedConfig.enabled && activeStages.has("Se")) {
    // Prefer the injected provider (#173); fall back to legacy embedText for backward compat
    // with callers (sqlite-backend.ts, index.ts re-export) that don't thread a provider through.
    embeddingPromise = deps.embeddingProvider
      ? deps.embeddingProvider.embedText(query)
      : embedText(embedConfig, query);
  }

  const seenIds = new Set<number>();
  const extractedIds: number[] = [];
  const stages: Record<string, StageResult> = {};

  // Collect results in priority order
  const sfHits: RecallHit[] = [];
  const seHits: RecallHit[] = [];
  const ssHits: RecallHit[] = [];
  const s6Hits: RecallHit[] = [];

  // --- Sf: Three-query fuzzy search ---
  if (activeStages.has("Sf")) {
    const t = performance.now();
    const sfOpts: SfOptions = {
      translated: params.translated,
      original: params.original,
      userId: params.userId,
      limit,
      maxClassification: params.maxClassification ?? 2,
      timeStart: params.timeStart,
      timeEnd: params.timeEnd,
      topic: params.topic,
      tier: params.tier,
      emotion: params.emotion,
      includeExpired: params.includeExpired,
      resolution: params.resolution,
    };
    const sf = trigramSearch(deps.db, sfOpts);
    for (const h of sf.hits) sfHits.push(h);
    for (const id of sf.extractedIds) { seenIds.add(id); extractedIds.push(id); }
    stages["Sf"] = { hits: sfHits, ms: elapsed(t) };
  }

  const sfFull = sfHits.length >= limit;

  // --- Se: merge embedding results (skip if Sf full) ---
  if (embeddingPromise && !sfFull) {
    const t = performance.now();
    const queryVector = await embeddingPromise;
    if (queryVector) {
      const vecResults = vectorSearch(deps.db, queryVector, {
        userId: params.userId, limit: limit * 3, threshold: embedConfig.threshold,
        maxClassification: params.maxClassification ?? 2,
      });
      for (const r of vecResults) {
        if (seenIds.has(r.id)) continue;
        seenIds.add(r.id);
        extractedIds.push(r.id);
        seHits.push({
          id: r.id,
          content: r.content_en, date: localISO(new Date(r.created_at)),
          source: "Se:embedding", score: r.score,
          ...(r.source_message_ids ? { source_ids: r.source_message_ids } : {}),
          contentOriginal: r.content_original ?? undefined, memoryType: r.memory_type ?? undefined,
          trust: r.trust ?? undefined, integrity: r.integrity ?? undefined,
          credibility: r.credibility ?? undefined, classification: r.classification ?? undefined,
        });
      }
      stages["Se"] = { hits: seHits, ms: elapsed(t) };
    }
  } else if (embeddingPromise) {
    // Sf full — don't await, just discard
    embeddingPromise.catch(() => {});
  }

  // --- Ss: Signature Hamming (skip if Sf full) ---
  if (activeStages.has("Ss") && !sfFull) {
    const t = performance.now();
    try {
      const { generateSignature, hammingSimilarity } = await import("./signature-generator.js");
      const queryText = [...params.translated, params.original ?? ""].join(" ");
      const querySig = generateSignature(queryText);

      const conditions = ["signature IS NOT NULL"];
      const bindParams: (string | number)[] = [];
      if (params.topic) { conditions.push("topic = ?"); bindParams.push(params.topic); }
      if (params.tier) { conditions.push("tier = ?"); bindParams.push(params.tier); }
      if (!params.includeExpired) { conditions.push("valid_to IS NULL"); }

      const rows = deps.db.prepare(
        `SELECT id, content_en, content_original, memory_type, created_at, signature, emotion_score
         FROM extracted_memories WHERE ${conditions.join(" AND ")}`,
      ).all(...bindParams) as Array<{
        id: number; content_en: string | null; content_original: string | null;
        memory_type: string | null; created_at: number; signature: Buffer; emotion_score: number | null;
      }>;

      const scored: Array<{ row: typeof rows[0]; sim: number }> = [];
      for (const row of rows) {
        if (seenIds.has(row.id)) continue;
        const sig = new Uint8Array(row.signature);
        scored.push({ row, sim: hammingSimilarity(querySig, sig) });
      }
      scored.sort((a, b) => b.sim - a.sim);

      for (const { row, sim } of scored.slice(0, SS_CAP)) {
        if (sim < SS_THRESHOLD) break;
        seenIds.add(row.id);
        extractedIds.push(row.id);
        ssHits.push({
          id: row.id,
          content: row.content_en ?? "",
          date: localISO(new Date(row.created_at)),
          source: "Ss:signature", score: sim,
          contentOriginal: row.content_original ?? undefined,
          memoryType: row.memory_type ?? undefined,
        });
      }
    } catch { /* signature module not available */ }
    stages["Ss"] = { hits: ssHits, ms: elapsed(t) };
  }

  // --- S6: Consolidation files (always runs) ---
  if (activeStages.has("S6")) {
    const t = performance.now();
    const allKw = [...params.translated];
    if (params.original) allKw.push(params.original);
    const consolidationResults = searchConsolidationFiles(deps.memoryDir, allKw, {
      startTime: params.timeStart, endTime: params.timeEnd,
    });
    const s6Seen = new Set<string>();
    for (const c of consolidationResults) {
      const key = `${c.timestamp}:${c.content.slice(0, 80)}`;
      if (s6Seen.has(key)) continue;
      s6Seen.add(key);
      s6Hits.push({
        content: c.content, date: localISO(new Date(c.timestamp)),
        source: `S6:consolidation:${c.tier}`, score: 0.5,
      });
    }
    stages["S6"] = { hits: s6Hits, ms: elapsed(t) };
  }

  // --- S8: Entity graph (always runs — different data type) ---
  const s8Hits: RecallHit[] = [];
  {
    const t = performance.now();
    try {
      const { queryEntityRelationships, isKnownEntity } = await import("./entity-graph.js");
      // #362 — extract word runs so possessives ("alice's" → "alice", "s") and commas
      // ("alice," → "alice") match entities stored lowercase by upsertEdge.
      // \p{L} = any unicode letter, \p{N} = digit. Unicode-safe (Hungarian etc).
      const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(w => w.length > 2);
      for (const word of words) {
        if (!isKnownEntity(deps.db, word)) continue;
        const edges = queryEntityRelationships(deps.db, word, params.maxClassification ?? 2);
        for (const edge of edges) {
          s8Hits.push({
            content: `${edge.entity_a} —[${edge.relation}]→ ${edge.entity_b}`,
            date: localISO(new Date(edge.last_seen_at)),
            source: "S8:entity-graph", score: 0.6,
          });
        }
        break; // one entity match is enough
      }
    } catch { /* entity-graph module or table not available */ }
    if (s8Hits.length > 0) stages["S8"] = { hits: s8Hits, ms: elapsed(t) };
  }

  // --- Merge in priority order, context boost, MMR rerank ---
  const allResults = [...sfHits, ...seHits, ...ssHits, ...s6Hits, ...s8Hits];
  const boosted = params.currentContext ? applyContextBoost(allResults, params.currentContext) : allResults;
  const spaced = applySpacingBoost(boosted, deps.db);
  const reranked = applyMMR(spaced, 0.7);
  const finalResults = await enrichResults(reranked.slice(0, limit), deps.db);

  // --- Track recalls (spacing effect #244) ---
  if (extractedIds.length > 0 && params.trackRecalls !== false) {
    const now = Date.now();
    const ph = extractedIds.map(() => "?").join(",");
    deps.db.prepare(
      `UPDATE extracted_memories SET recall_count = recall_count + 1, last_recalled_at = ? WHERE id IN (${ph})`
    ).run(now, ...extractedIds);
    // Append timestamps for spacing boost
    for (const id of extractedIds) {
      const row = deps.db.prepare("SELECT recall_timestamps FROM extracted_memories WHERE id = ?").get(id) as { recall_timestamps: string | null } | undefined;
      const ts: number[] = JSON.parse(row?.recall_timestamps ?? "[]");
      ts.push(now);
      if (ts.length > 20) ts.shift();
      deps.db.prepare("UPDATE extracted_memories SET recall_timestamps = ? WHERE id = ?").run(JSON.stringify(ts), id);
    }
  }

  return {
    results: finalResults,
    stages,
    shortCircuitAfter: sfFull ? "Sf" : null,
    extractedIds,
  };
}

/**
 * Enrich recall results with timeline context and interference warnings.
 * Matches timeline context to hits by hit.id (identity) rather than positional
 * index — MMR reordering breaks any positional correspondence to the original
 * stage-accumulation order.
 * Returns a new array; input array is not mutated.
 */
async function enrichResults(
  results: RecallHit[],
  db: Database.Database,
): Promise<RecallHit[]> {
  const enriched: RecallHit[] = results.map(r => ({ ...r }));

  // Timeline context enrichment — skip if no hit has an ID (all S6)
  if (enriched.some(h => h.id !== undefined)) {
    try {
      const { buildTimelines, renderTimeline } = await import("./timeline-builder.js");
      const topics = new Set<string>();
      for (const hit of enriched) {
        const topicMatch = hit.content.match(/\|([a-z]+)\|/);
        if (topicMatch) topics.add(topicMatch[1]!);
      }
      if (topics.size > 0) {
        const topicList = [...topics].map(t => `'${t}'`).join(",");
        const siblings = db.prepare(
          `SELECT id, content_en, topic, memory_type, emotion_tags, importance_flags, confidence, created_at, emotion_context
           FROM extracted_memories WHERE topic IN (${topicList}) AND valid_to IS NULL AND content_en IS NOT NULL
           ORDER BY created_at`,
        ).all() as Array<{ id: number; content_en: string; topic: string; memory_type: string | null; emotion_tags: string | null; importance_flags: string | null; confidence: number | null; created_at: number; emotion_context: string | null }>;
        const timelines = buildTimelines(siblings);
        const idToTimeline = new Map<number, string>();
        for (const tl of timelines) {
          const rendered = renderTimeline(tl);
          for (const id of rendered.memoryIds) idToTimeline.set(id, rendered.rendered);
        }
        for (const hit of enriched) {
          if (hit.id !== undefined && idToTimeline.has(hit.id)) {
            hit.timelineContext = idToTimeline.get(hit.id);
          }
        }
      }
    } catch (err) { logWarn("recall-enrich", `timeline enrichment failed: ${err instanceof Error ? err.message : String(err)}`); }
  }

  // Interference detection: flag similar-but-different results
  try {
    const { detectInterference } = await import("./brain-patterns.js");
    for (let i = 0; i < enriched.length; i++) {
      for (let j = i + 1; j < enriched.length; j++) {
        const a = enriched[i]!, b = enriched[j]!;
        const topicA = a.content.match(/\|([a-z]+)\|/)?.[1] ?? "";
        const topicB = b.content.match(/\|([a-z]+)\|/)?.[1] ?? "";
        if (detectInterference(a.content, b.content, topicA, topicB)) {
          a.interferenceWarning = `⚠️ Conflicts with another result — verify which is current`;
          b.interferenceWarning = `⚠️ Conflicts with another result — verify which is current`;
        }
      }
    }
  } catch { /* brain-patterns not available */ }

  // Compress-field enrichment: fetch topic, emotion_tags, importance_flags, confidence for ABM-L rendering
  const idsToEnrich = enriched.filter(h => h.id !== undefined).map(h => h.id!);
  if (idsToEnrich.length > 0) {
    try {
      const placeholders = idsToEnrich.map(() => "?").join(",");
      const rows = db.prepare(
        `SELECT id, topic, emotion_tags, importance_flags, confidence, created_at
         FROM extracted_memories WHERE id IN (${placeholders})`,
      ).all(...idsToEnrich) as Array<{ id: number; topic: string | null; emotion_tags: string | null; importance_flags: string | null; confidence: number | null; created_at: number }>;
      const byId = new Map(rows.map(r => [r.id, r]));
      for (const hit of enriched) {
        const row = hit.id !== undefined ? byId.get(hit.id) : undefined;
        if (row) {
          hit.topic = row.topic ?? undefined;
          hit.emotionTags = row.emotion_tags ?? undefined;
          hit.importanceFlags = row.importance_flags ?? undefined;
          hit.confidence = row.confidence ?? undefined;
          hit.createdAt = row.created_at;
        }
      }
    } catch { /* non-critical */ }
  }

  return enriched;
}
