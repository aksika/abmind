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
 * #1861 — every requested and available stage runs regardless of how many
 * candidates Sf returned; stage participation is reported through
 * `stageOutcomes`, and weak evidence through `weakEvidence`.
 * S6 always runs (different data source).
 * No S7 fallback — return empty on zero results.
 */

import type Database from "better-sqlite3";
import type { MemoryIndex } from "./memory-index.js";
import { searchConsolidationFiles } from "./consolidation-search.js";
import { applyMMR } from "./mmr.js";
import { vectorSearch, cosineSimilarity } from "./ollama-embed.js";
import { getAbmindEnv } from "./env-schema.js";
import { trigramSearch, hasTokenBoundaryMatch, classifyQueryTerms, classifyRawTurn } from "./trigram-search.js";
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
   * could not run (no provider, embeddings disabled, or the Se wait was
   * interrupted by its deadline). #1861 folds validation into the Se result,
   * so this stays false whenever the query vector arrived inside the budget. */
  validationSkipped?: boolean;
};

/** #1861 — how a requested stage ended. `completed` includes zero hits. */
export type RecallStageStatus =
  | "completed"
  | "not-requested"
  | "disabled"
  | "no-provider"
  | "deadline"
  | "failed";

/** #1861 — `hitCount` counts the stage's unique candidates before cross-stage
 * deduplication, so an overlapping stage still reports the evidence it found. */
export type RecallStageOutcome = {
  readonly status: RecallStageStatus;
  readonly hitCount: number;
};

export type RecallStageOutcomes = Record<string, RecallStageOutcome>;

export type RecallResult = {
  results: RecallHit[];
  stages: Record<string, StageResult>;
  /** Legacy: retains its old value, but no longer implies that any stage was
   * suppressed. `stageOutcomes` is authoritative for stage participation. */
  shortCircuitAfter: string | null;
  extractedIds: number[];
  /** #1861 — per-stage outcome keyed by stage name (Sf, Se, Ss, S6, S8),
   * always populated by recallSearch. Optional for source compatibility with
   * existing result literals. */
  stageOutcomes?: RecallStageOutcomes;
  /** #1861 — advisory: every stage candidate lacked either an exact
   * token-boundary match for all supplied translated keywords or an above-
   * threshold Se/Ss similarity. A zero-hit search is weak. Never suppresses
   * results and never gates injection. */
  weakEvidence?: boolean;
  /** #1813 — optional version-1 fast-path decision envelope. Absent means
   * ordinary recall: no intent, no profile, or an abstention. */
  decision?: RecallDecisionV1;
  /** #1813 — deterministic bounded injection selection. Present whenever the
   * recall returned id-bearing results, independently of System One provider,
   * profile, or SYSTEM1_FASTPATH (see composeSelection). */
  selection?: RecallSelectionV1;
  /** #1877 — true when no stage ran because the query carried no informative
   * term for this user's corpus. Absent means an ordinary search. */
  searchSkipped?: boolean;
  /** #1877 — why the search was skipped, for the caller's turn log. */
  searchSkippedReason?: RecallSkipReason;
};

/** #1877 — skip reasons are a closed set so callers can log them verbatim. */
export type RecallSkipReason = "no-informative-terms";

/** #1813 — deterministic selection ref: verified id plus current semantic
 * revision at selection time. */
export interface RecallSelectionRef {
  readonly id: number;
  readonly revision: number;
}

/**
 * #1813 — deterministic compact-injection selection.
 *
 * Not a judgment: refs are the final ranked results (after whatever #1812
 * validly did), each re-verified owner-side against current visibility, taken
 * in rank order under a payload budget. No profile, flag, or backend is
 * involved, and there are no new model calls. The full `results` array stays
 * intact, so an explicit expansion path always exists for callers.
 */
export interface RecallSelectionV1 {
  readonly version: 1;
  readonly refs: readonly RecallSelectionRef[];
  /** UTF-8 byte budget the refs were bounded by. */
  readonly budgetBytes: number;
  /** True when at least one verified result was left out for the budget. */
  readonly truncated: boolean;
}

/**
 * Initial conservative payload budget for selection. Aligned with the hook
 * context cap convention (2000); a starting constant to be tuned from A1
 * measurement, not a fitted threshold.
 */
export const SELECTION_BUDGET_BYTES = 2000;

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

/**
 * #1895 — recall intent: who chose the query terms.
 *
 * - `ambient`: the turn is automatic context gathering. The engine may select
 *   informative translated terms by corpus df, and the raw-turn skip is
 *   eligible when `original` carries complete measurable evidence.
 * - `explicit`: the caller chose deliberate keywords. The engine always
 *   searches, preserves the supplied keyword array verbatim (no df selection,
 *   no model-artifact boolean rewrite), and never skips.
 *
 * Absent intent defaults to ambient. `selectTerms: true` without intent is
 * the deprecated ambient alias (retained through `0.4.x`); a valid intent
 * wins over either alias value. `selectTerms: false` does not override the
 * ambient default. An invalid supplied intent is a caller bug: the engine
 * runs a conservative search (skip and selection disabled) rather than
 * failing the turn.
 */
export type RecallIntent = "ambient" | "explicit";

export type RecallParams = {
  translated: string[];
  original?: string;
  userId: string;
  limit?: number;
  maxClassification?: number;
  timeStart?: number;
  timeEnd?: number;
  stages?: string[];
  /** #1895 — which contract governs this recall (see RecallIntent). */
  intent?: RecallIntent;
  /** #1867 — deprecated ambient alias through `0.4.x`: drop uninformative
   * supplied translated terms before any stage runs. Valid `intent` wins over
   * this flag; absent intent (with or without this flag) is ambient. New
   * callers pass `intent` instead. */
  selectTerms?: boolean;
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
/** #1861 — default Se query-embedding wait budget (env-overridable). */
const SE_WAIT_MS_DEFAULT = 250;
/** #1861 — default Ss scoring budget in rows (env-overridable), not a recency window. */
const SS_SCAN_MAX_ROWS = 5000;

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
 * #1835/#1861 — strong literal match: every supplied keyword occurs in the
 * content at a token boundary (diacritic/case folds allowed; trailing
 * characters allowed so an inflection like `dogs` still matches `dog`).
 * Conservative by construction: a missed strong hit still ranks by fusion, it
 * just gets no floor. A mid-token collision (`dog` in `watchdog`) never counts.
 */
export function isStrongLexicalMatch(content: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return false;
  return keywords.every((kw) => kw.length > 0 && hasTokenBoundaryMatch(content, kw));
}

/** #1861 — Se query-embedding wait budget; env-overridable for deterministic tests. */
function seWaitMs(): number {
  const raw = parseInt(process.env["RECALL_SE_WAIT_MS"] ?? String(SE_WAIT_MS_DEFAULT), 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : SE_WAIT_MS_DEFAULT;
}

/** #1861 — Ss per-recall scoring budget in rows; env-overridable for tests. */
function ssScanMaxRows(): number {
  const raw = parseInt(process.env["RECALL_SS_SCAN_ROWS"] ?? String(SS_SCAN_MAX_ROWS), 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : SS_SCAN_MAX_ROWS;
}

/** #1861 — outcome of waiting for the Se query embedding. */
type EmbeddingBudgetResult =
  | { readonly state: "ready"; readonly vector: Float32Array }
  | { readonly state: "failed" }
  | { readonly state: "deadline" };

/**
 * #1861 — bound the Se embedding await. Resolves `ready` with the vector,
 * `failed` on provider failure, or `deadline` when the budget expires first;
 * the timer is unref'd and a late settlement is ignored, so the abandoned
 * provider promise never produces an unhandled rejection.
 */
function awaitEmbeddingBudget(
  promise: Promise<Float32Array | null>,
  ms: number,
): Promise<EmbeddingBudgetResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ state: "deadline" });
    }, ms);
    (timer as unknown as { unref?: () => void }).unref?.();
    promise.then(
      (vector) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(vector ? { state: "ready", vector } : { state: "failed" });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ state: "failed" });
      },
    );
  });
}

// ── Engine ──────────────────────────────────────────────────────────────────

/**
 * #1877 — result of a search that was never run because no supplied term was
 * informative. Pure omission: no candidates, no stage work, and every stage
 * reported as not-requested. `weakEvidence` is true because a search with no
 * discriminating term is by definition weak.
 */
function skippedResult(reason: RecallSkipReason): RecallResult {
  const stages: Record<string, StageResult> = {};
  const stageOutcomes: RecallStageOutcomes = {};
  for (const stage of ALL_STAGES) {
    stages[stage] = { hits: [], ms: 0 };
    stageOutcomes[stage] = { status: "not-requested", hitCount: 0 };
  }
  return {
    results: [], stages, shortCircuitAfter: null, extractedIds: [],
    stageOutcomes, weakEvidence: true, searchSkipped: true, searchSkippedReason: reason,
  };
}

/**
 * #1895 — normalize the recall intent before any query handling. Valid intent
 * wins over the deprecated alias; absent intent (with or without the alias)
 * is the ambient default; an invalid supplied intent is reported so the
 * caller runs a conservative search with skip and selection disabled.
 */
export function normalizeRecallIntent(params: Pick<RecallParams, "intent" | "selectTerms">): { intent: RecallIntent; valid: boolean } {
  const raw = params.intent;
  if (raw === "ambient" || raw === "explicit") return { intent: raw, valid: true };
  if (raw === undefined) return { intent: "ambient", valid: true };
  return { intent: "ambient", valid: false };
}

/**
 * #1894 — original-turn normalization shared by full recall and the cheap
 * worth-retrieving check: the tool path sends model queries as original too,
 * so both verdicts must classify the same turn.
 */
function normalizeOriginalTurn(original: string | undefined): string | undefined {
  if (original && /\bOR\b|\bAND\b/.test(original)) {
    return original.replace(/\bOR\b|\bAND\b|\bNOT\b/g, " ").replace(/["']/g, "").trim();
  }
  return original;
}

export type WorthRetrievingParams = {
  original?: string;
  userId: string;
  intent?: RecallIntent;
  selectTerms?: boolean;
  limit?: number;
  maxClassification?: number;
  timeStart?: number;
  timeEnd?: number;
  topic?: string;
  tier?: "core" | "general";
  emotion?: string;
  includeExpired?: boolean;
  resolution?: "signal" | "compact" | "standard" | "full";
};

export type WorthRetrievingResult = {
  /** "skip" only when the measure ran completely and every candidate exceeded the ceiling. */
  verdict: "skip" | "search";
  /** Eligible corpus size behind the measure; 0 when it did not run. */
  corpusSize: number;
  /** Applied df ceiling; 0 when the measure did not run. */
  ceiling: number;
};

/**
 * #1894 — cheap worth-retrieving judgment over the raw turn only. Applies
 * the same intent normalization, original-turn normalization, and effective
 * filter defaults as the full recall skip, then runs only `classifyRawTurn`:
 * no stages, no embedding, no System One, no LLM. Explicit or invalid intent
 * returns search without measuring. Sync: the df measures are direct SQLite
 * reads on the caller's connection.
 */
export function checkWorthRetrieving(db: Database.Database, params: WorthRetrievingParams): WorthRetrievingResult {
  const { intent, valid: intentValid } = normalizeRecallIntent(params);
  if (intent === "explicit" || !intentValid) return { verdict: "search", corpusSize: 0, ceiling: 0 };
  const verdict = classifyRawTurn(db, {
    translated: [],
    userId: params.userId,
    limit: params.limit ?? DEFAULT_LIMIT,
    maxClassification: params.maxClassification ?? 2,
    timeStart: params.timeStart,
    timeEnd: params.timeEnd,
    topic: params.topic,
    tier: params.tier,
    emotion: params.emotion,
    includeExpired: params.includeExpired,
    resolution: params.resolution,
  }, normalizeOriginalTurn(params.original));
  return { verdict: verdict.skip ? "skip" : "search", corpusSize: verdict.corpusSize, ceiling: verdict.ceiling };
}

export async function recallSearch(deps: RecallDeps, params: RecallParams): Promise<RecallResult> {
  // #1895 — intent normalizes before the model-artifact boolean rewrite.
  // Explicit keywords are caller data: no rewrite, no df selection, no skip.
  const { intent, valid: intentValid } = normalizeRecallIntent(params);
  const explicit = intent === "explicit";
  if (!explicit) {
    // Normalize: if translated contains boolean operators (model artifact), split into keywords
    if (params.translated.length === 1 && /\bOR\b|\bAND\b/.test(params.translated[0]!)) {
      params = { ...params, translated: params.translated[0]!
        .split(/\bOR\b|\bAND\b/)
        .map(s => s.replace(/\bNOT\b/g, "").replace(/^["']+|["']+$/g, "").trim())
        .filter(Boolean) };
    }
    // Same for original (tool path sends model query as original too)
    params = { ...params, original: normalizeOriginalTurn(params.original) };
  }

  const limit = params.limit ?? DEFAULT_LIMIT;
  const activeStages = new Set(params.stages ?? ALL_STAGES);
  // #1867/#1895 — ambient selection and skip are separate judgments over the
  // same eligible scope. The skip judges only the raw turn (`original`):
  // complete measurable evidence with every candidate over the df ceiling
  // means no stage can discriminate anything. Selection then drops
  // uninformative *supplied* terms; when it would drop every supplied term
  // the supplied set is retained and the search runs — selection is never a
  // second skip gate. Explicit and invalid-intent calls search as supplied.
  // #1877 — the skipped result stays a pure omission (see skippedResult).
  if (!explicit && intentValid) {
    const skipFilter = {
      translated: params.translated,
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
    const verdict = classifyRawTurn(deps.db, skipFilter, params.original);
    if (verdict.skip) {
      logDebug(TAG, `search skipped: raw turn has no informative term (df>${verdict.ceiling} of ${verdict.corpusSize})`);
      return skippedResult("no-informative-terms");
    }
    const classified = classifyQueryTerms(deps.db, skipFilter, params.translated);
    if (classified.kept.length > 0 && classified.kept.length < params.translated.length) {
      logDebug(TAG, `selectTerms: ${params.translated.length}→${classified.kept.length} terms`);
      params = { ...params, translated: classified.kept };
    }
  }
  const query = params.translated.join(" ");
  // #1813 — anchor for the shared foreground judgment deadline (R5): post-
  // rerank decisions observe the remaining system1TimeoutMs budget.
  const searchStart = Date.now();
  logDebug(TAG, `params: query="${redactSecrets(query).slice(0, 60)}" limit=${limit} stages=[${[...activeStages].join(",")}] maxClass=${params.maxClassification ?? 2} time=${params.timeStart ?? "-"}..${params.timeEnd ?? "-"} fastPath=${params.fastPath ? "yes" : "no"} ctx=${params.currentContext ? "yes" : "no"}`);

  const seenIds = new Set<number>();
  const extractedIds: number[] = [];
  const stages: Record<string, StageResult> = {};
  /** #1861 — per-stage outcomes. A requested stage starts as `failed`; every
   * execution path below overwrites it with its real outcome. */
  const stageOutcomes: RecallStageOutcomes = {};
  for (const stage of ALL_STAGES) {
    stageOutcomes[stage] = {
      status: activeStages.has(stage) ? "failed" : "not-requested",
      hitCount: 0,
    };
  }
  const setOutcome = (stage: string, status: RecallStageStatus, hitCount: number): void => {
    stageOutcomes[stage] = { status, hitCount };
  };
  /** #1835 — Se cosine rank by id, INCLUDING ids already seen from Sf. The Se
   * loop still adds only unseen ids as hits (dedup), but overlap is preserved
   * here as confirmation evidence instead of being discarded. */
  const seRankById = new Map<number, number>();
  /** #1861 — weak-evidence inputs, counted before final result truncation. */
  let seCandidateCount = 0;
  let ssAcceptedAboveThreshold = 0;
  /** #1861 — the Se query vector when it arrived inside the wait budget;
   * weak-candidate validation reuses it instead of racing a second deadline. */
  let seVector: Float32Array | null = null;

  // --- Se: fire the query embedding async at start ---
  // #1861 — availability is fixed once here. Se no longer depends on how many
  // Sf hits arrive; a disabled stage is reported as such instead of calling out.
  type SePreflight =
    | { readonly kind: "pending"; readonly promise: Promise<Float32Array | null> }
    | { readonly kind: "failed" }
    | { readonly kind: "disabled" }
    | { readonly kind: "no-provider" };
  let sePreflight: SePreflight | null = null;
  if (activeStages.has("Se")) {
    if (!getAbmindEnv().embeddingEnabled) {
      sePreflight = { kind: "disabled" };
    } else if (!deps.embeddingProvider) {
      sePreflight = { kind: "no-provider" };
    } else {
      try {
        sePreflight = { kind: "pending", promise: deps.embeddingProvider.embedText(query) };
      } catch {
        // A provider can violate its Promise contract by throwing before it
        // returns. Keep that failure local to Se so the other stages still run.
        sePreflight = { kind: "failed" };
      }
    }
  }

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
    try {
      const sf = trigramSearch(deps.db, sfOpts);
      for (const h of sf.hits) sfHits.push(h);
      for (const id of sf.extractedIds) { seenIds.add(id); extractedIds.push(id); }
      stages["Sf"] = { hits: sfHits, ms: elapsed(t) };
      setOutcome("Sf", "completed", sfHits.length);
      logTrace(TAG, `Sf: ${sfHits.length} hits from ${params.translated.length} keywords + original (${stages["Sf"].ms}ms)`);
    } catch (err) {
      // A failed stage must not take the turn down: report it and let the
      // remaining stages contribute.
      logWarn(TAG, `Sf stage failed: ${err instanceof Error ? err.message : String(err)}`);
      stages["Sf"] = { hits: sfHits, ms: elapsed(t) };
      setOutcome("Sf", "failed", sfHits.length);
    }
  }

  const sfFull = sfHits.length >= limit;

  // --- Se: full-history embedding cosine behind an explicit wait budget ---
  if (sePreflight !== null) {
    const t = performance.now();
    if (sePreflight.kind === "disabled") {
      logTrace(TAG, "Se skipped: embeddings disabled (EMBEDDING_ENABLED=false)");
      setOutcome("Se", "disabled", 0);
    } else if (sePreflight.kind === "no-provider") {
      logTrace(TAG, "Se skipped: no embedding provider");
      setOutcome("Se", "no-provider", 0);
    } else if (sePreflight.kind === "failed") {
      logWarn(TAG, "Se provider failed before returning a promise");
      setOutcome("Se", "failed", 0);
    } else {
      const waited = await awaitEmbeddingBudget(sePreflight.promise, seWaitMs());
      if (waited.state === "deadline") {
        logTrace(TAG, `Se deadline: query embedding not ready within ${seWaitMs()}ms`);
        setOutcome("Se", "deadline", 0);
      } else if (waited.state === "failed") {
        logTrace(TAG, "Se failed: provider returned no query vector");
        setOutcome("Se", "failed", 0);
      } else {
        seVector = waited.vector;
        try {
          const vecResults = vectorSearch(deps.db, seVector, {
            userId: params.userId, limit: limit * 3, threshold: getAbmindEnv().embeddingSimilarityThreshold,
            maxClassification: params.maxClassification ?? 2,
          });
          seCandidateCount = vecResults.length;
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
          setOutcome("Se", "completed", vecResults.length);
          logTrace(TAG, `Se: ${vecResults.length} candidates above threshold=${getAbmindEnv().embeddingSimilarityThreshold} → ${seHits.length} new hits (${stages["Se"].ms}ms)`);
        } catch (err) {
          logWarn(TAG, `Se search failed: ${err instanceof Error ? err.message : String(err)}`);
          setOutcome("Se", "failed", 0);
        }
      }
    }
  }

  // --- Ss: full-history signature Hamming within a per-recall work budget ---
  if (activeStages.has("Ss")) {
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

      // #1861 — the newest-500 cap is gone. The budget is a row budget, not a
      // recency window: rows are visited in a stable hash order, so a bounded
      // scan samples the whole eligible history instead of the newest slice.
      // Budget exhaustion is reported as the `deadline` outcome; Se remains
      // the exhaustive semantic path.
      const maxRows = ssScanMaxRows();
      type SsRow = {
        id: number; content_en: string | null; content_original: string | null;
        memory_type: string | null; created_at: number; signature: Buffer;
        semantic_revision: number;
      };
      const rows = deps.db.prepare(
        `SELECT id, content_en, content_original, memory_type, created_at, signature, semantic_revision
         FROM extracted_memories WHERE ${conditions.join(" AND ")}
         ORDER BY (id * 2654435761) % 2147483647 LIMIT ?`,
      ).all(...bindParams, maxRows + 1) as SsRow[];
      const truncated = rows.length > maxRows;
      const scanRows = truncated ? rows.slice(0, maxRows) : rows;

      const scored: Array<{ row: SsRow; sim: number }> = [];
      for (const row of scanRows) {
        const sig = new Uint8Array(row.signature);
        scored.push({ row, sim: hammingSimilarity(querySig, sig) });
      }
      scored.sort((a, b) => b.sim - a.sim);

      for (const { row, sim } of scored) {
        if (ssAcceptedAboveThreshold >= SS_CAP) break;
        if (sim < SS_THRESHOLD) break;
        ssAcceptedAboveThreshold++;
        if (seenIds.has(row.id)) continue;
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
      setOutcome("Ss", truncated ? "deadline" : "completed", ssAcceptedAboveThreshold);
      logTrace(TAG, `Ss: ${scanRows.length} rows scanned${truncated ? " (budget exhausted)" : ""}, ${scored.length} scored, ${ssAcceptedAboveThreshold} above threshold, ${ssHits.length} new hits (threshold=${SS_THRESHOLD}, cap=${SS_CAP})`);
    } catch (err) {
      logWarn(TAG, `Ss stage failed: ${err instanceof Error ? err.message : String(err)}`);
      setOutcome("Ss", "failed", ssHits.length);
    }
    stages["Ss"] = { hits: ssHits, ms: elapsed(t) };
  }

  // --- S6: Consolidation files (always runs) ---
  // #1863: scoped by requesting principal like every other stage — only
  // artifacts with verified owner provenance matching the requester are
  // returned. The consolidation directories are master-only, so a secondary
  // principal sees nothing from them.
  if (activeStages.has("S6")) {
    const t = performance.now();
    try {
      const allKw = [...params.translated];
      if (params.original) allKw.push(params.original);
      const consolidationResults = searchConsolidationFiles(deps.memoryDir, allKw, {
        startTime: params.timeStart, endTime: params.timeEnd,
        requesterUserId: params.userId,
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
      setOutcome("S6", "completed", s6Hits.length);
      logTrace(TAG, `S6: ${consolidationResults.length} file excerpts from ${allKw.length} keywords → ${s6Hits.length} hits (${elapsed(t)}ms)`);
    } catch (err) {
      logWarn(TAG, `S6 stage failed: ${err instanceof Error ? err.message : String(err)}`);
      setOutcome("S6", "failed", s6Hits.length);
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
      setOutcome("S8", "completed", s8Hits.length);
      logTrace(TAG, `S8: ${words.length} tokens, ${knownEntities.length} known entities → ${s8Hits.length} hits`);
    } catch (err) {
      logWarn(TAG, `S8 stage failed: ${err instanceof Error ? err.message : String(err)}`);
      setOutcome("S8", "failed", 0);
    }
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
    } catch (err) { logTrace(TAG, `fusion: age/emotion lookup failed (${err instanceof Error ? err.message : String(err)})`); }
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

  // --- #1835/#1861 Weak-candidate embedding validation (folded into Se) ---
  // Replaces the #505 blanket halving: only weak (partial/fuzzy, non-strong) Sf
  // hits are checked, and only against the query vector Se already resolved
  // inside its wait budget. There is no second deadline racing the same
  // promise; when Se was interrupted or unavailable the skip is reported.
  let validationSkipped = false;
  let validationSkipReason = "";
  const weakIds = [...new Set(
    allResults
      .filter((h) => h.source?.startsWith("Sf") && h.id !== undefined && !isStrongLexicalMatch(h.content, params.translated))
      .map((h) => h.id!),
  )].slice(0, VALIDATE_MAX_CANDIDATES);
  if (weakIds.length > 0) {
    if (seVector) {
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
          if (stored.length !== seVector.length || stored.length === 0) continue;
          if (cosineSimilarity(seVector, stored) < VALIDATE_COSINE_FLOOR) demote.add(row.id);
        }
        for (const hit of allResults) {
          if (hit.id !== undefined && demote.has(hit.id)) hit.score *= WEAK_DEMOTE_FACTOR;
        }
        logTrace(TAG, `validation: ${weakIds.length} weak candidates checked, demoted=[${[...demote].join(",")}]`);
      } catch (err) { logTrace(TAG, `validation query failed: ${err instanceof Error ? err.message : String(err)}`); }
    } else {
      validationSkipped = true;
      validationSkipReason = !activeStages.has("Se")
        ? "Se stage not requested"
        : sePreflight?.kind === "disabled"
          ? "embeddings disabled"
          : sePreflight?.kind === "no-provider"
            ? "no embedding provider"
            : "query vector unavailable (Se deadline or provider failure)";
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
    // Boosts return new arrays; compare each stage against its own input so
    // the counts are per-stage, not cumulative across the chain.
    const changed = (before: RecallHit[], after: RecallHit[]): number =>
      after.filter((h, i) => h.score !== before[i]?.score).length;
    logDebug(TAG, `boosts: context=${params.currentContext ? changed(allResults, boosted) : 0} emotion=${changed(boosted, emotionBoosted)} spacing=${changed(emotionBoosted, spaced)} quality=${changed(spaced, qualityAdjusted)} of ${allResults.length}`);
  }
  if (isLogLevel("trace")) {
    // Per-hit deltas, bounded: first 10 changed hits per stage.
    const deltas = (label: string, before: RecallHit[], after: RecallHit[]): void => {
      const parts: string[] = [];
      for (let i = 0; i < after.length && parts.length < 10; i++) {
        const prev = before[i]?.score;
        const cur = after[i]?.score;
        if (prev !== undefined && cur !== undefined && prev !== cur) {
          parts.push(`${after[i]?.id ?? "?"}:${prev.toFixed(3)}>${cur.toFixed(3)}`);
        }
      }
      if (parts.length > 0) logTrace(TAG, `boost-${label}: ${parts.join(" ")}`);
    };
    if (params.currentContext) deltas("context", allResults, boosted);
    deltas("emotion", boosted, emotionBoosted);
    deltas("spacing", emotionBoosted, spaced);
    deltas("quality", spaced, qualityAdjusted);
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

  // --- #1861 weak evidence (advisory; never suppresses or gates results) ---
  // Meaningful evidence is either an Sf candidate matching every supplied
  // translated keyword at a token boundary, or a Se/Ss candidate accepted
  // above its similarity threshold (including overlap with Sf). Zero hits is
  // weak. Candidates that qualify before the final `limit` truncation count.
  const sfEvidence = sfHits.some((hit) => isStrongLexicalMatch(hit.content, params.translated));
  const weakEvidence = !sfEvidence && seCandidateCount === 0 && ssAcceptedAboveThreshold === 0;

  // --- Logging ---
  const totalMs = Object.values(stages).reduce((s, st) => s + st.ms, 0);
  logDebug(TAG, `query="${redactSecrets(query).slice(0, 60)}" → ${finalResults.length} results (${totalMs.toFixed(0)}ms) stages: ${Object.entries(stages).map(([k, v]) => `${k}:${v.hits.length}`).join(" ")} ids=[${finalResults.filter((h) => h.id !== undefined).map((h) => h.id).join(",")}]`);
  logTrace(TAG, `outcomes: ${Object.entries(stageOutcomes).map(([k, v]) => `${k}:${v.status}/${v.hitCount}`).join(" ")} weakEvidence=${weakEvidence}`);

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

  // #1813 — deterministic selection over the final ranked results. Runs for
  // every recall (no provider/profile/flag involvement): the host injects the
  // bounded selection instead of every hit, and falls back to the full set
  // when selection is absent or cannot be trusted.
  const selection = composeSelection(
    finalResults,
    deps.db,
    params.userId,
    effectiveMaxClassification(params.maxClassification),
  );

  return {
    results: finalResults,
    stages,
    // Legacy value kept for compatibility; it no longer implies that any stage
    // was suppressed (see stageOutcomes).
    shortCircuitAfter: sfFull ? "Sf" : null,
    extractedIds,
    stageOutcomes,
    weakEvidence,
    ...(decision !== undefined ? { decision } : {}),
    ...(selection !== undefined ? { selection } : {}),
  };
}

/**
 * #1813 — compose the deterministic injection selection.
 *
 * Walks the final results in rank order, keeps rows in rank order, and skips
 * (never reorders around) a row whose content would exceed the remaining
 * budget, so a small constraint after a long row still fits. Rows whose id
 * does not re-verify under current visibility or that no longer exist are
 * never selected. When the whole verified set fits, the selection is the full
 * set and `truncated` is false — the host then injects exactly what it would
 * have injected before. Returns undefined when there is nothing selectable.
 */
function composeSelection(
  results: RecallHit[],
  db: Database.Database,
  principalUserId: string,
  maxClassification: number,
): RecallSelectionV1 | undefined {
  const idHits = results.filter((hit) => typeof hit.id === "number");
  if (idHits.length === 0) return undefined;

  const ids = idHits.map((hit) => hit.id as number);
  let revisions: Map<number, number>;
  try {
    const vis = sharedOrOwnedClause("", principalUserId, maxClassification);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT id, semantic_revision FROM extracted_memories WHERE id IN (${placeholders}) AND ${vis.sql}`,
    ).all(...ids, ...vis.params) as Array<{ id: number; semantic_revision: number | null }>;
    revisions = new Map(rows.map((row) => [row.id, row.semantic_revision ?? 0]));
  } catch (err) {
    // Verification must never fail recall; without it there is no selection.
    logTrace(TAG, `selection skipped (verification failed: ${err instanceof Error ? err.message : String(err)})`);
    return undefined;
  }

  const refs: RecallSelectionRef[] = [];
  let used = 0;
  let truncated = false;
  for (const hit of idHits) {
    const revision = revisions.get(hit.id as number);
    if (revision === undefined) continue;
    const size = Buffer.byteLength(hit.content, "utf8");
    if (used + size > SELECTION_BUDGET_BYTES) {
      truncated = true;
      continue;
    }
    refs.push({ id: hit.id as number, revision });
    used += size;
  }
  if (refs.length === 0) {
    // Nothing fit the budget: still hand the host its top verified row so a
    // compact injection is never silently empty.
    for (const hit of idHits) {
      const revision = revisions.get(hit.id as number);
      if (revision === undefined) continue;
      refs.push({ id: hit.id as number, revision });
      truncated = true;
      break;
    }
  }
  if (refs.length === 0) return undefined;
  logTrace(TAG, `selection: ${refs.length}/${idHits.length} refs, ${used}/${SELECTION_BUDGET_BYTES} bytes, truncated=${truncated}`);
  return { version: 1, refs, budgetBytes: SELECTION_BUDGET_BYTES, truncated };
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
