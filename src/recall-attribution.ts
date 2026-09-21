/**
 * recall-attribution.ts — #1813 post-response attribution operation.
 *
 * Judges the final delivered response against the authorized memories actually
 * supplied, returning per-source used/not-used/unknown with question/profile
 * provenance. Advisory only: failures and uncertainty report unknown, never a
 * negative, and no model judgment here changes confidence, usage rewards, or
 * truth. It never reruns retrieval, persists nothing, and leaves the existing
 * citation feedback path untouched.
 *
 * Gray zone: noul >= 0.6 is used, <= 0.4 is not-used, between is unknown. The
 * band is structural caution for an advisory signal, not a fitted gate.
 */

import type Database from "better-sqlite3";
import { getAbmindEnv } from "./env-schema.js";
import { logDebug } from "./mem-logger.js";
import { redactSecrets } from "./redact-secrets.js";
import { effectiveMaxClassification, sharedOrOwnedClause } from "./memory-visibility.js";
import { checkJudgmentEgress } from "./judgment-egress.js";
import { matchJudgmentProfile } from "./judgment-profiles.js";
import type { IJudgmentProvider, JudgmentQuestion } from "./judgment-provider.js";

/** Question-set version, shared with the harness fixtures. */
export const ATTRIBUTION_QUESTION_SET = "attribution-v1";

const USED_THRESHOLD = 0.6;
const NOT_USED_THRESHOLD = 0.4;
const MIN_JUDGMENT_BUDGET_MS = 200;
const MAX_JUDGED_SOURCES = 10;

export type AttributionVerdict = "used" | "not-used" | "unknown";

export interface AttributionSourceResult {
  readonly id: number;
  readonly verdict: AttributionVerdict;
}

export interface AttributionResult {
  readonly sources: AttributionSourceResult[];
  readonly profile: string;
  readonly questionSet: string;
}

/** Wire input for the private.attribution protocol method. */
export interface AttributionInputV1 {
  readonly userId: string;
  readonly response: string;
  readonly sourceIds: number[];
  readonly maxClassification?: number;
}

/** Wire output for the private.attribution protocol method. */
export type AttributionResultV1 = AttributionResult;

export interface AttributionDeps {
  db: Database.Database;
  judgmentProvider?: IJudgmentProvider;
}

export interface AttributionParams {
  userId: string;
  maxClassification?: number;
  /** Final delivered response text (never a draft or the recall query). */
  response: string;
  /** Memory ids actually supplied for this response. */
  sourceIds: number[];
  timeoutMs?: number;
}

/**
 * Attribute a delivered response to supplied memories. Returns null when the
 * operation cannot run (flag off, no provider, no profile, no budget, no
 * eligible sources) — the caller reports unsupported, never a fabricated
 * unused-memory verdict.
 */
export async function judgeAttribution(
  deps: AttributionDeps,
  params: AttributionParams,
): Promise<AttributionResult | null> {
  const provider = deps.judgmentProvider;
  const env = getAbmindEnv();
  if (!provider || !env.system1FastpathEnabled) return null;
  if (params.response.trim().length === 0 || params.sourceIds.length === 0) return null;
  const budget = params.timeoutMs ?? env.system1TimeoutMs;
  if (budget < MIN_JUDGMENT_BUDGET_MS) return null;
  const egress = checkJudgmentEgress(provider.name, "attribution");
  if (!egress.allow) {
    logDebug("recall", `system1 attribution skipped (${egress.reason})`);
    return null;
  }
  const profile = matchJudgmentProfile(provider.name, provider.model, ATTRIBUTION_QUESTION_SET);
  if (!profile) return null;

  const ids = [...new Set(params.sourceIds.filter((id) => Number.isInteger(id)))].slice(0, MAX_JUDGED_SOURCES);
  const rows = verifiedSources(deps.db, ids, params.userId, params.maxClassification);
  if (rows.length === 0) return null;

  const state: Record<string, unknown> = {
    response: redactSecrets(params.response),
    sources: rows.map((row, k) => ({ id: `s${k}`, text: redactSecrets(row.content_en) })),
  };
  const questions: Record<string, JudgmentQuestion> = {};
  rows.forEach((_, k) => {
    questions[`used_${k}`] = {
      type: "noul",
      instructions: "Does `response` use information from `sources[${k}].text`? A paraphrase counts as use; unrelated text does not.",
    };
  });

  let judged: import("./judgment-provider.js").JudgmentResult | null;
  try {
    judged = await provider.judge(state, questions, { timeoutMs: budget });
  } catch {
    return null;
  }
  const sources: AttributionSourceResult[] = rows.map((row, k) => {
    const answer = judged?.answers[`used_${k}`];
    const p = answer?.type === "noul" ? answer.noul : null;
    const verdict: AttributionVerdict =
      p === null ? "unknown" : p >= USED_THRESHOLD ? "used" : p <= NOT_USED_THRESHOLD ? "not-used" : "unknown";
    return { id: row.id, verdict };
  });
  // Sources that lost verification or answers stay unknown, never negative.
  const seen = new Set(sources.map((s) => s.id));
  for (const id of ids) {
    if (!seen.has(id)) sources.push({ id, verdict: "unknown" });
  }
  logDebug("recall", `system1 ${ATTRIBUTION_QUESTION_SET} ${sources.length} sources`);
  return {
    sources,
    profile: `${provider.name}/${provider.model} ${ATTRIBUTION_QUESTION_SET}`,
    questionSet: ATTRIBUTION_QUESTION_SET,
  };
}

function verifiedSources(
  db: Database.Database,
  ids: number[],
  userId: string,
  maxClassification: number | undefined,
): Array<{ id: number; content_en: string }> {
  if (ids.length === 0) return [];
  const vis = sharedOrOwnedClause("", userId, effectiveMaxClassification(maxClassification));
  try {
    const placeholders = ids.map(() => "?").join(",");
    const found = db.prepare(
      `SELECT id, content_en FROM extracted_memories WHERE id IN (${placeholders}) AND ${vis.sql}`,
    ).all(...ids, ...vis.params) as Array<{ id: number; content_en: string }>;
    const byId = new Map(found.map((row) => [row.id, row.content_en]));
    const out: Array<{ id: number; content_en: string }> = [];
    for (const id of ids) {
      const text = byId.get(id);
      if (typeof text === "string" && text.length > 0) out.push({ id, content_en: text });
    }
    return out;
  } catch {
    // Verification must never fail the caller; without it, no attribution.
    return [];
  }
}
