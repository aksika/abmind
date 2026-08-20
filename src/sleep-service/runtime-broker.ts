import { randomUUID } from "node:crypto";

/**
 * #1517: provider-neutral sleep completion timing policy.
 * PROVIDER_IDLE_LEASE_MS governs an idle provider waiting for work; once a
 * request is delivered the lease extends through that request's absolute
 * completion deadline plus a bounded settlement grace. The grace only protects
 * normal settlement before the deadline; it never permits accepting a
 * completion after the deadline has passed.
 */
const PROVIDER_IDLE_LEASE_MS = 120_000;
const DEFAULT_COMPLETION_DEADLINE_MS = 180_000;
const COMPLETION_SETTLEMENT_GRACE_MS = 15_000;

type CompletionTerminalReason =
  | "completed"
  | "provider_failed"
  | "completion_deadline"
  | "lease_expired"
  | "run_terminal"
  | "cancelled";

/** #1681: a typed, discriminated next() result. A completion is only ever
 *  delivered on the `ok` branch with its exact request. */
export type RuntimeNextResult =
  | { status: "ok"; completionRequest: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number } }
  | { status: "lease_expired" }
  | { status: "no_request"; heartbeat: true }
  | { status: "closed" };

/** #1681: a long-poll waiter is an owned record — the caller lease id, the
 *  exact resolver, and the bound timer. Timers are cleared on every wake path
 *  and waiters are removed by record identity, so an expired or already
 *  settled waiter can never claim a completion. */
interface RuntimeNextWaiter {
  readonly leaseId: string;
  readonly resolve: (result: RuntimeNextResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** #1681: the stable, machine-readable admission reasons for queueCompletion.
 *  A refusal is either "no provider holds the lease" or "a completion is
 *  already pending" — the host surfaces both as terminal provider_failed but
 *  keeps the exact reason durable through transport wrapping. */
export type RuntimeCompletionAdmission =
  | { status: "queued"; completionId: string }
  | { status: "provider_unavailable" }
  | { status: "completion_pending" };

/** Thrown at the broker/host boundary when a completion cannot be admitted.
 *  The stable `code` (provider_unavailable | completion_pending) survives
 *  TransportUnavailableError wrapping and appears in the final sleep failure
 *  message; it never reaches the model, so it never consumes LLM budget. */
export class RuntimeCompletionAdmissionError extends Error {
  readonly code: "provider_unavailable" | "completion_pending";
  readonly stepId: string;
  constructor(code: "provider_unavailable" | "completion_pending", stepId: string) {
    super(`Runtime completion admission refused (${code}) for step "${stepId}"`);
    this.name = "RuntimeCompletionAdmissionError";
    this.code = code;
    this.stepId = stepId;
  }
}

/**
 * A single completion exceeded its own deadline. The lease and the run
 * survive: only that completion is rejected. #1603 — a slow generation must
 * fail its step, not the whole cycle.
 */
export class SleepCompletionDeadlineError extends Error {
  readonly code = "completion_deadline";
  constructor(completionId: string, stepId: string) {
    super(`Runtime completion ${completionId} (step ${stepId}) exceeded its deadline`);
    this.name = "SleepCompletionDeadlineError";
  }
}

interface CompletionRequest {
  completionId: string;
  runId: string;
  stepId: string;
  prompt: string;
  deadline: number;
  resolved: boolean;
  resolve?: (text: string) => void;
  reject?: (error: Error) => void;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  abortSignal?: AbortSignal;
  abortListener?: () => void;
}

interface SettlePendingInput {
  completionId: string;
  reason: CompletionTerminalReason;
  text?: string;
  error?: Error;
  revokeLease: boolean;
}

export class RuntimeBroker {
  private leaseId: string | null = null;
  private leaseExpiresAt = 0;
  private leaseTimer: ReturnType<typeof setTimeout> | null = null;
  private providerInstanceId: string | null = null;
  private pendingCompletion: CompletionRequest | null = null;
  private nextWaiters: RuntimeNextWaiter[] = [];
  private runTerminal = false;

  open(providerInstanceId: string): { status: "ok" | "already_open" | "unavailable"; leaseId?: string; expiresAt?: number } {
    if (this.leaseId && Date.now() > this.leaseExpiresAt) this.expireLease(this.leaseId, new Error("Runtime provider lease expired"));
    if (this.leaseId) return { status: "already_open" };
    this.leaseId = randomUUID().slice(0, 12);
    this.refreshLease();
    this.providerInstanceId = providerInstanceId;
    this.runTerminal = false;
    return { status: "ok", leaseId: this.leaseId, expiresAt: this.leaseExpiresAt };
  }

  close(leaseId: string): { status: "ok" | "not_found" } {
    if (this.leaseId !== leaseId) return { status: "not_found" };
    this.expireLease(leaseId);
    return { status: "ok" };
  }

  setRunTerminal(): void {
    this.runTerminal = true;
    if (this.pendingCompletion) {
      this.settlePending({
        completionId: this.pendingCompletion.completionId,
        reason: "run_terminal",
        error: new Error("Sleep run is terminal"),
        revokeLease: true,
      });
    } else if (this.leaseId) {
      this.expireLease(this.leaseId);
    }
    this.wakeNext();
  }

  next(leaseId: string, waitMs: number): Promise<RuntimeNextResult> {
    if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) {
      return Promise.resolve({ status: "lease_expired" });
    }

    if (this.pendingCompletion && !this.pendingCompletion.resolved) {
      const req = this.pendingCompletion;
      this.pendingCompletion.resolved = true;
      this.refreshLeaseForCompletion(req);
      return Promise.resolve({
        status: "ok",
        completionRequest: {
          completionId: req.completionId, runId: req.runId,
          stepId: req.stepId, prompt: req.prompt, deadline: req.deadline,
        },
      });
    }

    if (this.runTerminal) {
      return Promise.resolve({ status: "closed" });
    }

    if (waitMs <= 0) {
      return Promise.resolve(this.heartbeatFor(leaseId));
    }

    return new Promise<RuntimeNextResult>(resolve => {
      const waiter: RuntimeNextWaiter = {
        leaseId,
        resolve,
        timer: setTimeout(() => {
          // #1681: remove the EXACT waiter record before resolving it — a
          // timed-out waiter must never linger and consume a later completion.
          this.removeWaiter(waiter);
          resolve(this.heartbeatFor(leaseId));
        }, Math.min(waitMs, Math.max(1, this.leaseExpiresAt - Date.now()))),
      };
      this.nextWaiters.push(waiter);
    });
  }

  /** #1681: the single healthy no-work heartbeat source. Refreshes the idle
   *  lease immediately before returning, so an actively polling provider stays
   *  live across more than PROVIDER_IDLE_LEASE_MS without model work. Expiry
   *  and terminal responses never refresh. */
  private heartbeatFor(leaseId: string): RuntimeNextResult {
    if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) {
      return { status: "lease_expired" };
    }
    if (this.runTerminal) return { status: "closed" };
    this.refreshLease();
    return { status: "no_request", heartbeat: true };
  }

  private removeWaiter(waiter: RuntimeNextWaiter): void {
    const idx = this.nextWaiters.indexOf(waiter);
    if (idx !== -1) this.nextWaiters.splice(idx, 1);
  }

  queueCompletion(runId: string, stepId: string, prompt: string, deadlineMs?: number): RuntimeCompletionAdmission {
    // #1681: provider availability is checked first so the refusal reason is
    // deterministic — a live provider with a pending completion reports
    // completion_pending, a missing/expired provider reports
    // provider_unavailable.
    if (!this.hasProvider) return { status: "provider_unavailable" };
    if (this.pendingCompletion) return { status: "completion_pending" };
    const completionId = randomUUID().slice(0, 12);
    const deadline = Date.now() + (deadlineMs ?? DEFAULT_COMPLETION_DEADLINE_MS);
    this.pendingCompletion = {
      completionId, runId, stepId, prompt,
      deadline,
      resolved: false,
    };
    this.pendingCompletion.deadlineTimer = setTimeout(() => {
      this.settlePending({
        completionId,
        reason: "completion_deadline",
        error: new SleepCompletionDeadlineError(completionId, stepId),
        revokeLease: false,
      });
    }, Math.max(1, deadline - Date.now()));
    this.wakeNext();
    return { status: "queued", completionId };
  }

  waitForCompletion(completionId: string, signal: AbortSignal): Promise<string> {
    const pending = this.pendingCompletion;
    if (!pending || pending.completionId !== completionId) {
      return Promise.reject(new Error("Runtime completion is no longer pending"));
    }
    return new Promise<string>((resolve, reject) => {
      pending.resolve = resolve;
      pending.reject = reject;
      if (signal.aborted) {
        this.settlePending({
          completionId,
          reason: "cancelled",
          error: signal.reason instanceof Error ? signal.reason : new Error("Sleep cancelled"),
          revokeLease: false,
        });
        return;
      }
      const listener = (): void => {
        if (this.pendingCompletion?.completionId === completionId) {
          this.settlePending({
            completionId,
            reason: "cancelled",
            error: signal.reason instanceof Error ? signal.reason : new Error("Sleep cancelled"),
            revokeLease: false,
          });
        }
      };
      pending.abortSignal = signal;
      pending.abortListener = listener;
      signal.addEventListener("abort", listener, { once: true });
    });
  }

  complete(leaseId: string, completionId: string, _text: string): { status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" } {
    if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) return { status: "invalid_lease" };
    if (this.runTerminal) return { status: "run_terminal" };
    const pending = this.pendingCompletion;
    if (!pending || pending.completionId !== completionId) return { status: "invalid_completion" };
    if (Date.now() > pending.deadline) {
      // The explicit timestamp check wins over a late callback: reject the
      // waiter, but keep the lease serviceable — the deadline cost only this
      // completion, not the provider (defect 3 in #1603).
      this.settlePending({
        completionId,
        reason: "completion_deadline",
        error: new SleepCompletionDeadlineError(completionId, pending.stepId),
        revokeLease: false,
      });
      return { status: "invalid_completion" };
    }
    this.settlePending({ completionId, reason: "completed", text: _text, revokeLease: false });
    return { status: "ok" };
  }

  fail(leaseId: string, completionId: string, _code: string): { status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" } {
    if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) return { status: "invalid_lease" };
    if (this.runTerminal) return { status: "run_terminal" };
    const pending = this.pendingCompletion;
    if (!pending || pending.completionId !== completionId) return { status: "invalid_completion" };
    if (Date.now() > pending.deadline) {
      this.settlePending({
        completionId,
        reason: "completion_deadline",
        error: new SleepCompletionDeadlineError(completionId, pending.stepId),
        revokeLease: false,
      });
      return { status: "invalid_completion" };
    }
    this.settlePending({
      completionId,
      reason: "provider_failed",
      error: new Error(_code || "Runtime provider failed"),
      revokeLease: false,
    });
    return { status: "ok" };
  }

  get hasProvider(): boolean { return this.leaseId !== null && Date.now() <= this.leaseExpiresAt; }

  private expireLease(leaseId: string, error = new Error("Runtime provider lease expired")): void {
    if (this.leaseId !== leaseId) return;
    // #1517: invalidate the lease BEFORE settling any pending completion, so a
    // waiter woken by that settlement observes lease_expired even at the exact
    // expiry boundary rather than a spurious heartbeat.
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.leaseId = null;
    this.leaseExpiresAt = 0;
    this.providerInstanceId = null;
    if (this.pendingCompletion) {
      this.settlePending({ completionId: this.pendingCompletion.completionId, reason: "lease_expired", error, revokeLease: false });
    }
    this.wakeNext();
  }

  private refreshLease(): void {
    this.leaseExpiresAt = Date.now() + PROVIDER_IDLE_LEASE_MS;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      if (this.leaseId) this.expireLease(this.leaseId);
    }, PROVIDER_IDLE_LEASE_MS);
  }

  /** Extend the serving lease through the delivered request deadline plus grace. */
  private refreshLeaseForCompletion(req: CompletionRequest): void {
    this.leaseExpiresAt = req.deadline + COMPLETION_SETTLEMENT_GRACE_MS;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      if (this.leaseId) this.expireLease(this.leaseId);
    }, Math.max(1, this.leaseExpiresAt - Date.now()));
  }

  /**
   * #1517: the single pending-completion settlement point. Verifies the
   * completion still owns the pending slot, detaches it, clears its timer and
   * abort listener, resolves/rejects the waiter exactly once, then revokes the
   * matching lease or wakes waiters as implied by the resulting state.
   */
  private settlePending(input: SettlePendingInput): boolean {
    const pending = this.pendingCompletion;
    if (!pending || pending.completionId !== input.completionId) return false;
    this.clearPendingTimer(pending);
    this.pendingCompletion = null;
    if (pending.abortSignal && pending.abortListener) {
      pending.abortSignal.removeEventListener("abort", pending.abortListener);
    }
    pending.abortSignal = undefined;
    pending.abortListener = undefined;
    if (input.reason === "completed") {
      pending.resolve?.(input.text ?? "");
    } else {
      pending.reject?.(input.error ?? new Error(`Runtime completion terminated: ${input.reason}`));
    }
    if (input.revokeLease && this.leaseId) {
      this.expireLease(this.leaseId);
    } else {
      // #1603: return a surviving lease to its idle window. Before, the lease
      // coasted on the delivered request's deadline + grace, so a fast
      // completion followed by slow non-model step work could expire the lease
      // mid-run and wedge the pump.
      if (this.leaseId) this.refreshLease();
      this.wakeNext();
    }
    return true;
  }

  private clearPendingTimer(pending: CompletionRequest | null): void {
    if (pending?.deadlineTimer) clearTimeout(pending.deadlineTimer);
  }

  private wakeNext(): void {
    const waiters = this.nextWaiters.splice(0);
    for (const w of waiters) {
      // #1681: every wake path clears the bound timer — an already-woken
      // waiter must never fire again.
      clearTimeout(w.timer);
      if (this.pendingCompletion && !this.pendingCompletion.resolved) {
        if (w.leaseId === this.leaseId) {
          const req = this.pendingCompletion;
          this.pendingCompletion.resolved = true;
          this.refreshLeaseForCompletion(req);
          w.resolve({ status: "ok", completionRequest: { completionId: req.completionId, runId: req.runId, stepId: req.stepId, prompt: req.prompt, deadline: req.deadline } });
        } else {
          // #1681: a stale-lease waiter can never claim the completion or
          // mutate pending-completion state — it observes lease_expired.
          w.resolve({ status: "lease_expired" });
        }
      } else if (!this.leaseId || Date.now() > this.leaseExpiresAt) {
        w.resolve({ status: "lease_expired" });
      } else if (this.runTerminal) {
        w.resolve({ status: "closed" });
      } else {
        w.resolve(this.heartbeatFor(w.leaseId));
      }
    }
  }
}
