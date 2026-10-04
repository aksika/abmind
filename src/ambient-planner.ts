/**
 * ambient-planner — deterministic abmind-owned ambient recall planning (#1908).
 *
 * One planner for ambient lifecycle/recall and maintained hook routes. Inputs
 * are the raw turn, the authenticated principal, visibility/output policy,
 * and optional trusted conversation context. Raw-turn callers never need to
 * invent keyword queries: supplied ambient query material is a declared
 * bounded hint, measured under the same corpus rules, never host-owned
 * recall policy. Explicit keyword recall bypasses this module entirely.
 *
 * No word lists, stopwords, language detection, or model-generated search
 * text. Informativeness comes from scoped corpus document frequency through
 * the shared classifyRawTurn chain (English df first, source-index df for
 * terms the English index cannot see); unseen terms, small corpora, and
 * incomplete/failed measurements search conservatively. Full source text is
 * retained separately for semantic retrieval.
 */

import type Database from "better-sqlite3";
import { classifyRawTurn, extractSignificantTerms } from "./trigram-search.js";
import type { SfOptions } from "./trigram-search.js";
import type { RecallSkipReason } from "./recall-engine.js";
import { logDebug } from "./mem-logger.js";

const TAG = "ambient-planner";

/** Initial scoped context bounds: at most four completed prior turns and
 * 8 KiB of combined context/hint UTF-8 text, within existing request limits.
 * Fitted smaller on development cases if needed, then frozen for evaluation.
 */
export const AMBIENT_MAX_CONTEXT_TURNS = 4;
export const AMBIENT_CONTEXT_HINT_BUDGET_BYTES = 8192;

/** Contextual rank weight: strictly below the raw contribution of 1.
 * Development initial value, frozen before held-out evaluation (#1908 M3). */
export const AMBIENT_CONTEXT_RANK_WEIGHT = 0.5;

/** Closed context-rejection vocabulary so callers log it verbatim. */
export type AmbientContextRejection =
  | "foreign-principal"
  | "foreign-host"
  | "foreign-conversation"
  | "stale-generation"
  | "unverifiable-bounds"
  | "current-execution"
  | "incomplete"
  | "checkpoint-only"
  | "over-budget"
  | "uninformative";

/** A host-supplied completed-turn snapshot: conversation text as evidence,
 * never authority. Identity binds to the current turn; anything else rejects.
 */
export interface AmbientContextOption {
  /** Verbatim completed-turn text (user and assistant turns). */
  readonly text: string;
  readonly principal: string;
  readonly host: string;
  readonly conversation: string;
  /** Reset generation of the turn; must equal the current generation.
   * Absent means 0 on both sides (the ExecutionIdentity default). */
  readonly generation?: number;
  /** Completed execution this text belongs to; must be present and differ
   * from the current execution. */
  readonly executionId?: string;
  /** True only for completed turns, never checkpoints or partial text. */
  readonly complete: boolean;
  /** Checkpoint-only evidence never establishes scope. */
  readonly checkpointOnly?: boolean;
  /** 0 = most recent. The newest eligible option wins deterministically. */
  readonly recencyRank: number;
}

export interface AmbientPlanScope {
  readonly limit: number;
  readonly maxClassification: number;
  readonly timeStart?: number;
  readonly timeEnd?: number;
  readonly topic?: string;
  readonly tier?: string;
  readonly emotion?: string;
  readonly includeExpired?: boolean;
  readonly resolution?: string;
}

export interface AmbientPlanInput {
  readonly db: Database.Database;
  readonly rawTurn?: string;
  readonly userId: string;
  /** Declared bounded hints (supplied ambient query/priming material). */
  readonly hints?: readonly string[];
  readonly contextOptions?: readonly AmbientContextOption[];
  /** Current-turn identity that context must bind to. */
  readonly current?: {
    readonly host: string;
    readonly conversation: string;
    readonly generation?: number;
    readonly executionId?: string;
  };
  readonly scope: AmbientPlanScope;
}

/** Content-free planner diagnostics for the result boundary. */
export interface AmbientPlanDiagnostics {
  /** Which contributions the turn uses. */
  readonly plans: "raw" | "raw+context";
  readonly rawTermsTotal: number;
  readonly rawTermsInformative: number;
  readonly hintsTotal: number;
  readonly hintsInformative: number;
  readonly contextConsidered: number;
  readonly contextEligible: number;
  readonly contextRejected: Readonly<Record<AmbientContextRejection, number>>;
  /** Full-text input chosen for the single embedding/signature scan. */
  readonly semanticSource: "raw" | "context" | "fallback";
  readonly skipReason?: RecallSkipReason;
}

export interface AmbientPlan {
  /** Final raw lexical terms (raw-turn extraction plus informative hints). */
  readonly rawTerms: string[];
  /** Second lexical plan from the selected completed turn, if any. */
  readonly contextTerms: readonly string[] | null;
  readonly contextText: string | null;
  /** The one full-text input for semantic/signature retrieval. */
  readonly semanticText: string;
  readonly diagnostics: AmbientPlanDiagnostics;
  readonly skip: boolean;
  readonly skipReason?: RecallSkipReason;
}

function emptyRejections(): Record<AmbientContextRejection, number> {
  return {
    "foreign-principal": 0,
    "foreign-host": 0,
    "foreign-conversation": 0,
    "stale-generation": 0,
    "unverifiable-bounds": 0,
    "current-execution": 0,
    "incomplete": 0,
    "checkpoint-only": 0,
    "over-budget": 0,
    "uninformative": 0,
  };
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function scopeFor(input: AmbientPlanInput, translated: readonly string[]): SfOptions {
  return {
    translated: [...translated],
    userId: input.userId,
    limit: input.scope.limit,
    maxClassification: input.scope.maxClassification,
    timeStart: input.scope.timeStart,
    timeEnd: input.scope.timeEnd,
    topic: input.scope.topic,
    tier: input.scope.tier,
    emotion: input.scope.emotion,
    includeExpired: input.scope.includeExpired,
    resolution: input.scope.resolution,
  };
}

/**
 * Keep the informative terms under the shared corpus rules. Each term is
 * judged alone through classifyRawTurn (English df first, source-index df
 * for accented/non-Latin terms): a complete all-common measure drops the
 * term, while unseen terms, small corpora, and failed measures keep it.
 * Returns the kept terms plus whether every term measured over-common —
 * the only case that may contribute to a skip.
 */
function keepInformativeTerms(
  db: Database.Database,
  scope: SfOptions,
  terms: readonly string[],
): { kept: string[]; total: number; allCommon: boolean; measured: boolean } {
  const normalized = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  const kept: string[] = [];
  let measured = false;
  for (const term of normalized) {
    const verdict = classifyRawTurn(db, scope, term);
    if (verdict.ceiling > 0) measured = true;
    if (!verdict.skip) kept.push(term);
  }
  // allCommon needs a complete over-common measure for every term: a single
  // term classifies skip only on complete evidence, so an empty kept set
  // over a non-empty input means every term measured common.
  const allCommon = normalized.length > 0 && kept.length === 0;
  return { kept, total: normalized.length, allCommon, measured };
}

/**
 * Check one option against the current turn's identity bounds. Returns the
 * rejection code, or null when the option is eligible. Neither rendered
 * prompts nor group buffers establish scope — only bound identity does.
 *
 * Generation defaults to 0 on both sides (the documented ExecutionIdentity
 * default): a reset must bump it, and any mismatch rejects. An absent
 * execution can never prove it is not the current turn, so it rejects.
 * This compares caller-supplied snapshot bindings only; it does not read
 * stored history and implements none of #1910's persisted-key fix.
 */
function rejectOption(
  option: AmbientContextOption,
  userId: string,
  current: AmbientPlanInput["current"],
): AmbientContextRejection | null {
  if (option.principal !== userId) return "foreign-principal";
  if (option.complete !== true) return "incomplete";
  if (option.checkpointOnly) return "checkpoint-only";
  if (!current) return "unverifiable-bounds";
  if (option.host !== current.host) return "foreign-host";
  if (option.conversation !== current.conversation) return "foreign-conversation";
  if ((option.generation ?? 0) !== (current.generation ?? 0)) return "stale-generation";
  if (option.executionId === undefined || current.executionId === undefined
    || option.executionId === current.executionId) {
    return "current-execution";
  }
  // Wire input is unknown: a non-string or blank text can never establish a
  // plan. Anything malformed is treated as missing evidence, never trusted.
  if (typeof option.text !== "string" || !option.text.trim()) return "incomplete";
  return null;
}

/** Budget check shared by context selection and the skip measurement: an
 * over-budget option cannot contribute, so it is ineligible in both. */
function isOverBudget(option: AmbientContextOption, hintBytes: number): boolean {
  const text = typeof option.text === "string" ? option.text : "";
  return hintBytes + utf8Bytes(text) > AMBIENT_CONTEXT_HINT_BUDGET_BYTES;
}

/**
 * Deterministically select at most one contextual plan: the newest eligible
 * completed turn within the turn count and byte budget whose text carries at
 * least one informative term. A selected-but-uninformative option is not a
 * plan — it is reported and the turn stays raw-only.
 */
function selectContext(
  db: Database.Database,
  input: AmbientPlanInput,
  scope: SfOptions,
  hintBytes: number,
  rejected: Record<AmbientContextRejection, number>,
): { terms: string[]; text: string; measurable: boolean } | null {
  const options = [...(input.contextOptions ?? [])]
    .sort((a, b) => a.recencyRank - b.recencyRank)
    .slice(0, AMBIENT_MAX_CONTEXT_TURNS);
  for (const option of options) {
    const rejection = rejectOption(option, input.userId, input.current);
    if (rejection !== null) {
      rejected[rejection]++;
      continue;
    }
    if (isOverBudget(option, hintBytes)) {
      rejected["over-budget"]++;
      continue;
    }
    const text = option.text.trim();
    const extracted = extractSignificantTerms([text]);
    const { kept, measured } = keepInformativeTerms(db, scope, extracted);
    if (kept.length === 0) {
      rejected["uninformative"]++;
      continue;
    }
    return { terms: kept, text, measurable: measured };
  }
  return null;
}

/**
 * Plan one ambient turn: raw extraction, hint measurement, eligible context,
 * combined skip, and the single semantic input. Deterministic for identical
 * inputs; the only I/O is scoped df reads on the caller's connection.
 */
export function planAmbientRecall(input: AmbientPlanInput): AmbientPlan {
  const scope = scopeFor(input, []);
  const rejected = emptyRejections();

  const rawTurn = input.rawTurn?.trim() ?? "";
  const rawExtracted = rawTurn ? extractSignificantTerms([rawTurn]) : [];
  const raw = keepInformativeTerms(input.db, scope, rawExtracted);

  const hints = [...(input.hints ?? [])].map((h) => h.trim()).filter((h) => h.length > 0);
  const hintBytes = hints.reduce((sum, h) => sum + utf8Bytes(h), 0);
  // Hints stay conservative: the same per-term chain judges them, so an
  // unmeasurable corpus or a failed measure keeps every hint, and hints can
  // never manufacture a skip on their own.
  const hintJudged = keepInformativeTerms(input.db, scope, hints);

  const context = selectContext(input.db, input, scope, hintBytes, rejected);

  // Raw plan: raw-turn extraction plus informative hints, deduplicated
  // case-insensitively in first-seen order. Hints cannot bypass df
  // selection, but informative ones join the raw contribution. When every
  // term measures common yet the turn still searches (no skip), the
  // extracted set is retained unfiltered — selection is never a second
  // skip gate that manufactures an empty query.
  const seen = new Set<string>();
  const rawTerms: string[] = [];
  for (const term of [...raw.kept, ...hintJudged.kept]) {
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rawTerms.push(term);
  }
  if (rawTerms.length === 0) {
    const extracted = [...rawExtracted, ...hints];
    for (const term of extracted) {
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rawTerms.push(term);
    }
  }

  // Combined skip: complete over-common-term measurements for the raw turn,
  // the declared hints, and every eligible context option under the same
  // scope. Missing evidence searches; an over-budget option is ineligible
  // (it cannot contribute) and therefore cannot block or justify a skip.
  const rawVerdict = rawTurn ? classifyRawTurn(input.db, scope, rawTurn) : null;
  const rawCommon = rawVerdict !== null && rawVerdict.skip;
  const hintsCommon = hints.length === 0 || hintJudged.allCommon;
  let contextCommon = true;
  const considered = [...(input.contextOptions ?? [])]
    .sort((a, b) => a.recencyRank - b.recencyRank)
    .slice(0, AMBIENT_MAX_CONTEXT_TURNS);
  let consideredEligible = 0;
  for (const option of considered) {
    if (rejectOption(option, input.userId, input.current) !== null) continue;
    if (isOverBudget(option, hintBytes)) continue;
    consideredEligible++;
    const verdict = classifyRawTurn(input.db, scope, option.text);
    if (!verdict.skip) { contextCommon = false; break; }
  }
  const skip = rawTurn.length > 0 && rawCommon && hintsCommon && contextCommon;

  // One semantic input: informative raw text first (a topic switch keeps
  // its own input, never diluted with earlier context), otherwise the
  // measurably informative selected context. When neither measurement is
  // conclusive, the raw text is the conservative fallback (design: use raw
  // when neither side has measurable informativeness).
  const rawMeasured = rawVerdict !== null && rawVerdict.ceiling > 0;
  const rawInformative = rawMeasured && !rawVerdict.skip;
  let semanticText = rawTurn;
  let semanticSource: AmbientPlanDiagnostics["semanticSource"] = "raw";
  if (!rawInformative && context !== null && context.measurable) {
    semanticText = context.text;
    semanticSource = "context";
  } else if (!rawTurn) {
    semanticText = context?.text ?? hints.join(" ");
    semanticSource = context !== null ? "context" : "fallback";
  }

  const diagnostics: AmbientPlanDiagnostics = {
    plans: context !== null ? "raw+context" : "raw",
    rawTermsTotal: raw.total,
    rawTermsInformative: raw.kept.length,
    hintsTotal: hints.length,
    hintsInformative: hintJudged.kept.length,
    contextConsidered: considered.length,
    contextEligible: consideredEligible,
    contextRejected: rejected,
    semanticSource,
    ...(skip ? { skipReason: "no-informative-terms" as const } : {}),
  };

  if (skip) {
    logDebug(TAG, `search skipped: raw, hints, and ${consideredEligible} eligible context option(s) all over-common`);
  }

  return {
    rawTerms,
    contextTerms: context?.terms ?? null,
    contextText: context?.text ?? null,
    semanticText,
    diagnostics,
    skip,
    ...(skip ? { skipReason: "no-informative-terms" as const } : {}),
  };
}
