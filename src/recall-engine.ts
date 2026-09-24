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
import { vectorSearch, cosineSimilarity } from "./ollama-embed.js";
import { getAbmindEnv } from "./env-schema.js";
import { trigramSearch } from "./trigram-search.js";
import type { SfOptions } from "./trigram-search.js";
import { logWarn, logDebug, logTrace, isLogLevel } from "./mem-logger.js";
import { redactSecrets } from "./redact-secrets.js";
import { sharedOrOwnedClause, effectiveMaxClassification } from "./memory-visibility.js";
import { applyContextBoost, applySpacingBoost, applyEmotionBoost, applyQualityBoost } from "./recall-boosts.js";
import { applyJudgmentRerank } from "./recall-judgment.js";

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
  /** #1835 — true when weak-candidate embedding validation was warranted but
   * could not run (no provider, missing vectors, or the wait deadline elapsed).
   * Absent/false means validation ran or nothing needed it. */
  validationSkipped?: boolean;
};

export type RecallResult = {
  results: RecallHit[];
  stages: Record<string, StageResult>;
  shortCircuitAfter: string | null;
  extractedIds: number[];
  /** #1813 — optional version-1 fast-path decision envelope. Absent means
   * ordinary recall: no intent, no profile, or an abstention. */
  decision?: RecallDecisionV1;
};

/** #1813 — outcome vocabulary for the decision envelope. */
export type RecallDecisionOutcome = "answer" | "continue" | "already-supplied";

/** #1813 — version-1 decision envelope. Additive: existing consumers ignore it. */
export interface RecallDecisionV1 {
  readonly version: 1;
  readonly outcome: RecallDecisionOutcome;
  /** Bounded verbatim source extract; present only with outcome "answer". */
  readonly answerText?: string;
  readonly answerLanguage?: string;
  readonly sourceIds: readonly number[];
  readonly sourceRevisions: Record<number, number>;
  /** Advisory injection selection (top judged refs, never a hard cap). */
  readonly selectedRefs: readonly number[];
  /** Matched profile identity, or "none" when no profile passed. */
  readonly profile: string;
  readonly questionSet: string;
}

/** #1813 — optional fast-path intent. Omitted fields mean ordinary recall
 * or abstention, never implicit consent. Caller-supplied identity and refs
 * are verified owner-side against visibility and revisions. */
export interface FastPathIntent {
  /** Full English question (distinct from retrieval keywords). */
  readonly question: string;
  /** Desired answer language (currently only "en" can bypass). */
  readonly answerLanguage: string;
  readonly principal: string;
  readonly session: string;
  readonly turn: string;
  /** Evidence the host already delivered this turn. */
  readonly delivered: ReadonlyArray<{ readonly id: number; readonly revision: number }>;
  /** Capability-gated turn-scope release signal. */
  readonly releaseScope?: boolean;
}

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
  /** #1813 — optional fast-path intent (lookup verdict, repeat check). */
  fastPath?: FastPathIntent;
};

export type RecallDeps = {
  db: Database.Database;
  index: MemoryIndex;
  memoryDir: string;
  /** Optional — when provided, Se stage uses it instead of loading a fresh ollama client (#173). */
  embeddingProvider?: import("./embedding-provider.js").IEmbeddingProvider;
  /** Optional — with SYSTEM1_RECALL=on, a post-MMR System One rerank (#1812). Absent means baseline order. */
  judgmentProvider?: import("./judgment-provider.js").IJudgmentProvider;
  /** Optional — #1813 turn-scope store for repeat handling. Absent disables repeats. */
  turnScopes?: import("./recall-turn-scope.js").TurnScopeStore;
};

// ── Constants ───────────────────────────────────────────────────────────────

const ALL_STAGES = ["Sf", "Ss", "Se", "S6"];
const DEFAULT_LIMIT = 10;
const SS_THRESHOLD = 0.65;
const SS_CAP = 5;

// ── #1835 rank-fusion constants ─────────────────────────────────────────────
// Stage scores are incomparable (porter darwinism ~0.95-1.25 vs cosine ≤1.0),
// so the merge fuses RANKS (reciprocal-rank, K=60), never raw scores. The fused
// scale lands near the historical ~1.0 regime so bridge gates (>0.70 inject,
// >=1.0 old ordinary facts) keep their meaning; constants recorded with the
// 1835 synthetic replay in docs/plans/1835-recall-ranking.md Progress.
const RRF_K = 60;
const RRF_SCALE = 60;
/** Strong all-terms lexical matches never rank below this (pre-boost). */
const STRONG_FLOOR = 1.2;
/** Demotion for weak lexical hits that embedding validation refutes (#505 magnitude, now conditional). */
const WEAK_DEMOTE_FACTOR = 0.5;
/** Cosine below this refutes a weak lexical hit. */
const VALIDATE_COSINE_FLOOR = 0.3;
/** Max weak candidates checked per recall (bounded validation scan). */
const VALIDATE_MAX_CANDIDATES = 10;
/** Neutral memories at/over this age fade slightly; high emotion resists. */
const AGE_FADE_DAYS = 180;
const AGE_FADE_FACTOR = 0.9;
const EMOTION_RESIST_ABS = 3;
const DAY_MS = 86400000;

// ── Helpers ─────────────────────────────────────────────────────────────────

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}

/** #1835 — reciprocal-rank term: rank 0 contributes ~1.0 after RRF_SCALE. */
function rrfTerm(rank: number): number {
  return RRF_SCALE / (RRF_K + rank);
}

/**
 * #1835 — strong literal match: every query keyword occurs in the content.
 * Conservative by construction (diacritic/case folds and partial coverage do
 * not count): a missed strong hit still ranks by fusion, it just gets no floor.
 */
export function isStrongLexicalMatch(content: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  const text = content.toLowerCase();
  return keywords.every((kw) => kw.length > 0 && text.includes(kw.toLowerCase()));
}

/** #1835 — validation wait budget; env-overridable for deterministic tests. */
function validationWaitMs(): number {
  const raw = parseInt(process.env["RECALL_VALIDATE_WAIT_MS"] ?? "250", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 250;
}

/** #1835 — resolve with null on timeout or rejection; timer is unref'd. */
function withValidationTimeout(
  promise: Promise<Float32Array | null>,
  ms: number,
): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
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
  // #1813 — anchor for the shared foreground judgment deadline (R5): post-
  // rerank decisions observe the remaining system1TimeoutMs budget.
  const searchStart = Date.now();
  logDebug(TAG, `params: query="${redactSecrets(query).slice(0, 60)}" limit=${limit} stages=[${[...activeStages].join(",")}] maxClass=${params.maxClassification ?? 2} time=${params.timeStart ?? "-"}..${params.timeEnd ?? "-"} fastPath=${params.fastPath ? "yes" : "no"} ctx=${params.currentContext ? "yes" : "no"}`);

  // --- Se: fire embedding async at start ---
  let embeddingPromise: Promise<Float32Array | null> | null = null;
  if (activeStages.has("Se") && deps.embeddingProvider) {
    embeddingPromise = deps.embeddingProvider.embedText(query);
  }

  const seenIds = new Set<number>();
  const extractedIds: number[] = [];
  const stages: Record<string, StageResult> = {};
  /** #1835 — Se cosine rank by id, INCLUDING ids already seen from Sf. The Se
   * loop still adds only unseen ids as hits (dedup), but overlap is preserved
   * here as confirmation evidence instead of being discarded. */
  const seRankById = new Map<number, number>();

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
    logTrace(TAG, `Sf: ${sfHits.length} hits from ${params.translated.length} keywords + original (${stages["Sf"].ms}ms)`);
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
      vecResults.forEach((r, rank) => {
        // #1835 — record every Se rank before dedup: overlap with Sf becomes
        // confirmation evidence instead of being discarded.
        if (!seRankById.has(r.id)) seRankById.set(r.id, rank);
        if (seenIds.has(r.id)) return;
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
      });
      stages["Se"] = { hits: seHits, ms: elapsed(t) };
      logTrace(TAG, `Se: ${vecResults.length} candidates above threshold=${getAbmindEnv().embeddingSimilarityThreshold} → ${seHits.length} new hits (${stages["Se"].ms}ms)`);
    } else {
      logTrace(TAG, "Se: null query vector (provider failed or timed out)");
    }
  } else if (embeddingPromise) {
    // Sf full — don't await, just discard
    logTrace(TAG, `Se discarded after Sf full (${sfHits.length} hits filled limit=${limit})`);
    embeddingPromise.catch(() => { /* discarded rejection; recall already answered */ });
  } else if (activeStages.has("Se")) {
    logTrace(TAG, "Se skipped: no embedding provider");
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
      logTrace(TAG, `Ss: ${rows.length} rows scanned, ${scored.length} scored, ${ssHits.length} kept (threshold=${SS_THRESHOLD}, cap=${SS_CAP})`);
    } catch (err) { logTrace(TAG, `Ss skipped: ${err instanceof Error ? err.message : String(err)}`); }
    stages["Ss"] = { hits: ssHits, ms: elapsed(t) };
  } else if (activeStages.has("Ss")) {
    logTrace(TAG, `Ss skipped after Sf full (${sfHits.length} hits filled limit=${limit})`);
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
    logTrace(TAG, `S6: ${consolidationResults.length} file excerpts from ${allKw.length} keywords → ${s6Hits.length} hits (${stages["S6"].ms}ms)`);
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
      logTrace(TAG, `S8: ${words.length} tokens, ${knownEntities.length} known entities → ${s8Hits.length} hits`);
    } catch (err) { logTrace(TAG, `S8 skipped: ${err instanceof Error ? err.message : String(err)}`); }
    if (s8Hits.length > 0) stages["S8"] = { hits: s8Hits, ms: elapsed(t) };
  }

  // --- #1835 Merge: rank fusion onto one relevance scale, then boosts, MMR ---
  // Stage scores are incomparable across stages, so RANKS fuse (reciprocal-rank)
  // and only ranks order. Overlap across stages sums as confirmation evidence.
  const allResults = [...sfHits, ...seHits, ...ssHits, ...s6Hits, ...s8Hits];
  const rankIn = (list: RecallHit[], id: number | undefined): number | null => {
    if (id === undefined) return null;
    const i = list.findIndex((h) => h.id === id);
    return i >= 0 ? i : null;
  };
  // Age/emotion snapshot for the gentle fade (one query for all merged ids).
  const fusedIds = [...new Set(allResults.filter((h) => h.id !== undefined).map((h) => h.id!))];
  const ageMap = new Map<number, { createdAt: number; emotion: number | null }>();
  if (fusedIds.length > 0) {
    try {
      const ph = fusedIds.map(() => "?").join(",");
      const rows = deps.db.prepare(
        `SELECT id, created_at, emotion_score FROM extracted_memories WHERE id IN (${ph})`,
      ).all(...fusedIds) as Array<{ id: number; created_at: number; emotion_score: number | null }>;
      for (const row of rows) ageMap.set(row.id, { createdAt: row.created_at, emotion: row.emotion_score });
    } catch { /* without rows relevance is ageless; recall must not fail */ }
  }
  const nowMs = Date.now();
  let strongFloored = 0;
  let ageFaded = 0;
  for (const hit of allResults) {
    let relevance = 0;
    const rSf = rankIn(sfHits, hit.id);
    const rSs = rankIn(ssHits, hit.id);
    if (rSf !== null) relevance += rrfTerm(rSf);
    if (rSs !== null) relevance += rrfTerm(rSs);
    const rSe = hit.id !== undefined ? seRankById.get(hit.id) : undefined;
    if (rSe !== undefined) relevance += rrfTerm(rSe);
    if (relevance === 0) {
      // No lexical/semantic rank (S6 files, S8 graph): keep the existing fixed
      // score, already in bridge scale.
      relevance = hit.score;
    }
    // Gentle age fade: neutral old memories fade slightly, high emotion resists.
    const meta = hit.id !== undefined ? ageMap.get(hit.id) : undefined;
    if (meta && nowMs - meta.createdAt >= AGE_FADE_DAYS * DAY_MS
      && (meta.emotion === null || Math.abs(meta.emotion) < EMOTION_RESIST_ABS)) {
      relevance *= AGE_FADE_FACTOR;
      ageFaded++;
    }
    // Strong all-terms lexical matches never rank below the floor.
    if (hit.source?.startsWith("Sf") && isStrongLexicalMatch(hit.content, params.translated)) {
      if (relevance < STRONG_FLOOR) strongFloored++;
      relevance = Math.max(relevance, STRONG_FLOOR);
    }
    hit.score = relevance;
  }
  logTrace(TAG, `fusion: ${allResults.length} merged, strong-floor=${strongFloored} age-faded=${ageFaded}`);

  // --- #1835 Weak-candidate embedding validation (bounded, deadline-raced) ---
  // Replaces the #505 blanket halving: only weak (partial/fuzzy, non-strong) Sf
  // hits are checked, only against a resolved query embedding, only within the
  // wait budget — including the Sf-full short-circuit path, which reuses the
  // already-fired embeddingPromise instead of a broad Se search.
  let validationSkipped = false;
  let validationSkipReason = "";
  const weakIds = [...new Set(
    allResults
      .filter((h) => h.source?.startsWith("Sf") && h.id !== undefined && !isStrongLexicalMatch(h.content, params.translated))
      .map((h) => h.id!),
  )].slice(0, VALIDATE_MAX_CANDIDATES);
  if (weakIds.length > 0) {
    if (embeddingPromise) {
      const queryVector = await withValidationTimeout(embeddingPromise, validationWaitMs());
      if (queryVector) {
        try {
          const vis = sharedOrOwnedClause("", params.userId, effectiveMaxClassification(params.maxClassification));
          const ph = weakIds.map(() => "?").join(",");
          const rows = deps.db.prepare(
            `SELECT id, embedding FROM extracted_memories WHERE id IN (${ph}) AND ${vis.sql}`,
          ).all(...weakIds, ...vis.params) as Array<{ id: number; embedding: Buffer | null }>;
          const demote = new Set<number>();
          for (const row of rows) {
            // No stored vector is unavailable evidence, never evidence against.
            if (!row.embedding || row.embedding.byteLength % 4 !== 0) continue;
            const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
            if (stored.length !== queryVector.length || stored.length === 0) continue;
            if (cosineSimilarity(queryVector, stored) < VALIDATE_COSINE_FLOOR) demote.add(row.id);
          }
          for (const hit of allResults) {
            if (hit.id !== undefined && demote.has(hit.id)) hit.score *= WEAK_DEMOTE_FACTOR;
          }
          logTrace(TAG, `validation: ${weakIds.length} weak candidates checked, demoted=[${[...demote].join(",")}]`);
        } catch (err) { logTrace(TAG, `validation query failed: ${err instanceof Error ? err.message : String(err)}`); }
      } else {
        validationSkipped = true;
        validationSkipReason = "query vector unavailable (timeout or provider failure)";
      }
    } else {
      validationSkipped = true;
      validationSkipReason = "no embedding provider";
    }
  }
  if (validationSkipped) {
    const seStage = stages["Se"];
    if (seStage) seStage.validationSkipped = true;
    else stages["Se"] = { hits: [], ms: 0, validationSkipped: true };
    logTrace(TAG, `validation skipped: ${validationSkipReason}`);
  }

  const boosted = params.currentContext ? applyContextBoost(allResults, params.currentContext) : allResults;
  const emotionBoosted = applyEmotionBoost(boosted, deps.db);
  const spaced = applySpacingBoost(emotionBoosted, deps.db);
  const qualityAdjusted = applyQualityBoost(spaced, deps.db);
  if (isLogLevel("debug")) {
    // Boosts return new arrays; allResults keeps pre-boost scores, so a
    // positional diff counts per-stage applications without signature changes.
    const changedVs = (after: RecallHit[]): number =>
      after.filter((h, i) => h.score !== allResults[i]?.score).length;
    logDebug(TAG, `boosts: context=${params.currentContext ? changedVs(boosted) : 0} emotion=${changedVs(emotionBoosted)} spacing=${changedVs(spaced)} quality=${changedVs(qualityAdjusted)} of ${allResults.length}`);
  }
  if (isLogLevel("trace")) {
    // Per-hit deltas, bounded: first 10 changed hits per stage.
    const deltas = (label: string, after: RecallHit[]): void => {
      const parts: string[] = [];
      for (let i = 0; i < after.length && parts.length < 10; i++) {
        const before = allResults[i]?.score;
        const cur = after[i]?.score;
        if (before !== undefined && cur !== undefined && before !== cur) {
          parts.push(`${after[i]?.id ?? "?"}:${before.toFixed(3)}>${cur.toFixed(3)}`);
        }
      }
      if (parts.length > 0) logTrace(TAG, `boost-${label}: ${parts.join(" ")}`);
    };
    if (params.currentContext) deltas("context", boosted);
    deltas("emotion", emotionBoosted);
    deltas("spacing", spaced);
    deltas("quality", qualityAdjusted);
  }
  // #1835 — sort by final relevance before MMR so the first pick is the top
  // hit; MMR then diversifies near-duplicates only (stable sort keeps merged
  // priority order on ties).
  qualityAdjusted.sort((a, b) => b.score - a.score);
  const mmrBefore = isLogLevel("trace") ? qualityAdjusted.slice(0, 5).map((h) => h.id ?? h.source) : [];
  const reranked = applyMMR(qualityAdjusted, 0.7);
  if (isLogLevel("trace")) {
    const mmrAfter = reranked.slice(0, 5).map((h) => h.id ?? h.source);
    const moved = mmrAfter.filter((id, i) => id !== mmrBefore[i]).length;
    if (moved > 0) logTrace(TAG, `mmr: reordered ${moved}/5 top (λ=0.7)`);
  }
  // #1812 — optional System One rerank of the MMR prefix; no-op when the
  // provider is absent or SYSTEM1_RECALL is off. No DB writes in this stage.
  // #1813 — the rerank observes the shared foreground judgment budget (R5):
  // it receives what remains of the single system1TimeoutMs deadline so the
  // later repeat/lookup checks keep their share.
  const rerankBudgetMs = Math.max(0, getAbmindEnv().system1TimeoutMs - (Date.now() - searchStart));
  const judged = await applyJudgmentRerank(
    reranked,
    { db: deps.db, judgmentProvider: deps.judgmentProvider },
    params,
    { timeoutMs: rerankBudgetMs },
  );
  const finalResults = await enrichResults(
    judged.slice(0, limit),
    deps.db,
    params.userId,
    effectiveMaxClassification(params.maxClassification),
  );

  // --- Logging ---
  const totalMs = Object.values(stages).reduce((s, st) => s + st.ms, 0);
  logDebug(TAG, `query="${redactSecrets(query).slice(0, 60)}" → ${finalResults.length} results (${totalMs.toFixed(0)}ms) stages: ${Object.entries(stages).map(([k, v]) => `${k}:${v.hits.length}`).join(" ")} ids=[${finalResults.filter((h) => h.id !== undefined).map((h) => h.id).join(",")}]`);
  if (sfFull) logTrace(TAG, `short-circuited after Sf (${sfHits.length} hits filled limit=${limit})`);

  // --- Track recalls (spacing effect #244) ---
  if (extractedIds.length > 0 && params.trackRecalls !== false) {
    const now = Date.now();
    const ph = extractedIds.map(() => "?").join(",");
    const recallVisibility = sharedOrOwnedClause(
      "",
      params.userId,
      effectiveMaxClassification(params.maxClassification),
    );
    deps.db.prepare(
      `UPDATE extracted_memories SET recall_count = recall_count + 1, last_recalled_at = ?
       WHERE id IN (${ph}) AND ${recallVisibility.sql}`
    ).run(now, ...extractedIds, ...recallVisibility.params);
    // Append timestamps for spacing boost
    for (const id of extractedIds) {
      const row = deps.db.prepare(
        `SELECT recall_timestamps FROM extracted_memories
         WHERE id = ? AND ${recallVisibility.sql}`,
      ).get(id, ...recallVisibility.params) as { recall_timestamps: string | null } | undefined;
      if (!row) continue;
      const ts: number[] = JSON.parse(row?.recall_timestamps ?? "[]");
      ts.push(now);
      if (ts.length > 20) ts.shift();
      deps.db.prepare(
        `UPDATE extracted_memories SET recall_timestamps = ?
         WHERE id = ? AND ${recallVisibility.sql}`,
      ).run(JSON.stringify(ts), id, ...recallVisibility.params);
    }
  }

  // #1813 — optional fast-path decision envelope over the final results.
  // Absent by default: decideFastPath returns null without intent, provider,
  // FASTPATH flag, passing profile, or remaining budget, and the field stays
  // off the result so ordinary consumers see no change.
  let decision: RecallDecisionV1 | undefined;
  if (params.fastPath && deps.judgmentProvider) {
    const { decideFastPath } = await import("./recall-decisions.js");
    decision = (await decideFastPath(
      finalResults,
      { db: deps.db, judgmentProvider: deps.judgmentProvider, turnScopes: deps.turnScopes },
      params,
      { deadlineMs: searchStart + getAbmindEnv().system1TimeoutMs },
    )) ?? undefined;
    logDebug(TAG, `fast-path decision: ${decision?.outcome ?? "none"} profile=${decision?.profile ?? "n/a"} set=${decision?.questionSet ?? "n/a"}`);
  }

  return {
    results: finalResults,
    stages,
    shortCircuitAfter: sfFull ? "Sf" : null,
    extractedIds,
    ...(decision !== undefined ? { decision } : {}),
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
        logTrace(TAG, `enrich: timelines attached to ${enriched.filter((h) => h.timelineContext !== undefined).length}/${enriched.length} hits`);
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
    const flagged = enriched.filter((h) => h.interferenceWarning !== undefined).length;
    if (flagged > 0) logTrace(TAG, `enrich: interference warnings on ${flagged}/${enriched.length} hits`);
  } catch (err) { logTrace(TAG, `enrich: interference detection skipped (${err instanceof Error ? err.message : String(err)})`); }

  // Compress-field enrichment: fetch topic, emotion_tags, importance_flags, confidence for ABM-L rendering
  const idsToEnrich = enriched.filter(h => h.id !== undefined).map(h => h.id!);
  if (idsToEnrich.length > 0) {
    try {
      const placeholders = idsToEnrich.map(() => "?").join(",");
      const vis = sharedOrOwnedClause("", principalUserId, maxClassification);
      const rows = db.prepare(
        `SELECT id, topic, emotion_tags, importance_flags, confidence, created_at
         FROM extracted_memories WHERE id IN (${placeholders}) AND ${vis.sql}`,
      ).all(...idsToEnrich, ...vis.params) as Array<{ id: number; topic: string | null; emotion_tags: string | null; importance_flags: string | null; confidence: number | null; created_at: number }>;
      const byId = new Map(rows.map(r => [r.id, r]));
      let compressFilled = 0;
      for (const hit of enriched) {
        const row = hit.id !== undefined ? byId.get(hit.id) : undefined;
        if (row) {
          hit.topic = row.topic ?? undefined;
          hit.emotionTags = row.emotion_tags ?? undefined;
          hit.importanceFlags = row.importance_flags ?? undefined;
          hit.confidence = row.confidence ?? undefined;
          hit.createdAt = row.created_at;
          compressFilled++;
        }
      }
      logTrace(TAG, `enrich: compress fields filled for ${compressFilled}/${idsToEnrich.length} ids`);
    } catch (err) { logTrace(TAG, `enrich: compress-field query failed (${err instanceof Error ? err.message : String(err)})`); }
  }

  return enriched;
}
