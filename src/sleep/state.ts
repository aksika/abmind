/**
 * sleep/state.ts — Sleep state types, state-file IO, wired pre-tasks, and
 * step-lifecycle event helpers.
 * Extracted from orchestrator.ts (#1229).
 */

import { existsSync, readFileSync } from "node:fs";
import { atomicWriteSync } from "../atomic-write.js";
import type { MemoryManager } from "../memory-manager.js";
import type { SleepDataAccess } from "../sleep-data-access.js";
import { redactSecrets } from "../redact-secrets.js";
import type { ExecutionEffects, ExecutionFailureClass, SleepFailure, SleepFailureCause } from "./contracts.js";
import { parseCoverageClaims } from "./coverage.js";
import type { CoverageClaim } from "./coverage.js";

// ── State file types ────────────────────────────────────────────────────────

export type StepStatus = "ok" | "failed" | "skipped" | "pending" | "timeout";
// #1860: optional coverage claims — evidence of the message ranges a step
// read, scoped to principal and session scope. Absent (legacy) means
// unclaimed, never covered.
export type StepResult = { status: StepStatus; duration?: number; attempts?: number; ctxBefore?: number; ctxAfter?: number; path?: string; essential?: boolean; failure?: import("./contracts.js").SleepFailure; claims?: CoverageClaim[] };
export type WiredResults = { purged: number; deduped: number; embedded: number; anomaliesFixed: number; walOk: boolean; ftsOk: boolean };
export type SleepStatus = "ongoing" | "completed" | "suspended" | "failed";
/** #1912: code-normalized final acceptance verdict. Only
 *  accepted/repaired_and_accepted enable normal destructive settlement;
 *  legacy checkpoints carry no verdict and must be reviewed after resume. */
export type AcceptanceVerdict = "accepted" | "repaired_and_accepted" | "partial" | "blocked" | "unreviewed";
export type StepAcceptance = {
  verdict: AcceptanceVerdict;
  /** Verified snapshot identity the verdict was recorded for. */
  snapshotId?: string;
  findings?: number;
  repairsAccepted?: number;
  /** Bounded remaining issues/blockers with reasons. */
  remainingIssues?: string[];
  /** Path carrying the rendered verdict (daily artifact or run/audit report). */
  footerPath?: string;
  at: number;
};
/** #1353: runId is the stable identity for one execution attempt. priorRunId
 *  records lineage when a run resumes a previous checkpoint (a resumed run
 *  gets its OWN new runId — it does not pretend to be the prior process). */
export type SleepState = { status: SleepStatus; pid: number; runId?: string; priorRunId?: string; startedAt: number; llmCalls: number; wiredResults?: WiredResults; steps: Record<string, StepResult>; acceptance?: StepAcceptance };

const SLEEP_STATUSES: ReadonlySet<string> = new Set(["ongoing", "completed", "suspended", "failed"]);
const STEP_STATUSES: ReadonlySet<string> = new Set(["ok", "failed", "skipped", "pending", "timeout"]);
const SLEEP_FAILURE_CAUSES: ReadonlySet<string> = new Set([
  "provider_failed", "provider_timeout", "step_deadline", "invalid_response",
  "prompt_round_limit", "candidate_round_limit", "candidate_exhausted", "policy_rejected",
  "nonzero_exit", "spawn_error", "timeout", "aborted", "shell_syntax_error", "repeated_failure",
  "memory_validation", "memory_not_found", "memory_conflict", "memory_unavailable",
  "memory_idempotency_conflict", "memory_unavailable", "memory_outcome_unknown",
  "completion_settlement_failed", "service_failed", "unknown",
]);
const FAILURE_CLASSES: ReadonlySet<string> = new Set(["transient", "permanent", "cancelled", "unavailable", "unknown"]);
const EXECUTION_EFFECTS: ReadonlySet<string> = new Set(["absent", "reconcilable", "unknown"]);
const ACCEPTANCE_VERDICTS: ReadonlySet<string> = new Set(["accepted", "repaired_and_accepted", "partial", "blocked", "unreviewed"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalNonNegativeNumber(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  return value;
}

function parseFailure(raw: unknown): SleepFailure | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || typeof raw.cause !== "string" || !SLEEP_FAILURE_CAUSES.has(raw.cause)) return null;
  const failure: SleepFailure = { cause: raw.cause as SleepFailureCause };
  if (raw.detail !== undefined) {
    if (typeof raw.detail !== "string") return null;
    const detail = redactSecrets(raw.detail).slice(0, 240);
    if (detail) failure.detail = detail;
  }
  if (raw.commandFingerprint !== undefined) {
    if (typeof raw.commandFingerprint !== "string" || !/^[0-9a-f]{16}$/i.test(raw.commandFingerprint)) return null;
    failure.commandFingerprint = raw.commandFingerprint;
  }
  // #1912: normalized execution facts — validated when present, absent on
  // legacy checkpoints. Malformed facts invalidate the failure, not the lock.
  if (raw.failureClass !== undefined) {
    if (typeof raw.failureClass !== "string" || !FAILURE_CLASSES.has(raw.failureClass)) return null;
    failure.failureClass = raw.failureClass as ExecutionFailureClass;
  }
  if (raw.retryAfterMs !== undefined) {
    if (typeof raw.retryAfterMs !== "number" || !Number.isSafeInteger(raw.retryAfterMs) || raw.retryAfterMs <= 0) return null;
    failure.retryAfterMs = Math.min(raw.retryAfterMs, 3_600_000);
  }
  if (raw.reachedModel !== undefined) {
    if (typeof raw.reachedModel !== "boolean") return null;
    failure.reachedModel = raw.reachedModel;
  }
  if (raw.effects !== undefined) {
    if (typeof raw.effects !== "string" || !EXECUTION_EFFECTS.has(raw.effects)) return null;
    failure.effects = raw.effects as ExecutionEffects;
  }
  if (raw.reasonCode !== undefined) {
    if (typeof raw.reasonCode !== "string") return null;
    const code = raw.reasonCode.slice(0, 80);
    if (code) failure.reasonCode = code;
  }
  return failure;
}

function parseStep(raw: unknown): StepResult | null {
  if (!isRecord(raw) || typeof raw.status !== "string" || !STEP_STATUSES.has(raw.status)) return null;
  const duration = optionalNonNegativeNumber(raw.duration);
  const attempts = optionalNonNegativeInteger(raw.attempts);
  const ctxBefore = optionalNonNegativeInteger(raw.ctxBefore);
  const ctxAfter = optionalNonNegativeInteger(raw.ctxAfter);
  if (duration === null || attempts === null || ctxBefore === null || ctxAfter === null) return null;
  if (raw.path !== undefined && typeof raw.path !== "string") return null;
  if (raw.essential !== undefined && typeof raw.essential !== "boolean") return null;
  const failure = parseFailure(raw.failure);
  if (failure === null) return null;
  // #1860: malformed claims are dropped (range stays unclaimed) rather than
  // invalidating the lock — see parseCoverageClaims.
  const claims = parseCoverageClaims(raw.claims);
  return {
    status: raw.status as StepStatus,
    ...(duration !== undefined ? { duration } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(ctxBefore !== undefined ? { ctxBefore } : {}),
    ...(ctxAfter !== undefined ? { ctxAfter } : {}),
    ...(raw.path !== undefined ? { path: raw.path } : {}),
    ...(raw.essential !== undefined ? { essential: raw.essential } : {}),
    ...(failure !== undefined ? { failure } : {}),
    ...(claims !== undefined ? { claims } : {}),
  };
}

function parseAcceptance(raw: unknown): StepAcceptance | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  if (typeof raw.verdict !== "string" || !ACCEPTANCE_VERDICTS.has(raw.verdict)) return null;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at) || raw.at < 0) return null;
  const out: StepAcceptance = { verdict: raw.verdict as AcceptanceVerdict, at: raw.at };
  if (raw.snapshotId !== undefined) {
    if (typeof raw.snapshotId !== "string" || raw.snapshotId.length === 0 || raw.snapshotId.length > 128) return null;
    out.snapshotId = raw.snapshotId;
  }
  if (raw.findings !== undefined) {
    if (typeof raw.findings !== "number" || !Number.isSafeInteger(raw.findings) || raw.findings < 0) return null;
    out.findings = raw.findings;
  }
  if (raw.repairsAccepted !== undefined) {
    if (typeof raw.repairsAccepted !== "number" || !Number.isSafeInteger(raw.repairsAccepted) || raw.repairsAccepted < 0) return null;
    out.repairsAccepted = raw.repairsAccepted;
  }
  if (raw.remainingIssues !== undefined) {
    if (!Array.isArray(raw.remainingIssues) || !raw.remainingIssues.every(i => typeof i === "string")) return null;
    out.remainingIssues = (raw.remainingIssues as string[]).slice(0, 20).map(i => redactSecrets(i).slice(0, 200));
  }
  if (raw.footerPath !== undefined) {
    if (typeof raw.footerPath !== "string" || raw.footerPath.length === 0 || raw.footerPath.length > 1024) return null;
    out.footerPath = raw.footerPath;
  }
  return out;
}

function parseWiredResults(raw: unknown): WiredResults | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  for (const key of ["purged", "deduped", "embedded", "anomaliesFixed"]) {
    if (typeof raw[key] !== "number" || !Number.isSafeInteger(raw[key]) || (raw[key] as number) < 0) return null;
  }
  if (typeof raw.walOk !== "boolean" || typeof raw.ftsOk !== "boolean") return null;
  return {
    purged: raw.purged as number,
    deduped: raw.deduped as number,
    embedded: raw.embedded as number,
    anomaliesFixed: raw.anomaliesFixed as number,
    walOk: raw.walOk,
    ftsOk: raw.ftsOk,
  };
}

function parseState(raw: unknown): SleepState | null {
  if (!isRecord(raw) || !isRecord(raw.steps)) return null;

  // The absent status/llmCalls forms are the only legacy defaults accepted.
  const status = raw.status === undefined ? "ongoing" : raw.status;
  if (typeof status !== "string" || !SLEEP_STATUSES.has(status)) return null;
  if (typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid < 1) return null;
  if (typeof raw.startedAt !== "number" || !Number.isFinite(raw.startedAt) || raw.startedAt < 0) return null;
  const llmCalls = raw.llmCalls == null ? 0 : raw.llmCalls;
  if (typeof llmCalls !== "number" || !Number.isSafeInteger(llmCalls) || llmCalls < 0) return null;
  const wiredResults = parseWiredResults(raw.wiredResults);
  if (wiredResults === null) return null;

  const runId = raw.runId === undefined ? undefined : raw.runId;
  const priorRunId = raw.priorRunId === undefined ? undefined : raw.priorRunId;
  if (runId !== undefined && (typeof runId !== "string" || runId.length === 0 || runId.length > 128)) return null;
  if (priorRunId !== undefined && (typeof priorRunId !== "string" || priorRunId.length === 0 || priorRunId.length > 128)) return null;

  const steps: Record<string, StepResult> = {};
  for (const [id, rawStep] of Object.entries(raw.steps)) {
    const step = parseStep(rawStep);
    if (!step || id.length === 0 || id.length > 128) return null;
    steps[id] = step;
  }
  // #1912: malformed acceptance invalidates the verdict, never the lock —
  // the run is then reviewed after resume like a legacy checkpoint.
  const acceptanceParsed = parseAcceptance(raw.acceptance);
  const acceptance = acceptanceParsed === null ? undefined : acceptanceParsed;

  return {
    status: status as SleepStatus,
    pid: raw.pid,
    ...(runId !== undefined ? { runId } : {}),
    ...(priorRunId !== undefined ? { priorRunId } : {}),
    startedAt: raw.startedAt,
    llmCalls,
    ...(wiredResults !== undefined ? { wiredResults } : {}),
    steps,
    ...(acceptance !== undefined ? { acceptance } : {}),
  };
}

export function readStateFile(path: string): SleepState | null {
  try {
    if (!existsSync(path)) return null;
    return parseState(JSON.parse(readFileSync(path, "utf-8")));
  } catch { return null; }
}

export function isResumableSleepState(state: SleepState, isPidAlive: (pid: number) => boolean): boolean {
  // This predicate is also used at the resume boundary; do not allow a caller
  // that bypassed readStateFile to turn malformed data into a resumable
  // checkpoint.
  if (!parseState(state)) return false;
  // Contains a failed/timeout step — recovery fact, even if coarse status is completed
  const hasFailedStep = Object.values(state.steps).some(s => s.status === "failed" || s.status === "timeout");
  if (hasFailedStep) return true;
  if (state.status === "suspended") return true;
  if (state.status === "ongoing") {
    try {
      const alive = isPidAlive(state.pid);
      if (!alive) return true; // stale/dead-owner ongoing checkpoint
    } catch { return true; }
  }
  return false;
}

export function writeStateFile(path: string, state: SleepState): void {
  atomicWriteSync(path, JSON.stringify(state, null, 2));
}

// ── Wired pre-tasks (delegated to abmind MaintenanceService) ────────────────
// #1353: bridge-log rotation moved out — abmind may clean only its own
// artifacts below its configured home. Host log retention is host-owned.

export async function runWiredPreTasks(sleepData: SleepDataAccess, _memoryDir: string, memory: MemoryManager, primaryUserId: string, receipts?: { runId: string }): Promise<WiredResults> {
  const r = await memory.maintenance.runPreSleepTasks(memory, sleepData, primaryUserId, receipts);
  return { purged: r.purged, deduped: r.deduped, embedded: r.embedded, anomaliesFixed: r.anomaliesFixed, walOk: r.walOk, ftsOk: r.ftsOk };
}

export function formatWiredResults(r: WiredResults): string {
  const parts: string[] = [];
  if (r.purged > 0) parts.push(`${r.purged} garbage purged`);
  if (r.deduped > 0) parts.push(`${r.deduped} dupes deleted`);
  parts.push(`WAL ${r.walOk ? "ok" : "FAILED"}`);
  parts.push(`FTS ${r.ftsOk ? "ok" : "FAILED"}`);
  if (r.embedded > 0) parts.push(`${r.embedded} embedded`);
  if (r.anomaliesFixed > 0) parts.push(`${r.anomaliesFixed} anomalies fixed`);
  return parts.length > 0 ? parts.join(", ") : "nothing to do";
}
