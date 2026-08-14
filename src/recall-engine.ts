import { localISO } from "./local-time.js";
/**
 * recall-engine — simplified recall pipeline (v2).
 *
 * Stages:
 *   Sf: Three-query fuzzy search (porter FTS5 + trigram content_en + trigram content_original)
 *   Ss: Signature Hamming distance (semantic approximate, no ollama, cap 5, threshold 0.65)
 *   Se: Embedding cosine similarity (async, requires embeddingProvider)
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
import { vectorSearch } from "./ollama-embed.js";
import { getAbmindEnv } from "./env-schema.js";
import { trigramSearch } from "./trigram-search.js";
import type { SfOptions } from "./trigram-search.js";
import { logWarn, logDebug, logTrace } from "./mem-logger.js";
import { sharedOrOwnedClause, effectiveMaxClassification } from "./memory-visibility.js";
import { applyContextBoost, applySpacingBoost, applyEmotionBoost, applyQualityBoost } from "./recall-boosts.js";

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
  emotionScore?: number;
  importanceFlags?: string;
  confidence?: number;
  createdAt?: number;
  semanticRevision?: number;
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

// ── Helpers ─────────────────────────────────────────────────────────────────

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

// ── Engine ──────────────────────────────────────────────────────────────────

export async function recallSearch(deps: RecallDeps, params: RecallParams): Promise<RecallResult> {
  // Normalize: if translated contains boolean operators (model artifact), split into keywords
  if (params.translated.length === 1 && /\bOR\b|\bAND\b/.test(params.translated[0]!)) {
    params = { ...params, translated: params.translated[0]!
      .split(/\bOR\b|\bAND\b/)
      .map(s => s.replace(/\bNOT\b/g, "").replace(/^["']+|["']+$/g, "").trim())
      .filter(Boolean) };
  }
  // Same for original (tool path sends model query as original too)
  if (params.original && /\bOR\b|\bAND\b/.test(params.original)) {
    params = { ...params, original: params.original.replace(/\bOR\b|\bAND\b|\bNOT\b/g, " ").replace(/["']/g, "").trim() };
  }

  const limit = params.limit ?? DEFAULT_LIMIT;
  const activeStages = new Set(params.stages ?? ALL_STAGES);
  const query = params.translated.join(" ");

  // --- Se: fire embedding async at start ---
  let embeddingPromise: Promise<Float32Array | null> | null = null;
  if (activeStages.has("Se") && deps.embeddingProvider) {
    embeddingPromise = deps.embeddingProvider.embedText(query);
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
        userId: params.userId, limit: limit * 3, threshold: getAbmindEnv().embeddingSimilarityThreshold,
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
          semanticRevision: r.semantic_revision,
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
      const queryText = params.translated.join(" ");
      const querySig = generateSignature(queryText);

      const conditions = ["signature IS NOT NULL"];
      const bindParams: (string | number)[] = [];
      // #1658: Ss applies the same shared-or-owned predicate before scoring.
      const vis = sharedOrOwnedClause("", params.userId, effectiveMaxClassification(params.maxClassification));
      conditions.push(vis.sql);
      bindParams.push(...vis.params);
      if (params.topic) { conditions.push("topic = ?"); bindParams.push(params.topic); }
      if (params.tier) { conditions.push("tier = ?"); bindParams.push(params.tier); }
      if (!params.includeExpired) { conditions.push("valid_to IS NULL"); }

      const rows = deps.db.prepare(
        `SELECT id, content_en, content_original, memory_type, created_at, signature, semantic_revision
         FROM extracted_memories WHERE ${conditions.join(" AND ")}
         ORDER BY created_at DESC LIMIT 500`,
      ).all(...bindParams) as Array<{
        id: number; content_en: string | null; content_original: string | null;
        memory_type: string | null; created_at: number; signature: Buffer;
        semantic_revision: number;
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
          semanticRevision: row.semantic_revision,
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
      const { queryEntityRelationships, isKnownEntity, queryPath } = await import("./entity-graph.js");
      // #362 — extract word runs so possessives ("alice's" → "alice", "s") and commas
      // ("alice," → "alice") match entities stored lowercase by upsertEdge.
      // \p{L} = any unicode letter, \p{N} = digit. Unicode-safe (Hungarian etc).
      const words = (query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter(w => w.length > 2);
      const knownEntities = words.filter(w => isKnownEntity(deps.db, w, effectiveMaxClassification(params.maxClassification), params.userId));

      // #831: Multi-hop — if 2+ entities found, find paths between them
      if (knownEntities.length >= 2) {
        for (let i = 0; i < knownEntities.length - 1 && s8Hits.length < 20; i++) {
          for (let j = i + 1; j < knownEntities.length && s8Hits.length < 20; j++) {
            const paths = queryPath(deps.db, knownEntities[i]!, knownEntities[j]!, effectiveMaxClassification(params.maxClassification), params.userId);
            for (const path of paths) {
              s8Hits.push({
                content: path.description,
                date: localISO(new Date(path.edges[0]!.last_seen_at)),
                source: "S8:entity-graph", score: path.hops === 1 ? 0.6 : 0.5,
              });
            }
          }
        }
      }

      // Single-entity fallback: direct edges for each known entity (no break)
      if (s8Hits.length === 0) {
        for (const entity of knownEntities.slice(0, 3)) {
          const edges = queryEntityRelationships(deps.db, entity, effectiveMaxClassification(params.maxClassification), params.userId);
          for (const edge of edges) {
            s8Hits.push({
              content: `${edge.entity_a} —[${edge.relation}]→ ${edge.entity_b}`,
              date: localISO(new Date(edge.last_seen_at)),
              source: "S8:entity-graph", score: 0.6,
            });
          }
        }
      }
    } catch { /* entity-graph module or table not available */ }
    if (s8Hits.length > 0) stages["S8"] = { hits: s8Hits, ms: elapsed(t) };
  }

  // --- Merge in priority order, context boost, MMR rerank ---
  const allResults = [...sfHits, ...seHits, ...ssHits, ...s6Hits, ...s8Hits];

  // #505 Stage B: penalize Sf-only hits not confirmed by Se (likely false positives)
  const seIds = new Set(seHits.map(h => h.id));
  for (const hit of allResults) {
    if (hit.source?.startsWith("Sf") && !seIds.has(hit.id) && seHits.length > 0) {
      hit.score *= 0.5;
    }
  }

  const boosted = params.currentContext ? applyContextBoost(allResults, params.currentContext) : allResults;
  const emotionBoosted = applyEmotionBoost(boosted, deps.db);
  const spaced = applySpacingBoost(emotionBoosted, deps.db);
  const qualityAdjusted = applyQualityBoost(spaced, deps.db);
  const reranked = applyMMR(qualityAdjusted, 0.7);
  const finalResults = await enrichResults(
    reranked.slice(0, limit),
    deps.db,
    params.userId,
    effectiveMaxClassification(params.maxClassification),
  );

  // --- Logging ---
  const totalMs = Object.values(stages).reduce((s, st) => s + st.ms, 0);
  logDebug("recall", `query="${query.slice(0, 60)}" → ${finalResults.length} results (${totalMs.toFixed(0)}ms) stages: ${Object.entries(stages).map(([k, v]) => `${k}:${v.hits.length}`).join(" ")}`);
  if (sfFull) logTrace("recall", `short-circuited after Sf (${sfHits.length} hits filled limit=${limit})`);
  logTrace("recall", `emotion-boosted=${emotionBoosted.filter(r => (r as any)._emotionBoosted).length} spacing-boosted=${spaced.filter(r => (r as any)._spacingBoosted).length}`);

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
  principalUserId: string,
  maxClassification: number,
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
        const topicList = [...topics];
        const vis = sharedOrOwnedClause("", principalUserId, maxClassification);
        const placeholders = topicList.map(() => "?").join(",");
        const siblings = db.prepare(
          `SELECT id, content_en, topic, memory_type, emotion_tags, importance_flags, confidence, created_at, emotion_context
           FROM extracted_memories WHERE topic IN (${placeholders}) AND valid_to IS NULL AND content_en IS NOT NULL
             AND ${vis.sql}
           ORDER BY created_at`,
        ).all(...topicList, ...vis.params) as Array<{ id: number; content_en: string; topic: string; memory_type: string | null; emotion_tags: string | null; importance_flags: string | null; confidence: number | null; created_at: number; emotion_context: string | null }>;
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
