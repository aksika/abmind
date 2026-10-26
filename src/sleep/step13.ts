/**
 * sleep/step13.ts — final review, repair, and acceptance (#1912).
 *
 * One final manifest step for the stepped levels, dispatched after all
 * loaded ordinary work and before settlement. The code owns the bounded
 * sequence; the model performs domain review and proposes repairs:
 *
 *  1. Build an owner-scoped evidence snapshot (outcomes, attempts,
 *     receipts, offered inputs, artifact versions — never raw prompts).
 *  2. The model returns structured findings, proposed repairs, or a
 *     proposed final verdict through the ordinary runtime, proposal-only.
 *  3. Code validates findings/targets and applies permitted repairs through
 *     the same domain validators, publication functions, and revision-safe
 *     mutation boundaries. Malformed, unauthorized, or stale proposals
 *     change nothing.
 *  4. Recompute completion evidence for affected work and its dependents;
 *     feed actual results into the next review round.
 *  5. Record a code-normalized final verdict only for the verified
 *     snapshot. After any writes, a subsequent model review is required
 *     before accepted/repaired-and-accepted. Deterministic integrity
 *     checks have precedence over the advisory model verdict.
 *
 * At most four step-13 model completions inside the shared budget.
 * Repairs that cannot be verified stay persisted but unreviewed/partial —
 * never falsely accepted. The supervisor makes no model call; this step is
 * the model acceptance, not the supervisor.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAbmindEnv } from "../env-schema.js";
import { localDate, localISO } from "../local-time.js";
import { logInfo, logWarn } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import { prepareStepDispatch } from "./step-prepare.js";
import { applyProposals, emptySnapshot } from "./proposals.js";
import type { ProposalOp, ProposalSnapshot } from "./proposals.js";
import { loadAcceptedReceipts, persistProposalReceipts } from "./proposals.js";
import { getMemoryDb } from "../memory-manager.js";
import { readReceipts } from "./receipts.js";
import type { WriteReceipt } from "./receipts.js";
import { readDailyArtifact, readDailyArtifactRaw } from "./sleep-extract-daily.js";
import { consolidationFileName } from "./sleep-daily-summary.js";
import { sendToRuntime, isSleepModelFailure, MAX_DOMAIN_RETRIES } from "./llm-budget.js";
import type { SleepModelFailureError } from "./llm-budget.js";
import { failedEssentials } from "./sleep-manifest.js";
import { sleepStepDeadlineMs } from "./step-deadlines.js";
import { writeStateFile } from "./state.js";
import type { AcceptanceVerdict, SleepState, StepAcceptance } from "./state.js";
import { toBoundedFailure, failureFromError } from "./failure-report.js";
import type { StepRunScratch, StepUnitContext, StepUnitOutcome } from "./step-units.js";

const TAG = "abmind-sleep";
export const REVIEW_STEP_NAME = "review-and-repair";
/** Ordinary work stops here to leave review slots inside the total budget. */
export const STEP13_RESERVE_CALLS = 2;

const EVIDENCE_ARTIFACT_CHARS = 6000;
const REPAIR_BODY_CHARS = 8192;
const FOOTER_MARKER = "\n## Sleep review\n";

function sha12(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex").slice(0, 12);
}

/** Content version of the daily artifact EXCLUDING the bookkeeping footer —
 *  adding the verdict must not invalidate its own snapshot. */
export function reviewContentOf(raw: string): string {
  const idx = raw.lastIndexOf(FOOTER_MARKER);
  return idx === -1 ? raw : raw.slice(0, idx);
}

export function stripSleepReviewFooter(raw: string): string {
  return reviewContentOf(raw);
}

/** Render the footer from persisted facts, never from model Markdown. */
export function renderSleepReviewFooter(input: {
  verdict: AcceptanceVerdict; runId: string; snapshotId: string; at: number;
  repairsAccepted: number; repairNotes: string[]; remainingIssues: string[];
}): string {
  const shortRun = input.runId.slice(0, 8);
  const lines = [
    `## Sleep review`,
    ``,
    `Verdict: ${input.verdict} (run ${shortRun}, snapshot ${input.snapshotId}, ${localISO(new Date(input.at))})`,
  ];
  if (input.repairsAccepted > 0 || input.repairNotes.length > 0) {
    const notes = input.repairNotes.slice(0, 5).join("; ").slice(0, 300);
    lines.push(`Repaired: ${input.repairsAccepted} fault(s)${notes ? `: ${notes}` : ""}.`);
  } else {
    lines.push(`Repaired: no faults needed repair.`);
  }
  if (input.remainingIssues.length > 0) {
    lines.push(`Remaining: ${input.remainingIssues.slice(0, 5).join("; ").slice(0, 400)}`);
  } else {
    lines.push(`Remaining: none.`);
  }
  return `\n${lines.join("\n")}\n`;
}

/**
 * Idempotent footer upsert bound to run lineage and artifact version:
 * reconcile (strip any prior footer) before replacing, never duplicate.
 * Returns the artifact path, or null when the write failed.
 */
export function upsertSleepReviewFooter(dailyPath: string, footer: string, runId: string): string | null {
  try {
    const current = readDailyArtifactRaw(dailyPath);
    if (current === null) return null;
    const next = `${stripSleepReviewFooter(current).replace(/\s+$/, "")}\n${footer}`;
    if (next === current) return dailyPath; // already footered for this verdict
    writeFileSync(dailyPath, redactSecrets(next), "utf-8");
    // Reconcile: the footer must be terminal and singular.
    const check = readDailyArtifactRaw(dailyPath) ?? "";
    if (!check.endsWith(footer) || check.split(FOOTER_MARKER).length - 1 !== 1) {
      logWarn(TAG, `[SLEEP] review footer reconcile failed for ${dailyPath} (run ${runId.slice(0, 8)})`);
      return null;
    }
    return dailyPath;
  } catch (err) {
    logWarn(TAG, `[SLEEP] review footer write failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** No daily artifact: the same section goes into the existing run/audit
 *  report — never a fabricated daily summary. Mirrors the audit target
 *  resolution (latest sleep_<today>.md, else a standalone file). */
export function appendReviewToAuditReport(memoryDir: string, footer: string): string | null {
  try {
    const sleepDir = join(memoryDir, "sleep");
    mkdirSync(sleepDir, { recursive: true });
    const today = localDate().replace(/-/g, "");
    const files = readdirSync(sleepDir).filter(f => f.startsWith(`sleep_${today}`) && f.endsWith(".md")).sort();
    const target = files.length > 0
      ? join(sleepDir, files[files.length - 1]!)
      : join(sleepDir, `sleep_${today}_${new Date().toTimeString().slice(0, 5).replace(/:/g, "")}.md`);
    if (!existsSync(target)) {
      writeFileSync(target, `# Sleep Audit Log\n`, "utf-8");
    }
    const current = readFileSync(target, "utf-8");
    const next = `${stripSleepReviewFooter(current).replace(/\s+$/, "")}\n${footer}`;
    if (next === current) return target;
    writeFileSync(target, redactSecrets(next), "utf-8");
    return target;
  } catch (err) {
    logWarn(TAG, `[SLEEP] review audit fallback failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ── Evidence snapshot ──────────────────────────────────────────────────────

export interface ReviewEvidence {
  text: string;
  snapshotId: string;
  dailyPath: string | null;
  dailyVersion: string | null;
}

function stepLine(state: SleepState, name: string): string {
  const s = state.steps[name];
  if (!s) return `- ${name}: not-run`;
  const parts = [`${name}: ${s.status}`, `attempts=${s.attempts ?? 1}`];
  if (s.failure) {
    const f = s.failure;
    const detail = f.detail ? `: ${f.detail.slice(0, 80)}` : "";
    const cls = f.failureClass ? ` [${f.failureClass}]` : "";
    parts.push(`cause=${f.cause}${cls}${detail}`);
  }
  if (s.path) parts.push(`path=${s.path}`);
  return `- ${parts.join(" ")}`;
}

/** Owner-scoped evidence snapshot: outcomes, attempts, blockers, receipts,
 *  offered inputs, and artifact versions with stable references. Bounded;
 *  unavailable or truncated evidence is recorded explicitly. */
export function buildReviewEvidence(input: {
  state: SleepState;
  stepOrder: readonly string[];
  memoryDir: string;
  runId: string;
  priorRunId: string | null;
  level: string;
  scratch: StepRunScratch;
  now: () => number;
  /** #1912: prior repair-round results, fed into the post-write review so
   *  the verifying snapshot judges actual outcomes and refreshed versions —
   *  never the pre-repair state. */
  repairContext?: {
    round: number;
    notes: readonly string[];
    issues: readonly string[];
    artifactChangedFrom: string | null;
  };
}): ReviewEvidence {
  const { state, stepOrder, memoryDir, runId, priorRunId, level, scratch, now } = input;
  const lines: string[] = [];
  lines.push(`Run ${runId}${priorRunId ? ` (resume of ${priorRunId})` : ""}, level ${level}, budget ${state.llmCalls}/${getAbmindEnv().sleepMaxLlmCalls}.`);
  lines.push(`Steps:`);
  for (const name of stepOrder) lines.push(stepLine(state, name));

  let receipts: WriteReceipt[] = [];
  try {
    receipts = readReceipts(memoryDir, runId);
  } catch { lines.push(`Receipts: unavailable (receipt file unreadable).`); }
  if (receipts.length > 0) {
    const byStep = new Map<string, Map<string, number>>();
    for (const r of receipts.slice(0, 2000)) {
      let m = byStep.get(r.step);
      if (!m) { m = new Map(); byStep.set(r.step, m); }
      m.set(r.disposition, (m.get(r.disposition) ?? 0) + 1);
    }
    lines.push(`Receipts (${receipts.length}):`);
    for (const [step, counts] of byStep) {
      lines.push(`- ${step}: ${[...counts].map(([d, n]) => `${n} ${d}`).join(", ")}`);
    }
  } else {
    lines.push(`Receipts: none recorded.`);
  }

  const offered: string[] = [];
  for (const [step, snap] of scratch.proposalByStep) {
    offered.push(`${step}: ${snap.shown.size} shown id(s), ${snap.pairs.size} pair link(s)`);
  }
  lines.push(offered.length > 0 ? `Offered inputs: ${offered.join("; ")}.` : `Offered inputs: no fenced snapshots retained.`);

  // Failed steps may carry model output that never became evidence (e.g.
  // prose without a required append). Include bounded excerpts, explicitly
  // marked unverified, so the reviewer can repair from them — excerpts are
  // repair material, never completion evidence.
  for (const [name, s] of Object.entries(state.steps)) {
    if (s.status !== "failed" && s.status !== "timeout") continue;
    const output = scratch.vars[`${name.toUpperCase().replace(/-/g, "_")}_OUTPUT`];
    if (typeof output === "string" && output.length > 0) {
      const excerpt = output.slice(0, 1000);
      lines.push(`Unverified model output for failed step ${name}${output.length > 1000 ? ` (truncated ${output.length - 1000} chars)` : ""}:\n${excerpt}`);
    }
  }

  let dailyPath: string | null = null;
  let dailyVersion: string | null = null;
  const bound = scratch.dailySummaryPath;
  if (bound) {
    const raw = readDailyArtifactRaw(bound);
    if (raw === null) {
      lines.push(`Daily artifact ${bound}: unavailable (missing or unreadable).`);
    } else {
      dailyPath = bound;
      const content = reviewContentOf(raw);
      dailyVersion = sha12(content);
      const usable = readDailyArtifact(bound).usable;
      lines.push(`Daily artifact ${bound}: version ${dailyVersion}, usable=${usable}.`);
      const excerpt = content.slice(0, EVIDENCE_ARTIFACT_CHARS);
      lines.push(`Daily content${content.length > EVIDENCE_ARTIFACT_CHARS ? ` (truncated ${content.length - EVIDENCE_ARTIFACT_CHARS} chars)` : ""}:\n${excerpt}`);
    }
  } else {
    lines.push(`Daily artifact: none bound this run.`);
  }

  const rc = input.repairContext;
  if (rc) {
    lines.push(`Repairs applied in round ${rc.round}: ${rc.notes.slice(0, 5).join("; ").slice(0, 300) || "none recorded"}.`);
    if (rc.issues.length > 0) {
      lines.push(`Refused/errored repairs in round ${rc.round}: ${rc.issues.slice(0, 5).join("; ").slice(0, 300)}.`);
    }
    if (rc.artifactChangedFrom !== null && dailyVersion !== null && rc.artifactChangedFrom !== dailyVersion) {
      const dependents = stepOrder.filter(n =>
        (n === "extract-memories" || n === "retro-derive" || n === "consolidation" || n === "skill-review" || n === "retrospective")
        && state.steps[n]?.status === "ok");
      lines.push(`Daily artifact changed by repair: version ${rc.artifactChangedFrom} → ${dailyVersion}.`
        + (dependents.length > 0
          ? ` Steps that ran against the prior version and may need revalidation: ${dependents.join(", ")}.`
          : ""));
    }
  }

  const text = lines.join("\n").slice(0, 12_000);
  const snapshotId = sha12(JSON.stringify({
    runId, steps: stepOrder.map(n => state.steps[n] ?? null),
    receipts: receipts.length, offered, dailyPath, dailyVersion, at: now(),
  }));
  return { text: `${text}\nSnapshot: ${snapshotId}`, snapshotId, dailyPath, dailyVersion };
}

// ── Model response parsing ─────────────────────────────────────────────────

export interface ParsedFinding {
  step: string;
  issue: string;
  detail: string;
  invalidTarget: boolean;
}

export interface ParsedArtifactRepair {
  path: string;
  base: string;
  body: string;
}

export interface ParsedReview {
  findings: ParsedFinding[];
  verbLines: string[];
  artifactRepairs: ParsedArtifactRepair[];
  retrySteps: string[];
  proposedVerdict: { verdict: AcceptanceVerdict; reason: string } | null;
  malformedVerdict: boolean;
}

const FINDING_RE = /^FINDING\s+step=(\S+)\s+issue=(\S+)\s+detail="(.*)"\s*$/;
const VERDICT_RE = /^VERDICT:\s*(accepted|partial|blocked)\s+reason="(.*)"\s*$/;
const ARTIFACT_RE = /^ARTIFACT_APPEND\s+path=(\S+)\s+base=([0-9a-f]{12})\s*$/;
const RETRY_RE = /^RETRY_STEP\s+step=([A-Za-z0-9_-]+)\s*$/;
const VERB_RE = /^(PROPOSE_STORE|DECLINE|CONTRADICT|RELATION|PROMOTE|RETRO_INVALIDATE|TOPIC|MERGE_KEEP|EMOTION_CONTEXT|TRANSLATION_FIX|RELEVANCE|OBSERVE|KNOWLEDGE_ADD|KNOWLEDGE_REMOVE|KNOWLEDGE_UPDATE)\b/;

/** Parse one model review response. Never throws — unparseable sections
 *  are ignored, and a missing/malformed verdict is reported explicitly. */
export function parseReviewResponse(response: string, stepOrder: readonly string[]): ParsedReview {
  const findings: ParsedFinding[] = [];
  const verbLines: string[] = [];
  const artifactRepairs: ParsedArtifactRepair[] = [];
  const retrySteps: string[] = [];
  let proposedVerdict: ParsedReview["proposedVerdict"] = null;
  let malformedVerdict = false;
  const lines = response.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();
    i++;
    if (!line) continue;
    const f = FINDING_RE.exec(line);
    if (f) {
      const step = (f[1] ?? "").slice(0, 64);
      const issue = (f[2] ?? "").slice(0, 40);
      const detail = (f[3] ?? "").slice(0, 200);
      const invalidTarget = step !== "-" && !stepOrder.includes(step) && step !== REVIEW_STEP_NAME;
      findings.push({ step, issue, detail, invalidTarget });
      continue;
    }
    const v = VERDICT_RE.exec(line);
    if (v) {
      if (proposedVerdict === null) {
        proposedVerdict = { verdict: v[1] as AcceptanceVerdict, reason: (v[2] ?? "").slice(0, 200) };
      }
      continue;
    }
    if (/^VERDICT:/.test(line)) { malformedVerdict = true; continue; }
    const a = ARTIFACT_RE.exec(line);
    if (a) {
      const body: string[] = [];
      let terminated = false;
      while (i < lines.length) {
        const candidate = lines[i] ?? "";
        i++;
        if (candidate.trim() === "END_ARTIFACT_APPEND") { terminated = true; break; }
        body.push(candidate);
        if (body.join("\n").length > REPAIR_BODY_CHARS + 100) break;
      }
      if (terminated) {
        artifactRepairs.push({ path: a[1] ?? "", base: a[2] ?? "", body: body.join("\n") });
      }
      continue;
    }
    const r = RETRY_RE.exec(line);
    if (r && r[1]) { retrySteps.push(r[1]); continue; }
    if (VERB_RE.test(line)) verbLines.push(line);
  }
  return { findings, verbLines, artifactRepairs, retrySteps, proposedVerdict, malformedVerdict };
}

// ── Repair application ─────────────────────────────────────────────────────

export interface Step13Extras {
  state: SleepState;
  statePath: string;
  stepOrder: readonly string[];
  level: string;
  terminal: { stepId: string; reason: string } | null;
  /** Code-owned re-dispatch of an ordinary step for RETRY_STEP repairs.
   *  Applies the disposition to shared state like the main loop. Throws
   *  Step13Halt when the re-run aborts or terminates the cycle — the
   *  review sequence must stop, never swallow it as a repair issue. */
  redispatch: (stepName: string) => Promise<StepUnitOutcome>;
}

/** Thrown by the redispatch callback when a re-offered step aborts the
 *  run or terminates it (provider loss). Propagates through repair
 *  application to the review sequence, which stops honestly. */
export class Step13Halt extends Error {
  readonly outcome: "aborted" | "terminal";
  constructor(outcome: "aborted" | "terminal") {
    super(`step-13 re-dispatch halted the review (${outcome})`);
    this.name = "Step13Halt";
    this.outcome = outcome;
  }
}

function combinedSnapshot(scratch: StepRunScratch, stepOrder: readonly string[]): ProposalSnapshot {
  const combined = emptySnapshot(scratch.proposal?.runId ?? "", REVIEW_STEP_NAME, "", []);
  const ops = new Set<ProposalOp>();
  for (const name of stepOrder) {
    const snap = scratch.proposalByStep.get(name);
    if (!snap) continue;
    if (!combined.principal && snap.principal) (combined as { principal: string }).principal = snap.principal;
    for (const op of snap.eligible) ops.add(op);
    for (const [id, rev] of snap.shown) combined.shown.set(id, rev);
    for (const [newId, olds] of snap.pairs) {
      const set = combined.pairs.get(newId) ?? new Set<number>();
      for (const o of olds) set.add(o);
      combined.pairs.set(newId, set);
    }
    for (const [k, v] of snap.knowledge) combined.knowledge.set(k, v);
    for (const [k, v] of snap.knowledgeUnavailable) {
      if (!combined.knowledge.has(k)) combined.knowledgeUnavailable.set(k, v);
    }
    for (const id of snap.currentRunNew) combined.currentRunNew.add(id);
  }
  combined.eligible = ops;
  return combined;
}

export interface RepairOutcome {
  accepted: number;
  notes: string[];
  issues: string[];
  writesMade: boolean;
  /** Verb-boundary receipts from this round (artifact appends carry none). */
  receipts: WriteReceipt[];
}

/**
 * Apply validated repairs from one parsed review. Verb lines run through
 * the same revision-checked proposal boundary against the combined
 * evidenced snapshot; artifact appends bind exact path/version with
 * prefix preservation; RETRY_STEP re-offers through the fixed action map.
 * Malformed, unauthorized, or stale proposals change nothing.
 */
export async function applyStep13Repairs(input: {
  ctx: StepUnitContext;
  extras: Step13Extras;
  parsed: ParsedReview;
  evidence: ReviewEvidence;
}): Promise<RepairOutcome> {
  const { ctx, extras, parsed, evidence } = input;
  const notes: string[] = [];
  const issues: string[] = [];
  const verbReceipts: WriteReceipt[] = [];
  let accepted = 0;
  let writesMade = false;

  if (parsed.verbLines.length > 0) {
    const memDb = getMemoryDb(ctx.memory);
    if (!memDb) {
      issues.push("memory database unavailable — verb repairs refused");
    } else {
      const snapshot = combinedSnapshot(ctx.scratch, extras.stepOrder);
      snapshot.runId = ctx.runId;
      try {
        const applied = await applyProposals(
          {
            db: memDb,
            sleepData: ctx.sleepData,
            memoryDir: ctx.memoryDir,
            snapshot,
            alreadyAccepted: loadAcceptedReceipts(ctx.memoryDir, [ctx.runId, ctx.priorRunId], REVIEW_STEP_NAME),
            now: ctx.now,
          },
          parsed.verbLines.join("\n"),
        );
        persistProposalReceipts(ctx.memoryDir, applied.receipts);
        verbReceipts.push(...applied.receipts);
        const okCount = applied.receipts.filter(r => r.disposition === "accepted").length;
        const rejCount = applied.receipts.filter(r => r.disposition === "rejected").length;
        accepted += okCount;
        if (okCount > 0) writesMade = true;
        notes.push(`${okCount} verb repair(s) accepted, ${rejCount} rejected`);
        const firstReject = applied.receipts.find(r => r.disposition === "rejected");
        if (firstReject?.reason) issues.push(`refused repair: ${firstReject.reason.slice(0, 120)}`);
      } catch (err) {
        issues.push(`verb repair application failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160));
      }
    }
  }

  for (const repair of parsed.artifactRepairs.slice(0, 4)) {
    if (evidence.dailyPath === null || repair.path !== evidence.dailyPath) {
      issues.push(`artifact repair refused: path is not the bound daily artifact`);
      continue;
    }
    const raw = readDailyArtifactRaw(evidence.dailyPath);
    if (raw === null || sha12(reviewContentOf(raw)) !== repair.base) {
      issues.push(`artifact repair refused: stale base version for ${repair.path}`);
      continue;
    }
    const body = repair.body.replace(/\s+$/, "").slice(0, REPAIR_BODY_CHARS);
    if (!body) {
      issues.push(`artifact repair refused: empty body`);
      continue;
    }
    // Append to the content WITHOUT any prior bookkeeping footer: a repaired
    // body written after an old footer would be destroyed by the next footer
    // upsert (which reconciles from the last marker). The base check above
    // already validated the stripped content version.
    const stripped = stripSleepReviewFooter(raw);
    try {
      writeFileSync(evidence.dailyPath, `${stripped.replace(/\s+$/, "")}\n${body}\n`, "utf-8");
      const after = readDailyArtifactRaw(evidence.dailyPath) ?? "";
      if (!after.startsWith(stripped)) {
        issues.push(`artifact repair failed prefix check — left for resume`);
        continue;
      }
      accepted++;
      writesMade = true;
      notes.push(`daily artifact appended (${body.length} chars)`);
    } catch (err) {
      issues.push(`artifact repair write failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 160));
    }
  }

  for (const target of parsed.retrySteps.slice(0, 4)) {
    if (target === REVIEW_STEP_NAME) {
      issues.push(`RETRY_STEP refused: the review step cannot re-offer itself`);
      continue;
    }
    if (!extras.stepOrder.includes(target)) {
      issues.push(`RETRY_STEP refused: unknown step ${target.slice(0, 40)}`);
      continue;
    }
    if (ctx.budget.callsFor(target) >= MAX_DOMAIN_RETRIES) {
      issues.push(`RETRY_STEP refused: ${target} allowance exhausted — unresolved work preserved for resume`);
      continue;
    }
    try {
      const outcome = await extras.redispatch(target);
      if (outcome.kind === "ok") {
        notes.push(`${target} re-offered successfully`);
        writesMade = true;
      } else if (outcome.kind === "terminal" || outcome.kind === "aborted") {
        issues.push(`${target} re-offer did not complete (${outcome.kind})`);
        break;
      } else if (outcome.kind === "failed") {
        issues.push(`${target} re-offer failed: ${(outcome.failure.detail ?? outcome.failure.cause).slice(0, 120)}`);
      }
    } catch (err) {
      if (err instanceof Step13Halt) throw err;
      issues.push(`${target} re-offer errored: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120));
    }
  }

  return { accepted, notes, issues, writesMade, receipts: verbReceipts };
}

// ── Disposition recomputation ────────────────────────────────────────────
/** Append proof that tolerates the bookkeeping footer: compares the
 *  non-footer content, so a repair that had to strip a prior footer still
 *  proves prefix preservation against the pre-repair bytes. */
function appendedBeyondFooter(path: string, beforeRaw: string | null): boolean {
  if (beforeRaw === null) return false;
  const current = readDailyArtifactRaw(path);
  if (current === null) return false;
  const currentContent = stripSleepReviewFooter(current);
  const beforeContent = stripSleepReviewFooter(beforeRaw);
  return currentContent.length > beforeContent.length
    && currentContent.startsWith(beforeContent)
    && currentContent.slice(beforeContent.length).trim().length > 0;
}

/**
 * Recompute step dispositions after verified recovery. Failed attempts stay
 * in history (attempt counts, repair log), but a sticky first-failure flag
 * must not block a now-complete step: artifact evidence is re-verified and
 * fenced steps with fresh accepted dispositions flip back to ok. Aggregate
 * failure gates are recomputed from this unresolved evidence at settlement.
 * Returns the flipped step names for the repair notes.
 */
export function recomputeDispositionsAfterRepair(input: {
  ctx: StepUnitContext;
  extras: Step13Extras;
  reviewReceipts: WriteReceipt[];
}): string[] {
  const { ctx, extras, reviewReceipts } = input;
  const { state, statePath } = extras;
  const flipped: string[] = [];
  const flip = (name: string): void => {
    const s = state.steps[name];
    if (!s || (s.status !== "failed" && s.status !== "timeout")) return;
    const { failure: _dropped, ...rest } = s;
    void _dropped;
    state.steps[name] = { ...rest, status: "ok" };
    flipped.push(name);
  };

  // Artifact-backed steps: re-verify the append/publication evidence.
  const dailyPath = ctx.scratch.dailySummaryPath;
  if (dailyPath) {
    const retroBefore = ctx.scratch.retrospectiveBeforeContent;
    if (retroBefore !== null && appendedBeyondFooter(dailyPath, retroBefore)) flip("retrospective");
    const skillBefore = ctx.scratch.skillReviewBeforeContent;
    if (skillBefore !== null && appendedBeyondFooter(dailyPath, skillBefore)) {
      const current = stripSleepReviewFooter(readDailyArtifactRaw(dailyPath) ?? "");
      const beforeContent = stripSleepReviewFooter(skillBefore);
      if (current.slice(beforeContent.length).includes("## Recommended skills")) flip("skill-review");
    }
  }
  const target = ctx.scratch.consolidation;
  if (target !== null) {
    const published = join(ctx.memoryDir, target.tier, consolidationFileName(target.tier, target.period));
    if (existsSync(published)) flip("consolidation");
  }
  if (flipped.length > 0 || reviewReceipts.length > 0) {
    // Fenced steps: fresh accepted dispositions for their shown work complete them.
    for (const [name, snap] of ctx.scratch.proposalByStep) {
      const s = state.steps[name];
      if (!s || (s.status !== "failed" && s.status !== "timeout")) continue;
      const shown = snap.shown;
      const repaired = reviewReceipts.some(r =>
        r.disposition === "accepted"
        && ((typeof r.memoryId === "number" && shown.has(r.memoryId))
          || (typeof r.source === "number" && shown.has(r.source))));
      if (repaired) flip(name);
    }
  }
  if (flipped.length > 0) writeStateFile(statePath, state);
  return flipped;
}

// ── Verdict ────────────────────────────────────────────────────────────────
function concreteBlocker(state: SleepState): string | null {
  for (const [name, s] of Object.entries(state.steps)) {
    const cls = s.failure?.failureClass;
    if (s.status !== "failed" && s.status !== "timeout") continue;
    if (cls === "permanent" || cls === "unavailable" || cls === "cancelled") {
      return `${name}: ${s.failure?.cause}${s.failure?.detail ? ` — ${s.failure.detail.slice(0, 80)}` : ""}`;
    }
  }
  return null;
}

/**
 * Code-normalized verdict. Deterministic integrity evidence has precedence:
 * receipts, required checks, source coverage, cancellation, and unknown
 * outcomes all beat the advisory model verdict, which may only downgrade.
 */
export function normalizeVerdict(input: {
  state: SleepState;
  stepOrder: readonly string[];
  validReview: boolean;
  writesMade: boolean;
  verifiedAfterWrite: boolean;
  repairsAccepted: number;
  groundedDowngrade: AcceptanceVerdict | null;
  failureDetails: string[];
}): { verdict: AcceptanceVerdict; remainingIssues: string[] } {
  const { state, stepOrder, validReview } = input;
  const remainingIssues: string[] = [...input.failureDetails].slice(0, 10);
  if (!validReview) {
    if (input.writesMade) remainingIssues.push("repairs persisted without a verifying review — resume to verify");
    return { verdict: "unreviewed", remainingIssues: remainingIssues.slice(0, 10) };
  }
  // Suspended or broken runs leave steps undispatched (no entry at all) —
  // unrun work is incomplete work, never silent success. Resume dispatches it.
  const unrun = stepOrder.filter(n => n !== REVIEW_STEP_NAME && state.steps[n] === undefined);
  const failedSteps = Object.entries(state.steps)
    .filter(([, s]) => s.status === "failed" || s.status === "timeout")
    .map(([name, s]) => `${name}: ${s.failure?.cause ?? "failed"}${s.failure?.detail ? ` — ${s.failure.detail.slice(0, 80)}` : ""}`);
  const essentials = failedEssentials(state);
  if (failedSteps.length > 0 || essentials.length > 0 || unrun.length > 0) {
    const blocker = concreteBlocker(state);
    for (const f of failedSteps.slice(0, 6)) remainingIssues.push(f);
    for (const u of unrun.slice(0, 6)) remainingIssues.push(`${u}: undispatched — preserved for resume`);
    if (blocker !== null) return { verdict: "blocked", remainingIssues: remainingIssues.slice(0, 10) };
    // A grounded model verdict may only lower partial toward blocked here.
    if (input.groundedDowngrade === "blocked") return { verdict: "blocked", remainingIssues: remainingIssues.slice(0, 10) };
    return { verdict: "partial", remainingIssues: remainingIssues.slice(0, 10) };
  }
  if (input.groundedDowngrade === "partial" || input.groundedDowngrade === "blocked") {
    return { verdict: input.groundedDowngrade, remainingIssues: remainingIssues.slice(0, 10) };
  }
  if (input.writesMade && !input.verifiedAfterWrite) {
    remainingIssues.push("repairs applied without verification allowance — resume to verify");
    return { verdict: "unreviewed", remainingIssues: remainingIssues.slice(0, 10) };
  }
  return {
    verdict: input.repairsAccepted > 0 ? "repaired_and_accepted" : "accepted",
    remainingIssues: remainingIssues.slice(0, 10),
  };
}

// ── Step unit ──────────────────────────────────────────────────────────────

export interface Step13RunInput {
  extras: Step13Extras;
  stepLogDir: string;
  stepIndex: number;
  startMs: number;
  stepDeadlineAt: number;
}

function durationS(elapsedMs: number): number {
  return Math.round(elapsedMs / 100) / 10;
}

/**
 * Run the bounded review/repair/verification sequence as the final
 * dispatched work. Uses ordinary SleepRuntime.complete requests with
 * proposal-only capability required — a domain step, not infrastructure.
 */
export async function runReviewRepairStep(ctx: StepUnitContext, input: Step13RunInput): Promise<StepUnitOutcome> {
  const { extras, stepLogDir, stepIndex, startMs, stepDeadlineAt } = input;
  const { state, statePath } = extras;
  const stepName = REVIEW_STEP_NAME;

  const recordAcceptance = (acceptance: StepAcceptance): void => {
    state.acceptance = acceptance;
    writeStateFile(statePath, state);
  };

  // Existing no-work / already-running / preflight-refusal / cancellation
  // exits never require a model call — but this unit only runs post-loop on
  // a serviceable path; an aborted signal still short-circuits honestly.
  if (ctx.signal.aborted) return { kind: "aborted" };

  let evidence = buildReviewEvidence({
    state, stepOrder: extras.stepOrder, memoryDir: ctx.memoryDir,
    runId: ctx.runId, priorRunId: ctx.priorRunId, level: extras.level,
    scratch: ctx.scratch, now: ctx.now,
  });
  // Bind the evidence snapshot as a template variable before dispatch —
  // an unbound variable fails preparation instead of reaching the model.
  const prepared = prepareStepDispatch(stepName, ctx.rawPrompt, { ...ctx.scratch.vars, REVIEW_EVIDENCE: evidence.text });
  if (prepared.status !== "ready") {
    const detail = prepared.status === "no_work" ? prepared.reason : prepared.detail;
    recordAcceptance({
      verdict: "unreviewed", at: ctx.now(),
      remainingIssues: [`final review not dispatched: ${detail}`.slice(0, 200)],
    });
    return { kind: "failed", durationS: durationS(Date.now() - startMs), failure: toBoundedFailure("unknown", `final review preparation failed: ${detail}`), stopWhenEssential: false };
  }
  const reviewPrompt = ctx.scratch.soulPrefix + prepared.prompt;
  if (ctx.scratch.soulPrefix) ctx.scratch.soulPrefix = "";

  const repairLog: Array<Record<string, unknown>> = [];
  let writesMade = false;
  let repairsAccepted = 0;
  const repairNotes: string[] = [];
  const failureDetails: string[] = [];
  let groundedDowngrade: AcceptanceVerdict | null = null;
  let validReview = false;
  let verifiedAfterWrite = false;
  let lastWriteRound = -1;
  let lastReviewRound = -1;
  let round = 0;

  for (;;) {
    const used = ctx.budget.callsFor(stepName);
    if (used >= MAX_DOMAIN_RETRIES) break;
    round++;
    let response: string | null;
    try {
      response = await sendToRuntime(ctx.runtime, reviewPrompt, stepName, ctx.runId, ctx.signal, stepDeadlineAt, ctx.budget, ctx.retryDelays, ctx.now, {
        proposalOnly: true, cycleDeadlineAt: ctx.cycleDeadlineAt, maxAttempts: Math.max(1, MAX_DOMAIN_RETRIES - used),
      });
    } catch (err) {
      if (isSleepModelFailure(err)) {
        const reason = (err as SleepModelFailureError).reason;
        failureDetails.push(`final review ${reason}: ${(err as Error).message.slice(0, 120)}`);
        const failure = failureFromError(err, "unknown");
        recordAcceptance({ verdict: "unreviewed", snapshotId: evidence.snapshotId, at: ctx.now(), findings: 0, repairsAccepted, remainingIssues: failureDetails.slice(0, 10) });
        if (reason === "invalid_response") {
          return { kind: "failed", durationS: durationS(Date.now() - startMs), failure, stopWhenEssential: false };
        }
        return { kind: "terminal", elapsedMs: Date.now() - startMs, reason, failure };
      }
      throw err;
    }
    if (ctx.signal.aborted) return { kind: "aborted" };
    if (!response) {
      failureDetails.push("final review call returned no response (budget exhausted or suspended)");
      break;
    }

    ctx.scratch.acceptedOutputChars.set(stepName, response.length);
    writeFileSync(join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.round${round}.md`), redactSecrets(response), "utf-8");

    const parsed = parseReviewResponse(response, extras.stepOrder);
    const validFindings = parsed.findings.filter(f => !f.invalidTarget);
    for (const f of parsed.findings) {
      if (f.invalidTarget) failureDetails.push(`invalid finding target ignored: ${f.step.slice(0, 40)}`);
    }
    repairLog.push({ round, snapshotId: evidence.snapshotId, findings: validFindings.length, repairs: parsed.verbLines.length + parsed.artifactRepairs.length + parsed.retrySteps.length });
    if (parsed.malformedVerdict || (parsed.proposedVerdict === null && parsed.findings.length === 0 && parsed.verbLines.length === 0 && parsed.artifactRepairs.length === 0 && parsed.retrySteps.length === 0)) {
      failureDetails.push("final review response carried no parseable findings, repairs, or verdict");
      continue;
    }
    validReview = true;
    lastReviewRound = round;
    if (lastWriteRound !== -1 && lastReviewRound > lastWriteRound) verifiedAfterWrite = true;

    // The advisory verdict may only downgrade, and only when grounded in a
    // valid finding of the same round — never upgrade past code evidence.
    // Each parseable round supersedes the last: a verifying round that
    // accepts lifts an earlier repair-pending downgrade.
    groundedDowngrade = parsed.proposedVerdict !== null
      && (parsed.proposedVerdict.verdict === "partial" || parsed.proposedVerdict.verdict === "blocked")
      && validFindings.length > 0
      ? parsed.proposedVerdict.verdict
      : null;
    if (groundedDowngrade !== null) {
      failureDetails.push(`reviewer downgrade: ${(parsed.proposedVerdict?.reason ?? "").slice(0, 140)}`);
    }

    let outcome: RepairOutcome;
    const priorDailyVersion = evidence.dailyVersion;
    try {
      outcome = await applyStep13Repairs({ ctx, extras, parsed, evidence });
    } catch (err) {
      // A halted re-dispatch stops the review honestly — the orchestrator
      // already recorded the terminal state; an abort suspends the run.
      if (err instanceof Step13Halt) {
        if (err.outcome === "aborted") return { kind: "aborted" };
        // Provider loss during a re-offer invalidates earlier reviews of a
        // superseded snapshot — no valid review of the resulting state.
        validReview = false;
        verifiedAfterWrite = false;
        failureDetails.push("provider loss during final review — run preserved for resume");
        break;
      }
      throw err;
    }
    repairsAccepted += outcome.accepted;
    repairNotes.push(...outcome.notes);
    failureDetails.push(...outcome.issues);
    if (outcome.writesMade) {
      writesMade = true;
      lastWriteRound = round;
      verifiedAfterWrite = false;
      // Recompute current step dispositions from the recovered evidence —
      // a sticky first-failure flag must not block a now-complete step —
      // then rebuild the snapshot so fresh versions feed the next round.
      const flipped = recomputeDispositionsAfterRepair({ ctx, extras, reviewReceipts: outcome.receipts });
      for (const name of flipped) repairNotes.push(`${name} disposition recomputed to ok after verified recovery`);
      evidence = buildReviewEvidence({
        state, stepOrder: extras.stepOrder, memoryDir: ctx.memoryDir,
        runId: ctx.runId, priorRunId: ctx.priorRunId, level: extras.level,
        scratch: ctx.scratch, now: ctx.now,
        repairContext: { round, notes: outcome.notes, issues: outcome.issues, artifactChangedFrom: priorDailyVersion },
      });
    }
    if (!outcome.writesMade) break; // reviewed snapshot is final — record below
  }

  const { verdict, remainingIssues } = normalizeVerdict({
    state, stepOrder: extras.stepOrder, validReview, writesMade, verifiedAfterWrite, repairsAccepted, groundedDowngrade, failureDetails,
  });
  const at = ctx.now();
  const footer = renderSleepReviewFooter({
    verdict, runId: ctx.runId, snapshotId: evidence.snapshotId, at,
    repairsAccepted, repairNotes, remainingIssues,
  });
  // The footer goes to the bound daily artifact, or — when none exists —
  // to the existing run/audit report. Never a fabricated daily summary.
  // A failed footer write holds cleanup and is reported.
  let footerPath: string | null = null;
  if (evidence.dailyPath !== null) {
    footerPath = upsertSleepReviewFooter(evidence.dailyPath, footer, ctx.runId);
    if (footerPath === null) remainingIssues.push("review footer write failed — cleanup held");
  } else {
    footerPath = appendReviewToAuditReport(ctx.memoryDir, footer);
    if (footerPath === null) remainingIssues.push("review audit fallback failed — cleanup held");
  }

  try {
    writeFileSync(
      join(stepLogDir, `${String(stepIndex).padStart(2, "0")}-${stepName}.repairs.json`),
      redactSecrets(JSON.stringify(repairLog.slice(0, 20), null, 2)).slice(0, 8000),
      "utf-8",
    );
  } catch { /* bounded repair evidence is best-effort beside the lock */ }

  recordAcceptance({
    verdict, snapshotId: evidence.snapshotId, at,
    findings: repairLog.reduce((n, r) => n + ((r["findings"] as number) ?? 0), 0),
    repairsAccepted,
    ...(remainingIssues.length > 0 ? { remainingIssues: remainingIssues.slice(0, 10) } : {}),
    ...(footerPath !== null ? { footerPath } : {}),
  });
  logInfo(TAG, `[SLEEP] final review verdict: ${verdict} (snapshot ${evidence.snapshotId}, ${repairsAccepted} repair(s) accepted)`);
  return { kind: "ok", durationS: durationS(Date.now() - startMs) };
}

/** Per-attempt window for the final step from its manifest timeout. */
export function reviewStepDeadlineMs(): number {
  return sleepStepDeadlineMs(REVIEW_STEP_NAME);
}
