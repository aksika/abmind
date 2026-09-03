/**
 * sleep/contracts.ts — host-neutral public contract for the abmind sleep
 * engine (#1353).
 *
 * abmind owns memory-domain maintenance: step ordering, shared variables,
 * budget, checkpoints, resume/catch-up, watermark, and the final domain
 * result. An embedding host (abtars, OpenClaw, Hermes, the standalone CLI)
 * owns scheduling, authenticated/manual admission, model/provider transport,
 * agent/session lifecycle, and delivery. This file is the seam between them.
 *
 * These types are exported from the package root and listed in
 * SUPPORTED-SURFACE.md. Internal state-file shapes (SleepState, StepResult,
 * lock-file JSON) remain private — a host must never read them directly.
 */

import type { Level } from "./levels.js";
import type { MemoryConfig } from "../memory-config.js";
import type { MemoryManager } from "../memory-manager.js";

/** One model-completion request for a single provider attempt of a sleep step.
 *  `signal` combines the caller's cancellation with the configured wall-clock
 *  timeout — hosts must pass it through to their own transport/abort logic.
 *  `deadlineAt` is the absolute deadline of the CURRENT provider attempt: it
 *  covers queueing and this attempt's model subcalls. The host must enforce it
 *  and must not extend it with its own provider retry clock. Abmind may send a
 *  newly refreshed deadline for a later domain retry (see llm-budget.ts) — the
 *  timestamp is per-attempt, not a single immutable logical-step deadline. */
export interface SleepCompletionRequest {
  prompt: string;
  stepId: string;
  runId: string;
  signal: AbortSignal;
  /** Absolute deadline (epoch ms) for this provider attempt. */
  deadlineAt: number;
}

export type ContentOutcome = "text" | "reaction" | "no_reply" | "empty";

/** Host-injected model runtime. One method: send a prompt, get text back.
 *  Reject on transport failure — abmind does not operate a provider retry
 *  loop; a rejection maps directly to abmind's own essential-step/suspend
 *  policy. Hosts own their own provider retry/fallback before rejecting.
 *  #1752 R13: hosts SHOULD include the ContentOutcome classification when
 *  available; abmind treats a string result as legacy `text` with outcome
 *  unknown, and an object result carries the explicit outcome for evidence. */
export interface SleepCompletionResult {
  text: string;
  outcome?: ContentOutcome;
  /** Optional bounded evidence when available — not raw prompt. */
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  hasReasoning?: boolean;
  hasToolCalls?: boolean;
}

export interface SleepRuntime {
  complete(request: SleepCompletionRequest): Promise<string | SleepCompletionResult>;
}

/** "manual" runs (e.g. an explicit "/sleep now") still run housekeeping even
 *  with zero new messages since the last cycle — matching the historical
 *  --force behavior. "scheduled" and "resume" respect the no-work guard. */
export type SleepRunMode = "scheduled" | "manual" | "resume";

export interface SleepRunOptions {
  runtime: SleepRuntime;
  mode?: SleepRunMode;
  level?: Level;
  /** Caller-supplied cancellation — combined internally with the wall-clock timeout. */
  signal?: AbortSignal;
  /** Discard prior state and start with a clean budget. Used by manual "now" runs. */
  fresh?: boolean;
  /** Best-effort lifecycle observer. A throwing handler never alters the run. */
  onEvent?: (event: SleepEvent) => void;

  // Deterministic/internal test seams retained from the previous RunOpts.
  now?: () => number;
  timeoutMs?: number;
  memoryConfigOverride?: Partial<MemoryConfig>;
  /** Internal test seam — delay schedule (ms) between bounded domain retries
   *  of an empty/invalid successful response. Index i is the wait before the
   *  (i+2)-th attempt; the final entry applies to any further retry; an empty
   *  schedule or a non-positive entry means no wait. Not part of the documented
   *  public contract; defaults to DEFAULT_RETRY_DELAYS in llm-budget.ts. */
  retryDelays?: readonly number[];
  /** Internal test seam — inter-step backoff after a non-essential step
   *  failure, keyed by consecutive-failure count. Not part of the documented
   *  public contract; defaults to [10,30,60]s capped. */
  betweenStepBackoffMs?: (consecutiveFailures: number) => number;
  /** Reuse the daemon-owned manager; the caller remains responsible for closing it. */
  memoryManager?: MemoryManager;
  /** Coordinator-assigned identity for the externally visible run. */
  runId?: string;
}

export type SleepTerminalStatus =
  | "completed"
  | "no_work"
  | "partial"
  | "failed"
  | "cancelled"
  | "already_running";

export type SleepFailureCause =
  | "provider_failed"
  | "provider_timeout"
  | "step_deadline"
  | "invalid_response"
  | "prompt_round_limit"
  | "candidate_round_limit"
  | "candidate_exhausted"
  | "policy_rejected"
  | "nonzero_exit"
  | "spawn_error"
  | "timeout"
  | "aborted"
  | "shell_syntax_error"
  | "repeated_failure"
  | "memory_validation"
  | "memory_not_found"
  | "memory_conflict"
  | "memory_unauthorized"
  | "memory_idempotency_conflict"
  | "memory_unavailable"
  | "memory_outcome_unknown"
  | "completion_settlement_failed"
  | "service_failed"
  | "unknown";

export interface SleepFailure {
  cause: SleepFailureCause;
  detail?: string;
  commandFingerprint?: string;
}

export interface SleepStepSummary {
  id: string;
  status: "completed" | "skipped" | "failed" | "timeout";
  essential: boolean;
  attempts: number;
  durationMs?: number;
  failure?: SleepFailure;
}

export interface SleepRunResult {
  runId: string;
  status: SleepTerminalStatus;
  startedAt: number;
  finishedAt: number;
  llmCalls: number;
  steps: readonly SleepStepSummary[];
  essentialFailures: readonly string[];
  resumable: boolean;
  watermarkAdvanced: boolean;
  report: string;
}

/** Neutral lifecycle events. Bounded metadata only — never prompts or raw
 *  model responses. Exactly one `cycle_finished` is attempted for every run
 *  that emitted `cycle_started`. */
export type SleepEvent =
  | { type: "cycle_started"; runId: string; totalSteps: number; resumed: boolean }
  | { type: "step_started"; runId: string; stepId: string; index: number; total: number }
  | { type: "step_completed"; runId: string; step: SleepStepSummary }
  | { type: "step_skipped"; runId: string; step: SleepStepSummary }
  | { type: "step_failed"; runId: string; step: SleepStepSummary }
  | { type: "cycle_finished"; runId: string; result: SleepRunResult };

/** Best-effort event dispatch — an observer that throws must never alter the
 *  memory transaction, ordering, or final result (#1353 constraint 5). */
export function emitSleepEvent(handler: ((event: SleepEvent) => void) | undefined, event: SleepEvent): void {
  if (!handler) return;
  try { handler(event); } catch { /* host display only — never fail the cycle */ }
}
