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
  private nextWaiters: Array<(result: any) => void> = [];
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

  next(leaseId: string, waitMs: number): Promise<{ status: "ok" | "lease_expired" | "no_request" | "closed"; completionRequest?: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number }; heartbeat?: true }> {
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
      this.refreshLease();
      return Promise.resolve({ status: "no_request", heartbeat: true });
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => {
        const idx = this.nextWaiters.indexOf(resolve);
        if (idx !== -1) this.nextWaiters.splice(idx, 1);
        if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) {
          resolve({ status: "lease_expired" });
        } else {
          resolve({ status: "no_request", heartbeat: true });
        }
      }, Math.min(waitMs, Math.max(1, this.leaseExpiresAt - Date.now())));

      this.nextWaiters.push((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  queueCompletion(runId: string, stepId: string, prompt: string, deadlineMs?: number): string | null {
    if (!this.hasProvider || this.pendingCompletion) return null;
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
        error: new Error("Runtime completion deadline expired"),
        revokeLease: true,
      });
    }, Math.max(1, deadline - Date.now()));
    this.wakeNext();
    return completionId;
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
      // waiter, revoke the serving lease, and make later calls from this
      // lease stale. The armed deadline timer is cleared by settlePending.
      this.settlePending({
        completionId,
        reason: "completion_deadline",
        error: new Error("Runtime completion deadline expired"),
        revokeLease: true,
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
        error: new Error("Runtime completion deadline expired"),
        revokeLease: true,
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
      if (this.pendingCompletion && !this.pendingCompletion.resolved) {
        const req = this.pendingCompletion;
        this.pendingCompletion.resolved = true;
        this.refreshLeaseForCompletion(req);
        w({ status: "ok" as const, completionRequest: { completionId: req.completionId, runId: req.runId, stepId: req.stepId, prompt: req.prompt, deadline: req.deadline } });
      } else if (!this.leaseId || Date.now() > this.leaseExpiresAt) {
        w({ status: "lease_expired" as const });
      } else if (this.runTerminal) {
        w({ status: "closed" as const });
      } else {
        w({ status: "no_request" as const, heartbeat: true as const });
      }
    }
  }
}
