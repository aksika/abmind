import { randomUUID } from "node:crypto";

const LEASE_DURATION_MS = 120_000;
const DEFAULT_COMPLETION_DEADLINE_MS = 60_000;

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
    if (this.leaseId && Date.now() > this.leaseExpiresAt) this.expireLease(new Error("Runtime provider lease expired"));
    if (this.leaseId) return { status: "already_open" };
    this.leaseId = randomUUID().slice(0, 12);
    this.refreshLease();
    this.providerInstanceId = providerInstanceId;
    this.runTerminal = false;
    return { status: "ok", leaseId: this.leaseId, expiresAt: this.leaseExpiresAt };
  }

  close(leaseId: string): { status: "ok" | "not_found" } {
    if (this.leaseId !== leaseId) return { status: "not_found" };
    this.expireLease();
    return { status: "ok" };
  }

  setRunTerminal(): void {
    this.runTerminal = true;
    this.rejectPending(new Error("Sleep run is terminal"));
    this.wakeNext();
  }

  next(leaseId: string, waitMs: number): Promise<{ status: "ok" | "lease_expired" | "no_request" | "closed"; completionRequest?: { completionId: string; runId: string; stepId: string; prompt: string; deadline: number }; heartbeat?: true }> {
    if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) {
      return Promise.resolve({ status: "lease_expired" });
    }

    if (this.pendingCompletion && !this.pendingCompletion.resolved) {
      const req = this.pendingCompletion;
      this.pendingCompletion.resolved = true;
      this.refreshLease();
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
      }, Math.min(waitMs, LEASE_DURATION_MS));

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
      if (this.pendingCompletion?.completionId !== completionId) return;
      this.rejectPending(new Error("Runtime completion deadline expired"));
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
        this.rejectPending(signal.reason instanceof Error ? signal.reason : new Error("Sleep cancelled"));
        return;
      }
      signal.addEventListener("abort", () => {
        if (this.pendingCompletion?.completionId === completionId) {
          this.rejectPending(signal.reason instanceof Error ? signal.reason : new Error("Sleep cancelled"));
        }
      }, { once: true });
    });
  }

  complete(leaseId: string, completionId: string, _text: string): { status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" } {
    if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) return { status: "invalid_lease" };
    if (!this.pendingCompletion || this.pendingCompletion.completionId !== completionId) return { status: "invalid_completion" };
    if (Date.now() > this.pendingCompletion.deadline) return { status: "invalid_completion" };
    if (this.runTerminal) return { status: "run_terminal" };
    const pending = this.pendingCompletion;
    this.clearPendingTimer(pending);
    this.pendingCompletion = null;
    pending.resolve?.(_text);
    return { status: "ok" };
  }

  fail(leaseId: string, completionId: string, _code: string): { status: "ok" | "invalid_lease" | "invalid_completion" | "run_terminal" } {
    if (this.leaseId !== leaseId || Date.now() > this.leaseExpiresAt) return { status: "invalid_lease" };
    if (!this.pendingCompletion || this.pendingCompletion.completionId !== completionId) return { status: "invalid_completion" };
    if (Date.now() > this.pendingCompletion.deadline) return { status: "invalid_completion" };
    if (this.runTerminal) return { status: "run_terminal" };
    const pending = this.pendingCompletion;
    this.clearPendingTimer(pending);
    this.pendingCompletion = null;
    pending.reject?.(new Error(_code || "Runtime provider failed"));
    return { status: "ok" };
  }

  get hasProvider(): boolean { return this.leaseId !== null && Date.now() <= this.leaseExpiresAt; }

  private expireLease(error = new Error("Runtime provider lease expired")): void {
    this.rejectPending(error);
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = null;
    this.leaseId = null;
    this.leaseExpiresAt = 0;
    this.providerInstanceId = null;
    this.pendingCompletion = null;
    this.wakeNext();
  }

  private refreshLease(): void {
    this.leaseExpiresAt = Date.now() + LEASE_DURATION_MS;
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => this.expireLease(), LEASE_DURATION_MS);
  }

  private clearPendingTimer(pending: CompletionRequest | null): void {
    if (pending?.deadlineTimer) clearTimeout(pending.deadlineTimer);
  }

  private rejectPending(error: Error): void {
    const pending = this.pendingCompletion;
    if (!pending) return;
    this.clearPendingTimer(pending);
    this.pendingCompletion = null;
    pending.reject?.(error);
  }

  private wakeNext(): void {
    const waiters = this.nextWaiters.splice(0);
    for (const w of waiters) {
      if (this.pendingCompletion && !this.pendingCompletion.resolved) {
        const req = this.pendingCompletion;
        this.pendingCompletion.resolved = true;
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
