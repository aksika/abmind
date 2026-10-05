/**
 * sleep/llm-budget.ts — LLM call budget tracking and supervised completion.
 *
 * #1353: transport retry/backoff is a host responsibility, not abmind's.
 * `SleepRuntime.complete()` is one host-supervised model operation — if it
 * rejects, the host has already exhausted its own provider policy.
 *
 * #1912: deterministic supervision sits above that host policy. A rejection
 * carrying transient execution evidence receives bounded corrective attempts
 * (20s, 1m, 5m) inside one unified work-item allowance; permanent blockers,
 * cancellation, unavailable providers, and exhausted allowances terminate
 * that work truthfully. Empty/invalid *successful* responses are domain
 * corrections — another model call is semantically meaningful — and proceed
 * without a provider cooldown inside the same allowance. There are no nested
 * retry ladders: transport-transient retries and domain corrections share
 * MAX_DOMAIN_RETRIES total model-reaching attempts per work item.
 *
 * #1676: every attempt runs under one window derived once at
 * `sendToRuntime()` entry (`capAt - clockNow()`), refreshed onto each
 * attempt start, and capped by the remaining cycle deadline and cleanup
 * headroom. The cycle timer never restarts. Exhaustion of an attempt
 * deadline, a provider rejection/timeout, or exhaustion of valid-output
 * retries raises the typed terminal SleepModelFailureError — the
 * orchestrator stops the sleep, never the next step.
 */

import { getAbmindEnv } from "../env-schema.js";
import { logWarn, logError, logTrace } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";
import { LLMUnavailableError } from "../sleep-pipeline.js";
import type { SleepRuntime, SleepCompletionRequest, SleepCompletionResult, ContentOutcome, NormalizedExecutionFacts } from "./contracts.js";
import { writeStateFile } from "./state.js";
import type { SleepState } from "./state.js";
import { SleepCompletionDeadlineError, RuntimeCompletionAdmissionError } from "../sleep-service/runtime-broker.js";
import { SLEEP_PROVIDER_CLEANUP_HEADROOM_MS } from "./step-deadlines.js";
import { classifyExecutionFailure, decideRecovery, isAdmissionRefusal, withExecutionFacts } from "./supervision.js";
import type { SupervisionDecision } from "./supervision.js";

const TAG = "abmind-sleep";

/** Unified work-item attempt allowance (#1912): transport-transient retries
 *  and empty/invalid domain corrections share these four total attempts
 *  including the initial attempt. Replaces the former independent
 *  empty-response ladder and its 30s/15m/15m delays. */
export const MAX_DOMAIN_RETRIES = 4;

/** Delay schedule (ms) between bounded TRANSIENT retries of a rejected
 *  completion. Index i is the wait before the (i+2)-th attempt; the final
 *  entry applies to any further retry. Default: 20s, 1m, 5m. A longer
 *  normalized retry-after hint wins when it fits the remaining budget.
 *  Domain corrections (empty/invalid successful responses) never wait.
 *  Not a transport retry — transport backoff belongs to the host (#1353). */
export const DEFAULT_RETRY_DELAYS: readonly [number, number, number] = [20_000, 60_000, 300_000];

/** Await a retry delay while observing the caller's signal. Resolves `true`
 *  when the delay completed, `false` if the signal aborted mid-wait. Installs
 *  exactly one timer and one one-shot abort listener and clears both on every
 *  path, so no timer/listener survives cancellation or the normal completion. */
function waitForRetryDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (delayMs <= 0) return Promise.resolve(!signal.aborted);
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
  });
}

/** Per-attempt evidence for empty/invalid domain responses — #1752 R10. Bounded and redacted. */
export interface EmptyAttemptEvidence {
  attempt: number;
  responseLength: number;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  hasReasoning?: boolean;
  hasToolCalls?: boolean;
  outcome?: ContentOutcome;
}

function normalizeCompletionResult(raw: string | SleepCompletionResult): { text: string; evidence: Partial<EmptyAttemptEvidence> } {
  if (typeof raw === "string") return { text: raw, evidence: {} };
  const text = typeof raw.text === "string" ? raw.text : "";
  const evidence: Partial<EmptyAttemptEvidence> = {};
  if (raw.outcome) evidence.outcome = raw.outcome as ContentOutcome;
  if (raw.finishReason) evidence.finishReason = String(raw.finishReason).slice(0, 80);
  if (typeof raw.promptTokens === "number") evidence.promptTokens = raw.promptTokens;
  if (typeof raw.completionTokens === "number") evidence.completionTokens = raw.completionTokens;
  if (typeof raw.hasReasoning === "boolean") evidence.hasReasoning = raw.hasReasoning;
  if (typeof raw.hasToolCalls === "boolean") evidence.hasToolCalls = raw.hasToolCalls;
  return { text, evidence };
}

/** Stable terminal model-failure reasons surfaced in the cycle report (#1611). */
export type SleepModelFailureReason =
  | "provider_failed"
  | "provider_timeout"
  | "step_deadline"
  | "invalid_response";

/**
 * Terminal model-step failure. Thrown by sendToRuntime; the orchestrator stops
 * the sleep on it, marks the current step timeout/failed, advances no
 * watermark, and returns a resumable failed result. Extends
 * LLMUnavailableError so buildDailySummary/extractFromDaily propagate it
 * naturally (they check instanceof LLMUnavailableError to bubble errors up).
 */
export class SleepModelFailureError extends LLMUnavailableError {
  readonly reason: SleepModelFailureReason;
  readonly stepId: string;
  readonly failure?: import("./contracts.js").SleepFailure;
  readonly evidence?: EmptyAttemptEvidence[];

  constructor(stepId: string, reason: SleepModelFailureReason, message: string, failure?: import("./contracts.js").SleepFailure, evidence?: EmptyAttemptEvidence[]) {
    super(message);
    this.name = "SleepModelFailureError";
    this.reason = reason;
    this.stepId = stepId;
    if (failure) this.failure = failure;
    if (evidence) this.evidence = evidence;
  }
}

/** Narrowing helper for catch sites. */
export function isSleepModelFailure(err: unknown): err is SleepModelFailureError {
  return err instanceof SleepModelFailureError;
}

/** Thrown when the host's `runtime.complete()` rejects — a transport failure,
 *  not a domain one. Mapped to the stable `provider_failed` reason. */
export class TransportUnavailableError extends SleepModelFailureError {
  /** #1681: the broker's stable admission code (provider_unavailable |
   *  completion_pending) when the rejection was an admission refusal. The code
   *  survives wrapping and appears in the failure message. */
  readonly providerCode?: string;
  constructor(stepId: string, cause?: unknown, supervision?: TransportSupervisionContext) {
    const causeMsg = cause instanceof Error ? cause.message : String(cause);
    // #1681: preserve the broker's machine-readable admission code through the
    // transport wrapper — the report needs the exact refusal reason.
    const providerCode = cause instanceof RuntimeCompletionAdmissionError ? cause.code : undefined;
    const msg = causeMsg;
    // #1611: a host-supplied stable timeout code survives the mapping so the
    // report can distinguish provider_timeout from a generic provider_failed.
    const reason: SleepModelFailureReason = msg.includes("provider_timeout") ? "provider_timeout" : "provider_failed";
    // Preserve structured failure if the cause carries one (broker typed error)
    const rawFailure = (cause as { failure?: import("./contracts.js").SleepFailure } | null)?.failure
      ?? (cause instanceof SleepModelFailureError ? cause.failure : undefined);
    // #1912: attach normalized execution facts so no blanket
    // provider_failed erases available actionable evidence.
    const failure = supervision?.facts !== undefined && rawFailure !== undefined
      ? withExecutionFacts(rawFailure, supervision.facts)
      : rawFailure;
    const baseMsg = `Runtime rejected for step "${stepId}": ${msg}`;
    super(stepId, reason,
      supervision?.attemptsUsed !== undefined
        ? `Step ${stepId} failed after ${supervision.attemptsUsed} attempt(s) (${supervision.disposition ?? "exhausted"}): ${baseMsg}`
        : baseMsg,
      failure, supervision?.evidence !== undefined && supervision.evidence.length > 0 ? [...supervision.evidence] : undefined);
    this.name = "TransportUnavailableError";
    if (providerCode) this.providerCode = providerCode;
    if (failure && !this.failure) (this as { failure?: import("./contracts.js").SleepFailure }).failure = failure;
  }
}

/** #1912: supervision context attached to a terminal transport failure —
 *  how many model-reaching attempts ran and why no further work follows. */
export interface TransportSupervisionContext {
  facts?: NormalizedExecutionFacts;
  attemptsUsed?: number;
  disposition?: "blocker" | "cancelled" | "exhausted";
  evidence?: EmptyAttemptEvidence[];
}

/** #1859: per-call enforcement options for sendToRuntime. */
export interface SendToRuntimeOpts {
  /** When true, the turn must run proposal-only (no state-changing tools).
   *  A runtime that does not declare the capability fails closed here —
   *  terminal, before any model call. */
  proposalOnly?: boolean;
  /** #1912: cap on total model-reaching attempts for this work item,
   *  including its initial attempt. Defaults to MAX_DOMAIN_RETRIES. A
   *  corrective re-send passes its remainder so nested ladders never form. */
  maxAttempts?: number;
  /** #1912: absolute cycle deadline (epoch ms). Each attempt window is
   *  capped by the remaining cycle deadline and cleanup headroom — the
   *  cycle timer never restarts. Absent means the step deadline alone. */
  cycleDeadlineAt?: number;
}

/** #1859: whether a runtime declares proposal-only enforcement. Absent or
 *  false means unenforced — proposal-only turns must not be dispatched. */
export function isProposalCapable(runtime: SleepRuntime): boolean {
  return runtime.proposalOnlyCapable === true;
}

/** Budget tracker — shared across all completion calls in a sleep cycle. */
export class LlmBudget {
  private state: SleepState;
  private readonly statePath: string;
  /** #1653: run-local per-step attribution for this execution attempt only. */
  private readonly callsByStep = new Map<string, number>();
  exhausted = false;

  constructor(state: SleepState, statePath: string) {
    this.state = state;
    this.statePath = statePath;
  }

  /** Increment counter, return false if budget exhausted. The logical `stepId`
   *  records which step reached the model — the durable run-level total in
   *  `state.llmCalls` keeps its existing meaning (#1653). */
  consume(stepId: string): boolean {
    this.callsByStep.set(stepId, (this.callsByStep.get(stepId) ?? 0) + 1);
    this.state.llmCalls = (this.state.llmCalls ?? 0) + 1;
    writeStateFile(this.statePath, this.state);
    if (this.state.llmCalls > getAbmindEnv().sleepMaxLlmCalls) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  /** #1653: model-reaching attempts charged to one logical step in THIS
   *  execution attempt. Empty across resume boundaries — the map starts fresh
   *  for each `LlmBudget` instance. */
  callsFor(stepId: string): number {
    return this.callsByStep.get(stepId) ?? 0;
  }

  /** #1912: whether ordinary (non-review) work may spend another call
   *  while keeping `reserveSlots` for the final review inside the same
   *  configured total. The review step itself is exempt. */
  canSpendOrdinary(reserveSlots: number): boolean {
    if (this.exhausted) return false;
    return (this.state.llmCalls ?? 0) + Math.max(0, reserveSlots) <= getAbmindEnv().sleepMaxLlmCalls;
  }

  get calls(): number { return this.state.llmCalls ?? 0; }
}

/**
 * Send one prompt through the host runtime under deterministic supervision.
 * One attempt window is derived once from the incoming `deadlineAt`,
 * capped by the remaining cycle deadline, and re-based onto each attempt
 * start. All model-reaching attempts in this call share one allowance of
 * `maxAttempts` (default MAX_DOMAIN_RETRIES), including the initial one.
 *
 * - A transport rejection with transient evidence is retried after a
 *   bounded supervision wait (20s/1m/5m, or a fitting retry-after hint).
 * - Permanent blockers, cancellation, unavailable providers, and exhausted
 *   allowances terminate the work item truthfully — never silent success.
 * - An empty/invalid *successful* response is a domain correction: it is
 *   re-sent immediately, without a provider cooldown.
 * - The broker's own deadline error maps to `step_deadline`.
 * - Exhaustion of the allowance maps to `invalid_response` (empty path) or
 *   the last transport reason (rejection path).
 * - Every model-reaching attempt is charged to the budget, including
 *   failures; broker admission refusal costs no model call. Unknown
 *   model-reach is charged conservatively — never free retries.
 *
 * Returns null ONLY when the budget is already exhausted (call not made), the
 * caller's signal aborted (cancellation, including mid-wait), or no useful
 * attempt fits the remaining cycle (suspend for resume) — the orchestrator's
 * own suspend/cancel paths.
 */
export async function sendToRuntime(
  runtime: SleepRuntime,
  prompt: string,
  stepId: string,
  runId: string,
  signal: AbortSignal,
  deadlineAt: number,
  budget?: LlmBudget,
  retryDelays: readonly number[] = DEFAULT_RETRY_DELAYS,
  clockNow: () => number = Date.now,
  opts?: SendToRuntimeOpts,
): Promise<string | null> {
  if (budget?.exhausted) {
    logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepId} — suspending`);
    return null;
  }

  // #1859: fail closed before any model call when a proposal-only turn has
  // no enforcing runtime. Terminal: the step never completes and no
  // watermark advances — an unenforced host cannot silently run fenced
  // steps with a normal tool set.
  if (opts?.proposalOnly && !isProposalCapable(runtime)) {
    throw new SleepModelFailureError(
      stepId,
      "provider_failed",
      `Step ${stepId} requires a proposal-only turn but the runtime does not enforce it — failing closed without a model call`,
      { cause: "policy_rejected", detail: `proposal-only unenforced for ${stepId}` },
    );
  }

  const maxAttempts = opts?.maxAttempts !== undefined && opts.maxAttempts >= 1
    ? Math.min(Math.floor(opts.maxAttempts), MAX_DOMAIN_RETRIES)
    : MAX_DOMAIN_RETRIES;
  // #1912: each attempt window is capped by the remaining cycle deadline
  // and cleanup headroom — the cycle timer never restarts. A step window
  // that is itself unviable is a terminal step_deadline (existing
  // semantics); a window killed only by cycle shortage suspends for resume
  // instead — time ran out, nothing failed.
  const entryNow = clockNow();
  const stepWindowMs = deadlineAt - entryNow;
  if (stepWindowMs <= SLEEP_PROVIDER_CLEANUP_HEADROOM_MS) {
    throw new SleepModelFailureError(
      stepId,
      "step_deadline",
      `Logical step ${stepId} attempt window (${Math.max(0, stepWindowMs)}ms) at or below the cleanup headroom — not starting another provider call`,
      { cause: "step_deadline", detail: `window ${Math.max(0, stepWindowMs)}ms at or below headroom` },
    );
  }
  const cycleWindowMs = opts?.cycleDeadlineAt !== undefined
    ? opts.cycleDeadlineAt - SLEEP_PROVIDER_CLEANUP_HEADROOM_MS - entryNow
    : Number.POSITIVE_INFINITY;
  if (cycleWindowMs <= SLEEP_PROVIDER_CLEANUP_HEADROOM_MS) {
    logWarn(TAG, `[SLEEP] ${stepId} suspending — no cycle budget remains for another attempt window`);
    return null;
  }
  // Absolute ceiling for re-based attempt windows: the cycle deadline only.
  // The step deadline sizes the window (#1676 re-bases each attempt onto
  // its own start); without an explicit cycle deadline there is no ceiling.
  const capAt = opts?.cycleDeadlineAt !== undefined
    ? opts.cycleDeadlineAt - SLEEP_PROVIDER_CLEANUP_HEADROOM_MS
    : Number.POSITIVE_INFINITY;

  let attemptsUsed = 0;
  const attemptEvidence: EmptyAttemptEvidence[] = [];
  while (true) {
    if (signal.aborted) return null;

    // Refresh the attempt deadline before the headroom gate and the request:
    // a retry never inherits a stale absolute timestamp from the step start.
    // The window re-bases onto each attempt start but never passes the
    // cycle cap. Cycle-only shortage suspends; a dead step window throws.
    const attemptStartedAt = clockNow();
    const cycleRemaining = capAt - attemptStartedAt;
    const remaining = Math.min(stepWindowMs, cycleRemaining);
    if (remaining <= SLEEP_PROVIDER_CLEANUP_HEADROOM_MS) {
      if (stepWindowMs > SLEEP_PROVIDER_CLEANUP_HEADROOM_MS) {
        logWarn(TAG, `[SLEEP] ${stepId} suspending — the cycle cap leaves no viable attempt window`);
        return null;
      }
      throw new SleepModelFailureError(
        stepId,
        "step_deadline",
        `Logical step ${stepId} attempt window (${Math.max(0, remaining)}ms) at or below the cleanup headroom — not starting another provider call`,
        { cause: "step_deadline", detail: `window ${Math.max(0, remaining)}ms at or below headroom` },
      );
    }
    deadlineAt = attemptStartedAt + remaining;

    const request: SleepCompletionRequest = { prompt, stepId, runId, signal, deadlineAt, ...(opts?.proposalOnly ? { proposalOnly: true } : {}) };
    let rawResult: string | SleepCompletionResult;
    try {
      rawResult = await runtime.complete(request);
    } catch (err) {
      if (err instanceof SleepCompletionDeadlineError) {
        // #1611: the broker's completion deadline expired — terminal for the
        // logical step, unlike #1603's continue-the-cycle policy.
        budget?.consume(stepId); // real model time was spent
        throw new SleepModelFailureError(stepId, "step_deadline", `Step ${stepId} exceeded its completion deadline`, { cause: "step_deadline", detail: `completion deadline exceeded for ${stepId}` });
      }
      // #1912: supervised transport failure. The host exhausted its own
      // provider policy; abmind decides in code whether bounded further
      // work is justified — never a blind replay, never silent success.
      if (isAdmissionRefusal(err)) {
        // Broker admission refusal never reached the model: no budget cost,
        // no allowance consumed — but the provider is unavailable, so the
        // work ends promptly rather than spinning on re-queue.
        throw new TransportUnavailableError(stepId, err, {
          facts: { failureClass: "unavailable", reachedModel: false },
          disposition: "blocker",
        });
      }
      attemptsUsed++;
      const failure = (err as { failure?: import("./contracts.js").SleepFailure })?.failure;
      const providerCode = err instanceof TransportUnavailableError ? err.providerCode : undefined;
      const facts = classifyExecutionFailure({
        failure,
        ...(providerCode !== undefined ? { admissionCode: providerCode } : {}),
        message: err instanceof Error ? err.message : String(err),
      });
      // Charge every model-reaching attempt including failures. Unknown
      // reach is charged conservatively; an explicit not-reached costs
      // nothing. Broker admission refusal costs no model call (handled above).
      if (facts.reachedModel !== false) budget?.consume(stepId);
      const decision: SupervisionDecision = decideRecovery({
        facts,
        attemptsUsed,
        maxAttempts,
        nowMs: clockNow(),
        capAtMs: capAt,
      });
      if (decision.action === "retry") {
        // The retryDelays seam overrides the supervised wait per attempt
        // (tests force immediacy with [0]); production passes the matching
        // supervision schedule so the decision stands, including a fitting
        // retry-after hint.
        const seam = retryDelays.length > 0
          ? retryDelays[Math.min(attemptsUsed - 1, retryDelays.length - 1)]
          : undefined;
        const waitMs = seam ?? decision.waitMs;
        logWarn(TAG, `Step ${stepId} attempt ${attemptsUsed}/${maxAttempts} failed (${facts.failureClass}) — waiting ${Math.round(waitMs / 1000)}s: ${decision.reason}`);
        const waited = await waitForRetryDelay(waitMs, signal);
        if (!waited) return null;
        continue;
      }
      if (decision.action === "suspend") {
        logWarn(TAG, `[SLEEP] ${stepId} suspending after ${attemptsUsed} attempt(s): ${decision.detail}`);
        return null;
      }
      // Terminal: map to the stable transport error, preserving normalized
      // facts so no blanket provider_failed erases available evidence.
      // The attempt ledger (state.steps[].attempts) records how far the
      // unified allowance went.
      throw new TransportUnavailableError(stepId, err, {
        facts,
        attemptsUsed,
        disposition: decision.disposition,
        ...(attemptEvidence.length > 0 ? { evidence: [...attemptEvidence] } : {}),
      });
    }

    // Real call reached the model — count it now (success OR empty, never a throw).
    attemptsUsed++;
    if (budget && !budget.consume(stepId)) {
      logWarn(TAG, `[BUDGET] LLM call limit (${getAbmindEnv().sleepMaxLlmCalls}) reached at step ${stepId} — suspending`);
      return null;
    }

    const { text: result, evidence: meta } = normalizeCompletionResult(rawResult);
    const isEmpty = !result || !result.trim();
    if (isEmpty) {
      // #1752 R10: bounded per-attempt evidence — no raw prompt, capped detail
      const ev: EmptyAttemptEvidence = {
        attempt: attemptsUsed,
        responseLength: result.length,
        ...meta,
      };
      attemptEvidence.push(ev);
      // At trace, also emit capped redacted text
      logTrace(TAG, `Step ${stepId} empty attempt ${attemptsUsed}: ${JSON.stringify({ attempt: ev.attempt, responseLength: ev.responseLength, outcome: ev.outcome, finishReason: ev.finishReason, hasReasoning: ev.hasReasoning, hasToolCalls: ev.hasToolCalls })} — excerpt: ${redactSecrets(result.slice(0, 200))}`);
      logWarn(TAG, `Step ${stepId} attempt ${attemptsUsed}/${maxAttempts} returned empty response${ev.outcome ? ` (${ev.outcome})` : ""}`);
      if (attemptsUsed >= maxAttempts) {
        logError(TAG, `Step ${stepId} failed after ${attemptsUsed} attempts (empty)`);
        // Build detail that includes outcome distinction for R13 when available
        const outcomeDetail = attemptEvidence.map(e => e.outcome ?? "empty").join(",");
        const detail = `empty/invalid responses ${attemptsUsed} times` + (outcomeDetail ? ` (${outcomeDetail})` : "");
        throw new SleepModelFailureError(
          stepId,
          "invalid_response",
          `Step ${stepId} returned empty/invalid responses ${attemptsUsed} times`,
          { cause: "invalid_response", detail },
          [...attemptEvidence],
        );
      }
      if (signal.aborted) return null;
      // #1912: domain corrections proceed without a provider cooldown —
      // another model call is semantically meaningful immediately.
      continue;
    }

    return result;
  }
}
