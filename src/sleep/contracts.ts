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

/** One model-completion request for a single sleep step.
 *  `signal` combines the caller's cancellation with the configured wall-clock
 *  timeout — hosts must pass it through to their own transport/abort logic.
 *  `deadlineAt` is the absolute end-to-end deadline of the logical step
 *  (#1611): it covers queueing, every model subcall, and same-model domain
 *  retries. The host must never restart the clock — a subcall or retry
 *  receives only the time remaining on this original deadline. */
export interface SleepCompletionRequest {
  prompt: string;
  stepId: string;
  runId: string;
  signal: AbortSignal;
  /** Absolute end-to-end deadline (epoch ms) for this logical step. */
  deadlineAt: number;
}

/** Host-injected model runtime. One method: send a prompt, get text back.
 *  Reject on transport failure — abmind does not operate a provider retry
 *  loop; a rejection maps directly to abmind's own essential-step/suspend
 *  policy. Hosts own their own provider retry/fallback before rejecting. */
export interface SleepRuntime {
  complete(request: SleepCompletionRequest): Promise<string>;
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
  /** Internal test seam — delay between bounded domain retries (empty/invalid
   *  response). Not part of the documented public contract; defaults to 6000ms. */
  domainRetryDelayMs?: number;
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

export interface SleepStepSummary {
  id: string;
  status: "completed" | "skipped" | "failed" | "timeout";
  essential: boolean;
  attempts: number;
  durationMs?: number;
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
