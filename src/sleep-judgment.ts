/**
 * sleep-judgment.ts — advisory System One judgments for sleep (#1817).
 *
 * The advisory layer is an annotation pass inside #1859's seam, not a second
 * decision path. Judgments are requested against a candidate's linked
 * evidence and recorded next to the baseline outcome; the baseline never
 * consults the verdict. Annotate, never divert: anything implementable only
 * by changing, withholding, or adding a disposition is consequential and out
 * of scope for this ticket.
 *
 * Three gates, three recording sites:
 * - extract-memories store candidates: annotation on the WriteReceipt.
 * - gc-noise messages: the run-scoped judgment record (no receipt exists).
 * - contradiction/maintenance pairs: the run-scoped record; the full D-model
 *   step always runs regardless of the triage.
 *
 * Optional and default-off (SYSTEM1_SLEEP), independent of SYSTEM1_RECALL and
 * SYSTEM1_FASTPATH. Fail-open everywhere: no provider, busy, denied egress,
 * malformed answers, exhausted budget, or no evidence all resolve to an
 * explicit `unjudged` (or `no-evidence`) verdict on the baseline path.
 */

import { getAbmindEnv } from "./env-schema.js";
import type { AbmindEnvConfig } from "./env-schema.js";
import type {
  IJudgmentProvider,
  JudgmentAnswers,
  JudgmentQuestion,
} from "./judgment-provider.js";
import { checkJudgmentEgress } from "./judgment-egress.js";
import { logInfo, logWarn } from "./mem-logger.js";
import { redactSecrets } from "./redact-secrets.js";
import type { SleepJudgment, SleepVerdict, WriteReceipt } from "./sleep/receipts.js";
import type { JudgmentGate, JudgmentRecordEntry } from "./sleep/judgment-records.js";
import { readJudgmentRecords } from "./sleep/judgment-records.js";
import { readReceipts } from "./sleep/receipts.js";

const TAG = "sleep-judgments";

/** Question-set version, shared with the Task-1 harness fixture
 *  (abproject/laya/question-sets/sleep-support-v1.json). */
export const SLEEP_SUPPORT_QUESTION_SET = "sleep-support-v1";

/** Per-call provider timeout comes from the shared SYSTEM1 setting. */
export function sleepJudgmentTimeoutMs(env: Readonly<AbmindEnvConfig>): number {
  return env.system1TimeoutMs;
}

export interface SleepJudgmentLimits {
  maxCandidates: number;
  maxPairs: number;
  budgetMs: number;
}

export interface SleepJudgmentConfig {
  enabled: boolean;
  timeoutMs: number;
  limits: SleepJudgmentLimits;
}

/** Pure resolver over the #1817 env keys. The master switch is independent
 *  of the recall/fastpath switches by construction — it reads only its own
 *  keys. Invalid values fail safe to off/clamped defaults in env-schema. */
export function resolveSleepJudgmentConfig(env: Readonly<AbmindEnvConfig>): SleepJudgmentConfig {
  return {
    enabled: env.system1SleepEnabled,
    timeoutMs: env.system1TimeoutMs,
    limits: {
      maxCandidates: env.system1SleepMaxCandidates,
      maxPairs: env.system1SleepMaxPairs,
      budgetMs: env.system1SleepBudgetMs,
    },
  };
}

/** Owner-side egress for the sleep-support operation. Laya is loopback-only
 *  and needs no grant; Jev needs SYSTEM1_SLEEP_JEV_EGRESS=sleep-support.
 *  Unknown providers abstain. Never throws. */
export function sleepJudgmentEgress(providerName: string): boolean {
  const verdict = checkJudgmentEgress(providerName, "sleep-support");
  if (!verdict.allow) {
    logInfo(TAG, `sleep-support egress denied for ${providerName} (${verdict.reason})`);
    return false;
  }
  return true;
}

// ── Question builders ─────────────────────────────────────────────────────
// Instructions reference `claims[{k}]` / `evidence[{k}]` state arrays, the
// same ref convention as recall-judgment.ts. The JSON mirror must stay
// byte-identical to these strings.

function supportQuestionIds(k: number): { support: string; correction: string; scope: string } {
  return { support: `support_${k}`, correction: `correction_${k}`, scope: `scope_${k}` };
}

export function buildSupportQuestions(count: number): Record<string, JudgmentQuestion> {
  const questions: Record<string, JudgmentQuestion> = {};
  for (let k = 0; k < count; k++) {
    const ids = supportQuestionIds(k);
    questions[ids.support] = {
      type: "noul",
      instructions: `Does \`evidence[{k}]\` support \`claims[{k}]\` as a durable memory — a fact, decision, preference, event, or lesson the user stated, decided, or confirmed?`,
    };
    questions[ids.correction] = {
      type: "noul",
      instructions: `Does \`evidence[{k}]\` show \`claims[{k}]\` was corrected, rejected, dismissed, or never approved by the user — for example an agent suggestion the user shot down?`,
    };
    questions[ids.scope] = {
      type: "noul",
      instructions: `Is \`claims[{k}]\` broader than what \`evidence[{k}]\` supports — for example a one-off workaround stated as a permanent rule, or a scoped exception stated as a general preference?`,
    };
  }
  return questions;
}

export function buildGcQuestions(count: number): Record<string, JudgmentQuestion> {
  const questions: Record<string, JudgmentQuestion> = {};
  for (let k = 0; k < count; k++) {
    questions[`noise_${k}`] = {
      type: "noul",
      instructions: `Is \`messages[{k}]\` transient chatter with no durable content — greetings, acknowledgements, or filler with nothing worth remembering?`,
    };
  }
  return questions;
}

export function buildTriageQuestions(count: number): Record<string, JudgmentQuestion> {
  const questions: Record<string, JudgmentQuestion> = {};
  for (let k = 0; k < count; k++) {
    questions[`triage_${k}`] = {
      type: "choice",
      instructions: `Given \`pairs[{k}].new_text\` (new extraction) and \`pairs[{k}].old_text\` (existing memory), what should happen to the old memory?`,
      criteria: { keep: "both can coexist", prune: "the old memory is superseded", merge: "they describe the same fact" },
    };
    questions[`contradicts_${k}`] = {
      type: "noul",
      instructions: `Does \`pairs[{k}].new_text\` contradict \`pairs[{k}].old_text\`?`,
    };
  }
  return questions;
}

// ── Answer mapping ────────────────────────────────────────────────────────
// Thresholds are provisional initial values, not fitted gates: Task-1 and
// divergence evidence fit per-backend thresholds later. They are named
// constants so the fitting ticket has one place to change.

const SUPPORT_GATE = 0.8;
const CORRECTION_FLAG = 0.8;
const SCOPE_FLAG = 0.5;
const DISPUTE_FLOOR = 0.2;
const NOISE_GATE = 0.8;
const CONTRADICTS_FLAG = 0.8;
const CONTRADICTS_FLOOR = 0.2;

function noulValue(answers: JudgmentAnswers, id: string): number | null {
  const a = answers[id];
  if (!a || a.type !== "noul") return null;
  if (!Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) return null;
  return a.noul;
}

function fmt(n: number): string {
  return n.toFixed(2);
}

interface MappedVerdict {
  verdict: SleepVerdict;
  reason: string;
}

function mapSupportAnswers(answers: JudgmentAnswers, k: number): MappedVerdict {
  const ids = supportQuestionIds(k);
  const support = noulValue(answers, ids.support);
  const correction = noulValue(answers, ids.correction);
  const scope = noulValue(answers, ids.scope);
  if (support === null || correction === null || scope === null) {
    return { verdict: "uncertain", reason: "incomplete answers" };
  }
  const reason = `support=${fmt(support)} correction=${fmt(correction)} scope=${fmt(scope)}`;
  if (correction >= CORRECTION_FLAG) return { verdict: "disputed", reason };
  if (support >= SUPPORT_GATE && scope < SCOPE_FLAG) return { verdict: "supported", reason };
  if (support <= DISPUTE_FLOOR) return { verdict: "disputed", reason };
  return { verdict: "uncertain", reason };
}

// ── Per-run budget and memo ───────────────────────────────────────────────
// One instance per sleep run, shared across steps. The memo is keyed by
// content-addressed operation identity for receipt annotations and by
// subject descriptor for record entries, so a resumed run re-judges nothing
// it already judged. Caps of 0 disable that dimension: every subject in it
// resolves unjudged without a provider call.

export type JudgmentOutcome = "judged" | "unjudged" | "no-evidence";

/** Plain snapshot of a run's judgment activity for the settlement line.
 *  Passed by value across the settlement boundary, never the live run. */
export interface SleepJudgmentSummary {
  judged: number;
  unjudged: number;
  noEvidence: number;
  candidatesUsed: number;
  pairsUsed: number;
  latencyMs: number;
  exhausted: boolean;
}

export class SleepJudgmentRun {
  candidatesUsed = 0;
  pairsUsed = 0;
  exhausted = false;
  judged = 0;
  unjudged = 0;
  noEvidence = 0;
  latencyMs = 0;
  private readonly memo = new Map<string, SleepJudgment>();

  constructor(
    readonly limits: SleepJudgmentLimits,
    readonly deadlineMs: number,
  ) {}

  private pastDeadline(nowMs: number): boolean {
    return nowMs >= this.deadlineMs;
  }

  trySpendCandidate(nowMs: number): boolean {
    if (this.exhausted || this.candidatesUsed >= this.limits.maxCandidates || this.pastDeadline(nowMs)) {
      this.exhausted = true;
      return false;
    }
    this.candidatesUsed++;
    return true;
  }

  trySpendPair(nowMs: number): boolean {
    if (this.exhausted || this.pairsUsed >= this.limits.maxPairs || this.pastDeadline(nowMs)) {
      this.exhausted = true;
      return false;
    }
    this.pairsUsed++;
    return true;
  }

  note(outcome: JudgmentOutcome, latencyMs = 0): void {
    if (outcome === "judged") this.judged++;
    else if (outcome === "unjudged") this.unjudged++;
    else this.noEvidence++;
    this.latencyMs += latencyMs;
  }

  memoGet(key: string): SleepJudgment | undefined {
    return this.memo.get(key);
  }

  memoSet(key: string, judgment: SleepJudgment): void {
    if (this.memo.size >= 2000) return;
    this.memo.set(key, judgment);
  }

  memoSize(): number {
    return this.memo.size;
  }

  summary(): SleepJudgmentSummary {
    return {
      judged: this.judged,
      unjudged: this.unjudged,
      noEvidence: this.noEvidence,
      candidatesUsed: this.candidatesUsed,
      pairsUsed: this.pairsUsed,
      latencyMs: this.latencyMs,
      exhausted: this.exhausted,
    };
  }
}

/** Seed the memo from a prior run's receipts (opId-keyed annotations) and
 *  judgment records (subject-keyed verdicts). Never throws. */
export function seedMemoFromPriorRun(run: SleepJudgmentRun, memoryDir: string, priorRunId: string | null): void {
  if (!priorRunId) return;
  try {
    for (const r of readReceipts(memoryDir, priorRunId)) {
      if (r.judgment !== undefined) run.memoSet(`op:${r.opId}`, r.judgment);
    }
  } catch { /* reconcile-to-empty: re-judging is safe, double-apply is not */ }
  try {
    for (const e of readJudgmentRecords(memoryDir, priorRunId)) {
      run.memoSet(`subject:${e.gate}:${e.subject}`, {
        verdict: e.verdict,
        questionSet: e.questionSet,
        model: e.model,
        ...(e.reason !== undefined ? { reason: e.reason } : {}),
      });
    }
  } catch { /* same */ }
}

// ── Judge entry points ────────────────────────────────────────────────────
// Every path returns a verdict; every failure mode resolves to explicit
// `unjudged` on the unchanged baseline. Nothing here throws to the caller.

export interface SleepJudgeDeps {
  provider: IJudgmentProvider | null;
  timeoutMs: number;
  questionSet: string;
  signal?: AbortSignal;
}

function unjudged(questionSet: string, model: string, reason: string): SleepJudgment {
  return { verdict: "unjudged", questionSet, model, reason };
}

function providerModel(deps: SleepJudgeDeps): string {
  return deps.provider?.model ?? "none";
}

/** Judge one store candidate's support against its source excerpts. */
export async function judgeCandidateSupport(
  deps: SleepJudgeDeps,
  run: SleepJudgmentRun,
  opId: string,
  claim: string,
  evidence: readonly string[],
  nowMs: number,
): Promise<SleepJudgment> {
  const memoKey = `op:${opId}`;
  const remembered = run.memoGet(memoKey);
  if (remembered !== undefined) return remembered;
  const cleanClaim = redactSecrets(claim).slice(0, 1000);
  const cleanEvidence = evidence.map((e) => redactSecrets(e).slice(0, 300)).filter((e) => e.length > 0);
  if (cleanEvidence.length === 0) {
    const j: SleepJudgment = { verdict: "no-evidence", questionSet: deps.questionSet, model: providerModel(deps), reason: "no linked source excerpts" };
    run.note("no-evidence");
    run.memoSet(memoKey, j);
    return j;
  }
  if (!run.trySpendCandidate(nowMs)) {
    const j = unjudged(deps.questionSet, providerModel(deps), "judgment budget exhausted");
    run.note("unjudged");
    return j;
  }
  const provider = deps.provider;
  if (!provider || provider.busy || !sleepJudgmentEgress(provider.name)) {
    const reason = !provider ? "no provider" : provider.busy ? "provider busy" : "egress denied";
    const j = unjudged(deps.questionSet, providerModel(deps), reason);
    run.note("unjudged");
    run.memoSet(memoKey, j);
    return j;
  }
  const remaining = Math.max(0, run.deadlineMs - nowMs);
  const timeoutMs = Math.min(deps.timeoutMs, remaining > 0 ? remaining : deps.timeoutMs);
  let result: Awaited<ReturnType<IJudgmentProvider["judge"]>>;
  try {
    result = await provider.judge(
      { claims: [cleanClaim], evidence: cleanEvidence },
      buildSupportQuestions(1),
      { timeoutMs, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) },
    );
  } catch (err) {
    // The provider contract says never-throws; a throw is a bug, not a
    // verdict. Fail open and keep the run on the baseline path.
    logWarn(TAG, `support judge threw (${err instanceof Error ? err.message : String(err)}) — baseline continues unjudged`);
    const j = unjudged(deps.questionSet, provider.model, "provider error");
    run.note("unjudged");
    return j;
  }
  if (!result) {
    const j = unjudged(deps.questionSet, provider.model, provider.lastFailure ?? "no usable judgment");
    run.note("unjudged", 0);
    run.memoSet(memoKey, j);
    return j;
  }
  const mapped = mapSupportAnswers(result.answers, 0);
  const j: SleepJudgment = { verdict: mapped.verdict, questionSet: deps.questionSet, model: result.model, reason: mapped.reason };
  run.note("judged", result.latencyMs);
  run.memoSet(memoKey, j);
  return j;
}

export interface GcSubject {
  id: number;
  excerpt: string;
}

export interface GcVerdict {
  decision: "keep" | "noise";
  verdict: SleepVerdict;
  reason: string;
}

/** Advisory gc-noise triage over raw short messages. Tiny inputs, high
 *  volume: chunked so each provider call stays under the 64 KiB request cap.
 *  Returns a verdict per input id; every message is kept regardless. */
export async function judgeGcBatch(
  deps: SleepJudgeDeps,
  run: SleepJudgmentRun,
  items: readonly GcSubject[],
  nowMs: number,
): Promise<Map<number, GcVerdict>> {
  const out = new Map<number, GcVerdict>();
  const keep = (id: number, verdict: SleepVerdict, reason: string, outcome: JudgmentOutcome): void => {
    out.set(id, { decision: "keep", verdict, reason });
    run.note(outcome);
  };
  // Conservative chunking: ~40 KiB of excerpt text per call leaves headroom
  // for state framing under the provider's 64 KiB request cap.
  const chunks: GcSubject[][] = [];
  let current: GcSubject[] = [];
  let chars = 0;
  for (const item of items) {
    const clean = redactSecrets(item.excerpt).slice(0, 300);
    if (current.length > 0 && chars + clean.length > 40_000) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push({ id: item.id, excerpt: clean });
    chars += clean.length;
  }
  if (current.length > 0) chunks.push(current);
  for (const chunk of chunks) {
    if (!run.trySpendCandidate(nowMs)) {
      // Budget exhausted: mark this chunk unjudged and stop. The remainder
      // stays implicitly unjudged — recorded exhaustion plus the run summary
      // keeps the cap observable without flooding the record.
      for (const item of chunk) {
        out.set(item.id, { decision: "keep", verdict: "unjudged", reason: "judgment budget exhausted" });
        run.note("unjudged");
      }
      break;
    }
    const provider = deps.provider;
    if (!provider || provider.busy || !sleepJudgmentEgress(provider.name)) {
      const reason = !provider ? "no provider" : provider.busy ? "provider busy" : "egress denied";
      for (const item of chunk) keep(item.id, "unjudged", reason, "unjudged");
      continue;
    }
    let result: Awaited<ReturnType<IJudgmentProvider["judge"]>> | null = null;
    try {
      result = await provider.judge(
        { messages: chunk.map((c) => c.excerpt) },
        buildGcQuestions(chunk.length),
        { timeoutMs: deps.timeoutMs, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) },
      );
    } catch (err) {
      logWarn(TAG, `gc judge threw (${err instanceof Error ? err.message : String(err)}) — messages kept unjudged`);
    }
    if (!result) {
      for (const item of chunk) keep(item.id, "unjudged", provider.lastFailure ?? "no usable judgment", "unjudged");
      continue;
    }
    run.latencyMs += result.latencyMs;
    chunk.forEach((item, k) => {
      const n = noulValue(result!.answers, `noise_${k}`);
      if (n === null) {
        keep(item.id, "uncertain", "incomplete answers", "judged");
      } else if (n >= NOISE_GATE) {
        out.set(item.id, { decision: "noise", verdict: "disputed", reason: `noise=${fmt(n)}` });
        run.note("judged");
      } else {
        out.set(item.id, { decision: "keep", verdict: "supported", reason: `noise=${fmt(n)}` });
        run.note("judged");
      }
    });
  }
  return out;
}

export interface PairSubject {
  newId: number;
  oldId: number;
  newText: string;
  oldText: string;
}

export interface PairVerdict {
  /** keep/prune/merge triage choice; keep is the fail-open default. */
  triage: "keep" | "prune" | "merge";
  verdict: SleepVerdict;
  reason: string;
}

/** Advisory contradiction/maintenance pre-triage over snapshot pairs. The
 *  full D-model step always runs afterward regardless of these verdicts. */
export async function judgePairs(
  deps: SleepJudgeDeps,
  run: SleepJudgmentRun,
  pairs: readonly PairSubject[],
  nowMs: number,
): Promise<Map<string, PairVerdict>> {
  const out = new Map<string, PairVerdict>();
  const key = (p: PairSubject): string => `pair:${p.newId}->${p.oldId}`;
  const budgeted = pairs.slice(0, run.limits.maxPairs);
  const provider = deps.provider;
  if (provider === null || provider.busy || !sleepJudgmentEgress(provider.name)) {
    const reason = provider === null ? "no provider" : provider.busy ? "provider busy" : "egress denied";
    for (const p of budgeted) {
      out.set(key(p), { triage: "keep", verdict: "unjudged", reason });
      run.note("unjudged");
    }
    return out;
  }
  // One provider call per pair: pairs are few (capped) and each carries two
  // texts, so batching buys little and complicates attribution.
  for (const p of budgeted) {
    const memoKey = `subject:pre-triage:${key(p)}`;
    const remembered = run.memoGet(memoKey);
    if (remembered !== undefined && remembered.reason !== undefined) {
      const triage = remembered.reason.startsWith("triage=") ? remembered.reason.slice(7).split(" ")[0] : "keep";
      out.set(key(p), {
        triage: triage === "prune" || triage === "merge" ? triage : "keep",
        verdict: remembered.verdict,
        reason: remembered.reason,
      });
      continue;
    }
    if (!run.trySpendPair(nowMs)) {
      out.set(key(p), { triage: "keep", verdict: "unjudged", reason: "judgment budget exhausted" });
      run.note("unjudged");
      continue;
    }
    let result: Awaited<ReturnType<IJudgmentProvider["judge"]>> | null = null;
    try {
      result = await provider.judge(
        { pairs: [{ new_text: redactSecrets(p.newText).slice(0, 500), old_text: redactSecrets(p.oldText).slice(0, 500) }] },
        buildTriageQuestions(1),
        { timeoutMs: deps.timeoutMs, ...(deps.signal !== undefined ? { signal: deps.signal } : {}) },
      );
    } catch (err) {
      logWarn(TAG, `pair judge threw (${err instanceof Error ? err.message : String(err)}) — full step runs, triage unjudged`);
    }
    if (!result) {
      out.set(key(p), { triage: "keep", verdict: "unjudged", reason: provider.lastFailure ?? "no usable judgment" });
      run.note("unjudged");
      continue;
    }
    run.latencyMs += result.latencyMs;
    const raw = result.answers["triage_0"];
    const choice = raw?.type === "choice" ? raw.choice : null;
    const triage = choice === "prune" || choice === "merge" ? choice : "keep";
    const contradicts = noulValue(result.answers, "contradicts_0");
    const verdict: SleepVerdict =
      contradicts === null ? "uncertain"
      : contradicts >= CONTRADICTS_FLAG ? "disputed"
      : contradicts <= CONTRADICTS_FLOOR ? "supported"
      : "uncertain";
    const reason = `triage=${triage} contradicts=${contradicts === null ? "?" : fmt(contradicts)}`;
    out.set(key(p), { triage, verdict, reason });
    run.note("judged");
    run.memoSet(memoKey, { verdict, questionSet: deps.questionSet, model: result.model, reason });
  }
  return out;
}

// ── Divergence reporting ──────────────────────────────────────────────────
// Pairing rules are per gate because verdict and baseline are not on a single
// axis (requirements Constraints). A verdict that cannot be paired with a
// baseline outcome is reported as unpaired, never folded into the rate.

export interface GateDivergence {
  gate: JudgmentGate;
  judged: number;
  agreed: number;
  divergent: number;
  abstained: number;
  unpaired: number;
}

function emptyDivergence(gate: JudgmentGate): GateDivergence {
  return { gate, judged: 0, agreed: 0, divergent: 0, abstained: 0, unpaired: 0 };
}

/** Applied pair-invalidations keyed by invalidated (old) id. Triage pairs
 *  by old id because accepted pair receipts carry memoryId=old, not new. */
function appliedOldIds(receipts: readonly WriteReceipt[]): Set<number> {
  const out = new Set<number>();
  for (const r of receipts) {
    if (r.disposition !== "accepted") continue;
    if (r.op !== "contradict" && r.op !== "retro_invalidate" && r.op !== "merge_keep") continue;
    if (typeof r.memoryId === "number") out.add(r.memoryId);
  }
  return out;
}

const PAIR_SUBJECT_RE = /^pair:(\d+)->(\d+)$/;
const TRIAGE_DECISION_RE = /^triage=(keep|prune|merge)\b/;

export function computeDivergence(
  receipts: readonly WriteReceipt[],
  records: readonly JudgmentRecordEntry[],
): GateDivergence[] {
  const extract = emptyDivergence("extract");
  for (const r of receipts) {
    const j = r.judgment;
    if (j === undefined) continue;
    extract.judged++;
    if (j.verdict === "supported") extract.agreed++;
    else if (j.verdict === "disputed") {
      if (r.disposition === "accepted") extract.divergent++;
      else extract.agreed++;
    } else extract.abstained++;
  }
  const gc = emptyDivergence("gc-noise");
  for (const e of records) {
    if (e.gate !== "gc-noise") continue;
    gc.judged++;
    if (e.verdict === "disputed") gc.divergent++;
    else if (e.verdict === "supported") gc.agreed++;
    else gc.abstained++;
  }
  const triage = emptyDivergence("pre-triage");
  const applied = appliedOldIds(receipts);
  for (const e of records) {
    if (e.gate !== "pre-triage") continue;
    if (e.verdict === "unjudged") {
      triage.judged++;
      triage.abstained++;
      continue;
    }
    const subject = PAIR_SUBJECT_RE.exec(e.subject);
    const decision = TRIAGE_DECISION_RE.exec(e.decision);
    if (!subject || !decision) {
      triage.unpaired++;
      continue;
    }
    triage.judged++;
    const oldId = parseInt(subject[2] ?? "", 10);
    const wouldChange = decision[1] === "prune" || decision[1] === "merge";
    const didChange = applied.has(oldId);
    if (wouldChange === didChange) triage.agreed++;
    else triage.divergent++;
  }
  return [extract, gc, triage];
}

/** Bounded one-line-per-gate summary for the run report. Null when the
 *  advisory layer produced nothing observable this run. */
export function formatDivergenceSummary(divergence: readonly GateDivergence[]): string | null {
  const active = divergence.filter((d) => d.judged > 0 || d.unpaired > 0);
  if (active.length === 0) return null;
  return active
    .map((d) => `${d.gate}: ${d.judged} judged, ${d.agreed} agreed, ${d.divergent} divergent, ${d.abstained} abstained, ${d.unpaired} unpaired`)
    .join("; ");
}

/** The settlement line: what the advisory layer did this run, including the
 *  enforced-budget state. Null when judgments were off or produced nothing.
 *  Without a live run summary, exhaustion is read off the recorded reasons. */
export function summarizeSleepJudgments(
  receipts: readonly WriteReceipt[],
  records: readonly JudgmentRecordEntry[],
  run: SleepJudgmentSummary | null,
): string | null {
  const annotated = receipts.filter((r) => r.judgment !== undefined).length;
  if (annotated === 0 && records.length === 0) return null;
  const exhausted = run !== null ? run.exhausted
    : receipts.some((r) => r.judgment?.reason === "judgment budget exhausted")
    || records.some((e) => e.reason === "judgment budget exhausted");
  const parts = [`${annotated} receipt annotation(s), ${records.length} record entrie(s)`];
  if (run) {
    parts.push(`judged ${run.judged}, unjudged ${run.unjudged}, no-evidence ${run.noEvidence}`);
    parts.push(`budget ${exhausted ? "exhausted" : "ok"} (candidates ${run.candidatesUsed}, pairs ${run.pairsUsed}, ${run.latencyMs}ms)`);
  } else {
    parts.push(`budget ${exhausted ? "exhausted" : "ok"}`);
  }
  const div = formatDivergenceSummary(computeDivergence(receipts, records));
  if (div) parts.push(`divergence — ${div}`);
  const line = `Sleep judgments (${SLEEP_SUPPORT_QUESTION_SET}): ${parts.join("; ")}.`;
  return line.slice(0, 1200);
}

/** Convenience for production wiring: resolve env, check the master switch. */
export function sleepJudgmentConfig(): SleepJudgmentConfig {
  return resolveSleepJudgmentConfig(getAbmindEnv());
}
