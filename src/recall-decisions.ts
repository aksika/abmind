/**
 * recall-decisions.ts — #1813 fast-path lookup verdicts and repeat handling.
 *
 * Post-retrieval judgments over the final result set: a repeat check against
 * turn-scoped delivered evidence, and a lookup verdict for complete questions.
 * Both are gated by SYSTEM1_FASTPATH, a matching build-time profile
 * (judgment-profiles.ts), and the owner-side egress gate — anything else
 * abstains with outcome "continue" and ordinary recall behavior.
 *
 * Question builders here must stay byte-identical to
 * abproject/laya/question-sets/{lookup,repeat}-v1.json; the version ids must
 * stay identical on both sides. No database writes; turn scope is memory-only.
 */

import type Database from "better-sqlite3";
import { getAbmindEnv } from "./env-schema.js";
import { logDebug, logTrace, isLogLevel } from "./mem-logger.js";
import { redactSecrets } from "./redact-secrets.js";
import { effectiveMaxClassification, sharedOrOwnedClause } from "./memory-visibility.js";
import { checkJudgmentEgress } from "./judgment-egress.js";
import { matchJudgmentProfile } from "./judgment-profiles.js";
import type { FlagValues } from "./cli-flags.js";
import type {
  IJudgmentProvider,
  JudgmentAnswers,
  JudgmentQuestion,
} from "./judgment-provider.js";
import type {
  FastPathIntent,
  RecallDecisionV1,
  RecallHit,
  RecallParams,
} from "./recall-engine.js";
import type { DeliveredRef, TurnIdentity, TurnScopeStore } from "./recall-turn-scope.js";

/** Question-set versions, shared with the harness fixtures. */
export const LOOKUP_QUESTION_SET = "lookup-v1";
export const REPEAT_QUESTION_SET = "repeat-v1";

/** Answer languages eligible for bypass. Extraction stays verbatim: only
 * languages with verified judgment coverage are listed. */
const SUPPORTED_ANSWER_LANGUAGES = ["en"];

/** Minimum remaining foreground budget to start a judgment round. */
const MIN_JUDGMENT_BUDGET_MS = 200;

/** Bounded verbatim extract length for a directly usable answer. */
const MAX_ANSWER_CHARS = 500;

/** Bounded candidate prefix judged per round (matches SYSTEM1_MAX_CANDIDATES ceiling). */
const MAX_JUDGED_CANDIDATES = 5;

export interface DecisionDeps {
  db: Database.Database;
  judgmentProvider?: IJudgmentProvider;
  turnScopes?: TurnScopeStore;
}

interface VerifiedEvidence {
  id: number;
  text: string;
  revision: number;
}

/**
 * Re-verify candidate ids against current visibility and classification and
 * read fresh content_en plus semantic revision. Unresolvable rows are dropped:
 * a repeat/lookup verdict must never rest on a row the caller may not see.
 */
function verifyEvidenceRows(
  db: Database.Database,
  ids: number[],
  userId: string,
  maxClassification: number | undefined,
): VerifiedEvidence[] {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id)))];
  if (unique.length === 0) return [];
  const vis = sharedOrOwnedClause("", userId, effectiveMaxClassification(maxClassification));
  let rows: Array<{ id: number; content_en: string; semantic_revision: number | null }>;
  try {
    const placeholders = unique.map(() => "?").join(",");
    rows = db.prepare(
      `SELECT id, content_en, semantic_revision FROM extracted_memories WHERE id IN (${placeholders}) AND ${vis.sql}`,
    ).all(...unique, ...vis.params) as Array<{ id: number; content_en: string; semantic_revision: number | null }>;
  } catch (err) {
    // Verification must never fail recall; without it, no verdict.
    logTrace("recall", `system1 evidence verification failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: VerifiedEvidence[] = [];
  for (const id of unique) {
    const row = byId.get(id);
    if (row && typeof row.content_en === "string" && row.content_en.length > 0) {
      out.push({ id, text: row.content_en, revision: row.semantic_revision ?? 0 });
    }
  }
  return out;
}

function buildLookupQuestions(count: number): Record<string, JudgmentQuestion> {
  const questions: Record<string, JudgmentQuestion> = {};
  for (let k = 0; k < count; k++) {
    questions[`answers_${k}`] = {
      type: "score",
      instructions: `Does \`candidates[${k}].text\` answer \`question\`?`,
      criteria: [
        "does not answer the question",
        "is related to the question but does not answer it",
        "answers the question",
      ],
    };
  }
  questions["complete"] = {
    type: "noul",
    instructions: "Do `candidates` taken together completely answer `question` with nothing essential missing?",
  };
  questions["is_action"] = {
    type: "noul",
    instructions: "Is `question` asking the agent to DO something (act, change state, run a command) rather than just answer from memory?",
  };
  questions["conflicts"] = {
    type: "noul",
    instructions: "Do `candidates` contradict each other on what answers `question`?",
  };
  return questions;
}

function buildRepeatQuestions(count: number): Record<string, JudgmentQuestion> {
  const questions: Record<string, JudgmentQuestion> = {};
  for (let k = 0; k < count; k++) {
    questions[`adds_${k}`] = {
      type: "noul",
      instructions: "Does `candidates[${k}].text` add information beyond `delivered`?",
    };
  }
  return questions;
}

function noulOf(answers: JudgmentAnswers, id: string): number | null {
  const answer = answers[id];
  return answer?.type === "noul" ? answer.noul : null;
}

/**
 * Intent arrives as JSON over IPC/CLI/host boundaries: shape is untrusted.
 * Malformed intents abstain instead of throwing — recall must never fail
 * because a caller sent a bad fastPath block.
 */
function isWellFormedIntent(intent: FastPathIntent): boolean {
  if (typeof intent.question !== "string") return false;
  if (typeof intent.answerLanguage !== "string") return false;
  if (typeof intent.session !== "string" || typeof intent.turn !== "string") return false;
  if (!Array.isArray(intent.delivered)) return false;
  for (const ref of intent.delivered) {
    if (typeof ref !== "object" || ref === null) return false;
    const { id, revision } = ref as { id?: unknown; revision?: unknown };
    if (!Number.isInteger(id) || !Number.isInteger(revision)) return false;
  }
  if (intent.releaseScope !== undefined && intent.releaseScope !== true) return false;
  return true;
}

/**
 * Build the fast-path intent from CLI flag values. Returns undefined for
 * ordinary recall: question, session, and turn must all be present (or an
 * explicit scope release), otherwise no intent is constructed and no verdict
 * can result. Delivered refs come from the caller's JSON; ids and revisions
 * are re-verified owner-side, so malformed entries are dropped here.
 */
export function parseFastPathIntent(
  args: FlagValues,
  userId: string,
): FastPathIntent | undefined {
  const releaseScope = args["release-scope"] === true;
  const question = args["question"] !== undefined ? String(args["question"]) : "";
  const session = args["session"] !== undefined ? String(args["session"]) : "";
  const turn = args["turn"] !== undefined ? String(args["turn"]) : "";
  if (!releaseScope && (question.trim().length === 0 || session === "" || turn === "")) {
    return undefined;
  }
  if (releaseScope && (session === "" || turn === "")) return undefined;
  const delivered: Array<{ id: number; revision: number }> = [];
  if (args["delivered"] !== undefined) {
    try {
      const parsed: unknown = JSON.parse(String(args["delivered"]));
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === "object" && entry !== null &&
            Number.isInteger((entry as { id?: unknown }).id) &&
            Number.isInteger((entry as { revision?: unknown }).revision)) {
            const typed = entry as { id: number; revision: number };
            delivered.push({ id: typed.id, revision: typed.revision });
          }
        }
      }
    } catch {
      // Malformed delivered JSON: recall proceeds without repeat context.
      logTrace("recall", "system1 fast-path: malformed delivered JSON, repeat context dropped");
    }
  }
  return {
    question,
    answerLanguage: args["answer-language"] !== undefined ? String(args["answer-language"]) : "en",
    principal: userId,
    session,
    turn,
    delivered,
    ...(releaseScope ? { releaseScope: true as const } : {}),
  };
}

/**
 * Evaluate the fast-path intent over final recall results. Returns a decision
 * envelope, or null when no decision applies (ordinary recall continues and
 * the caller omits the field). Never throws: every failure path returns null
 * or a "continue" envelope.
 */
export async function decideFastPath(
  results: RecallHit[],
  deps: DecisionDeps,
  params: RecallParams,
  opts: { deadlineMs: number },
): Promise<RecallDecisionV1 | null> {
  const intent = params.fastPath;
  const provider = deps.judgmentProvider;
  const env = getAbmindEnv();
  if (!intent || !provider || !env.system1FastpathEnabled) {
    logTrace("recall", `system1 fast-path off (intent=${intent ? "yes" : "no"} provider=${provider ? "yes" : "no"} flag=${env.system1FastpathEnabled})`);
    return null;
  }
  if (!isWellFormedIntent(intent)) {
    logTrace("recall", "system1 fast-path: malformed intent, abstaining");
    return null;
  }
  if (intent.releaseScope) {
    // Turn end/cancel/disconnect: drop scope, no verdict on the way out.
    deps.turnScopes?.release(identityOf(params, intent));
    logTrace("recall", "system1 fast-path: scope released on turn end");
    return null;
  }

  const identity = identityOf(params, intent);
  if (intent.delivered.length > 0) {
    deps.turnScopes?.noteDelivered(identity, intent.delivered);
  }

  const selectedRefs = results
    .filter((hit) => typeof hit.id === "number")
    .slice(0, 2)
    .map((hit) => hit.id as number);

  // Repeat check first: it needs no question and no profile, only delivered
  // evidence plus a passing repeat profile for suppression.
  const delivered = deps.turnScopes?.deliveredFor(identity) ?? [];
  if (delivered.length > 0) {
    const repeat = await checkRepeat(results, delivered, deps, params, opts.deadlineMs);
    if (repeat) return { ...repeat, selectedRefs };
  }

  // Lookup verdict: runs only with a passing lookup profile. No backend
  // passes today, so this stays inactive and visible — never lowered to fit.
  const lookupProfile = matchJudgmentProfile(provider.name, provider.model, LOOKUP_QUESTION_SET);
  if (!lookupProfile) {
    logDebug("recall", `system1 lookup skipped (no passing profile for ${provider.name}/${provider.model})`);
    return {
      version: 1,
      outcome: "continue",
      sourceIds: [],
      sourceRevisions: {},
      selectedRefs,
      profile: "none",
      questionSet: LOOKUP_QUESTION_SET,
    };
  }
  return decideLookup(results, deps, params, intent, opts.deadlineMs, selectedRefs);
}

function identityOf(params: RecallParams, intent: FastPathIntent): TurnIdentity {
  return { principal: params.userId, session: intent.session, turn: intent.turn };
}

function remainingMs(deadlineMs: number): number {
  return deadlineMs - Date.now();
}

/**
 * Repeat check: judge whether fresh candidates add anything beyond delivered
 * evidence. Suppression needs a passing repeat profile; without one the new
 * pull flows through normally.
 */
async function checkRepeat(
  results: RecallHit[],
  delivered: DeliveredRef[],
  deps: DecisionDeps,
  params: RecallParams,
  deadlineMs: number,
): Promise<Omit<RecallDecisionV1, "selectedRefs"> | null> {
  const provider = deps.judgmentProvider;
  if (!provider) return null;
  if (remainingMs(deadlineMs) < MIN_JUDGMENT_BUDGET_MS) {
    logTrace("recall", `system1 repeat skipped (budget ${remainingMs(deadlineMs)}ms < ${MIN_JUDGMENT_BUDGET_MS}ms)`);
    return null;
  }
  const egress = checkJudgmentEgress(provider.name, "repeat");
  if (!egress.allow) {
    logDebug("recall", `system1 repeat skipped (${egress.reason})`);
    return null;
  }
  const profile = matchJudgmentProfile(provider.name, provider.model, REPEAT_QUESTION_SET);
  // No profile, or a profile without a repeat gate, means no suppression:
  // the fallback threshold must never be more permissive than fitted evidence.
  const repeatGate = profile?.repeatGate;
  if (!repeatGate) {
    logDebug("recall", `system1 repeat skipped (no repeat gate for ${provider.name}/${provider.model})`);
    return null;
  }

  const ids = results
    .filter((hit) => typeof hit.id === "number")
    .slice(0, MAX_JUDGED_CANDIDATES)
    .map((hit) => hit.id as number);
  const evidence = verifyEvidenceRows(deps.db, ids, params.userId, params.maxClassification);
  if (evidence.length === 0) {
    logTrace("recall", "system1 repeat skipped (no verifiable evidence)");
    return null;
  }

  const state: Record<string, unknown> = {
    query: redactSecrets(params.translated.join(" ")),
    delivered: delivered.map((ref) => ({ id: `m${ref.id}` })),
  };
  // Delivered text is re-read owner-side so a caller cannot smuggle content
  // past visibility: only ids travel in, text comes from verified rows.
  // Nothing verifiable delivered means nothing to compare: first-pull shape.
  const deliveredRows = verifyEvidenceRows(
    deps.db, delivered.map((ref) => ref.id), params.userId, params.maxClassification,
  );
  if (deliveredRows.length === 0) return null;
  state["delivered"] = deliveredRows.map((row) => ({ id: `m${row.id}`, text: redactSecrets(row.text) }));
  state["candidates"] = evidence.map((row, k) => ({ id: `c${k}`, text: redactSecrets(row.text), date: "" }));

  let judged: import("./judgment-provider.js").JudgmentResult | null;
  try {
    judged = await provider.judge(state, buildRepeatQuestions(evidence.length), {
      timeoutMs: Math.min(remainingMs(deadlineMs), getAbmindEnv().system1TimeoutMs),
    });
  } catch (err) {
    // Never-throw contract broken by the provider: baseline continues.
    logTrace("recall", `system1 repeat: provider threw (${err instanceof Error ? err.message : String(err)})`);
    return null;
  }
  if (!judged) {
    logTrace("recall", "system1 repeat skipped (provider abstained)");
    return null;
  }
  if (isLogLevel("trace")) {
    const parts: string[] = [];
    for (let k = 0; k < evidence.length; k++) {
      const adds = noulOf(judged.answers, `adds_${k}`);
      parts.push(`c${k}(id=${evidence[k]?.id ?? "?"}):adds=${adds === null ? "?" : adds.toFixed(2)}`);
    }
    logTrace("recall", `system1 repeat scores: ${parts.join(" ")} gate=${repeatGate.addsThreshold}`);
  }
  // Suppression needs every judged candidate below the gate; an unanswered
  // candidate is uncertainty, and uncertainty never suppresses. A candidate
  // whose revision moved since delivery is new evidence by definition (R2):
  // the judge sees current text, but a changed revision alone vetoes
  // suppression regardless of what the text comparison says.
  const deliveredRev = new Map(delivered.map((ref) => [ref.id, ref.revision]));
  for (const row of evidence) {
    const deliveredRevision = deliveredRev.get(row.id);
    if (deliveredRevision !== undefined && deliveredRevision !== row.revision) return null;
  }
  let judgedAny = false;
  for (let k = 0; k < evidence.length; k++) {
    const adds = noulOf(judged.answers, `adds_${k}`);
    if (adds === null) return null;
    judgedAny = true;
    if (adds >= repeatGate.addsThreshold) return null;
  }
  if (!judgedAny) return null;
  const sourceIds = delivered.map((ref) => ref.id);
  const sourceRevisions: Record<number, number> = {};
  for (const ref of delivered) sourceRevisions[ref.id] = ref.revision;
  logDebug("recall", `system1 ${REPEAT_QUESTION_SET} already-supplied over ${evidence.length} candidates`);
  return {
    version: 1,
    outcome: "already-supplied",
    sourceIds,
    sourceRevisions,
    profile: `${provider.name}/${provider.model} ${REPEAT_QUESTION_SET}`,
    questionSet: REPEAT_QUESTION_SET,
  };
}

/**
 * Lookup verdict: bypass only on complete coverage of a full English question
 * by verified evidence, with a supported answer language and no action or
 * conflict. Mirrors the harness bypass rule; thresholds come from the
 * passing profile only.
 */
async function decideLookup(
  results: RecallHit[],
  deps: DecisionDeps,
  params: RecallParams,
  intent: FastPathIntent,
  deadlineMs: number,
  selectedRefs: number[],
): Promise<RecallDecisionV1> {
  const stay: RecallDecisionV1 = {
    version: 1,
    outcome: "continue",
    sourceIds: [],
    sourceRevisions: {},
    selectedRefs,
    profile: "none",
    questionSet: LOOKUP_QUESTION_SET,
  };
  const provider = deps.judgmentProvider;
  if (!provider) return stay;
  if (!SUPPORTED_ANSWER_LANGUAGES.includes(intent.answerLanguage)) {
    logTrace("recall", `system1 lookup stays (unsupported answer language ${intent.answerLanguage})`);
    return stay;
  }
  if (intent.question.trim().length === 0) {
    logTrace("recall", "system1 lookup stays (empty question)");
    return stay;
  }
  if (remainingMs(deadlineMs) < MIN_JUDGMENT_BUDGET_MS) {
    logTrace("recall", `system1 lookup stays (budget ${remainingMs(deadlineMs)}ms < ${MIN_JUDGMENT_BUDGET_MS}ms)`);
    return stay;
  }
  const egress = checkJudgmentEgress(provider.name, "lookup");
  if (!egress.allow) {
    logDebug("recall", `system1 lookup skipped (${egress.reason})`);
    return stay;
  }
  const profile = matchJudgmentProfile(provider.name, provider.model, LOOKUP_QUESTION_SET);
  if (!profile) {
    logDebug("recall", `system1 lookup stays (no passing profile for ${provider.name}/${provider.model})`);
    return stay;
  }

  const ids = results
    .filter((hit) => typeof hit.id === "number")
    .slice(0, MAX_JUDGED_CANDIDATES)
    .map((hit) => hit.id as number);
  const evidence = verifyEvidenceRows(deps.db, ids, params.userId, params.maxClassification);
  // Bypass needs exactly one fully-answering source: multi-source synthesis
  // stays on the agent path (no inferred combination presented as memory).
  if (evidence.length !== 1) {
    logTrace("recall", `system1 lookup stays (evidence=${evidence.length}, need exactly 1)`);
    return stay;
  }
  const source = evidence[0]!;

  const state: Record<string, unknown> = {
    question: redactSecrets(intent.question),
    candidates: [{ id: "c0", text: redactSecrets(source.text), date: "" }],
  };
  let judged: import("./judgment-provider.js").JudgmentResult | null;
  try {
    judged = await provider.judge(state, buildLookupQuestions(1), {
      timeoutMs: Math.min(remainingMs(deadlineMs), getAbmindEnv().system1TimeoutMs),
    });
  } catch (err) {
    logTrace("recall", `system1 lookup: provider threw (${err instanceof Error ? err.message : String(err)})`);
    return stay;
  }
  if (!judged) {
    logTrace("recall", "system1 lookup stays (provider abstained)");
    return stay;
  }
  const answers = judged.answers;
  const gate = profile.lookupGate;
  if (!gate) {
    logDebug("recall", `system1 lookup stays (no lookup gate for ${provider.name}/${provider.model})`);
    return stay;
  }
  const complete = noulOf(answers, "complete");
  const isAction = noulOf(answers, "is_action");
  const conflicts = noulOf(answers, "conflicts");
  const scored = answers["answers_0"];
  // Parity with the harness bypass rule (eval_judgments.bypass_decision):
  // the fitted gates were computed on round(score)==2, i.e. score >= 1.5.
  // Score is a float expectation, so an exact >= 2.0 test would almost never
  // fire and would silently overrule the evidence.
  const fullyAnswers = scored?.type === "score" && scored.score >= 1.5 &&
    scored.confidence >= gate.answersGate;
  if (isLogLevel("trace")) {
    const fmtNoul = (v: number | null): string => v === null ? "?" : v.toFixed(2);
    const fmtScore = scored?.type === "score" ? `${scored.score.toFixed(2)}/${scored.confidence.toFixed(2)}` : "?";
    logTrace("recall", `system1 lookup scores: id=${source.id} answers=${fmtScore} complete=${fmtNoul(complete)} is_action=${fmtNoul(isAction)} conflicts=${fmtNoul(conflicts)} gate=${gate.completeThreshold}/${gate.answersGate}`);
  }
  // complete threshold comes from the fitted profile; the 0.5 action/conflict
  // lines are structural (binary presence), not fitted gates.
  if (complete === null || complete < gate.completeThreshold || isAction === null || isAction >= 0.5 ||
      conflicts === null || conflicts >= 0.5 || !fullyAnswers) {
    return stay;
  }
  const answerText = source.text.slice(0, MAX_ANSWER_CHARS);
  logDebug("recall", `system1 ${LOOKUP_QUESTION_SET} answer from memory ${source.id}`);
  return {
    version: 1,
    outcome: "answer",
    answerText,
    answerLanguage: intent.answerLanguage,
    sourceIds: [source.id],
    sourceRevisions: { [source.id]: source.revision },
    selectedRefs: [source.id],
    profile: `${provider.name}/${provider.model} ${LOOKUP_QUESTION_SET}`,
    questionSet: LOOKUP_QUESTION_SET,
  };
}
