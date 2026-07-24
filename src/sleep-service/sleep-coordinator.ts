import { randomUUID } from "node:crypto";
import { SleepEventRing } from "./sleep-events.js";
import { RuntimeBroker } from "./runtime-broker.js";

export interface ActiveRun {
  runId: string;
  mode: string;
  startedAt: number;
  step?: string;
  percent: number;
}

export interface LastRun {
  runId?: string;
  attemptedAt: number;
  finishedAt?: number;
  status: string;
  resumable: boolean;
  completedSteps: number;
  failedSteps: number;
}

export interface SleepStatus {
  state: "idle" | "running" | "terminal" | "interrupted";
  active?: ActiveRun;
  last?: LastRun;
}

export class SleepCoordinator {
  private activeRun: ActiveRun | null = null;
  private lastRun: LastRun | null = null;
  private abortController: AbortController | null = null;
  private eventRing_ = new SleepEventRing();
  private broker_ = new RuntimeBroker();
  private services_: { startSleep: (mode: string, level?: string, fresh?: boolean, runId?: string) => Promise<{ status: string; report?: string }> } | null = null;

  registerServices(services: { startSleep: (mode: string, level?: string, fresh?: boolean, runId?: string) => Promise<{ status: string; report?: string }> }): void {
    this.services_ = services;
  }

  get isActive(): boolean { return this.activeRun !== null; }
  get runtimeBroker(): RuntimeBroker { return this.broker_; }
  get eventRing(): SleepEventRing { return this.eventRing_; }

  start(mode: string, level?: string, fresh?: boolean): { status: "accepted" | "already_running" | "unavailable"; runId?: string; reason?: string } {
    if (this.activeRun) {
      return { status: "already_running", runId: this.activeRun.runId };
    }

    const runId = randomUUID().slice(0, 12);
    this.abortController = new AbortController();
    this.activeRun = { runId, mode, startedAt: Date.now(), percent: 0 };
    this.eventRing_ = new SleepEventRing();
    this.eventRing_.push("cycle_started", mode);

    if (this.services_) {
      this.services_.startSleep(mode, level, fresh, runId).then((result) => {
        this.finishRun(result.status);
      }).catch((err) => {
        this.eventRing_.push("step_failed", (err as Error).message);
        this.eventRing_.push("cycle_finished", "failed");
        this.finishRun("failed");
      });
    }

    return { status: "accepted", runId };
  }

  resume(runId?: string, level?: string): { status: "accepted" | "not_found" | "not_resumable" | "already_running" | "unavailable"; runId?: string; reason?: string } {
    if (this.activeRun) return { status: "already_running", runId: this.activeRun.runId };
    if (this.lastRun && (!runId || this.lastRun.runId === runId) && this.lastRun.resumable) {
      return this.start("resume", level);
    }
    return { status: "not_found", reason: "No resumable run found" };
  }

  cancel(runId: string): { status: "cancelling" | "already_terminal" | "not_found" | "unavailable" } {
    if (!this.activeRun) return { status: "already_terminal" };
    if (this.activeRun.runId !== runId) return { status: "not_found" };
    this.abortController?.abort();
    this.eventRing_.push("run_cancelled");
    this.eventRing_.push("cycle_finished", "cancelled");
    this.finishRun("cancelled");
    return { status: "cancelling" };
  }

  getStatus(): SleepStatus {
    if (this.activeRun) {
      return { state: "running", active: this.activeRun, last: this.lastRun ?? undefined };
    }
    if (this.lastRun) {
      const s = this.lastRun.status === "interrupted" ? "interrupted" : "terminal";
      return { state: s as "terminal" | "interrupted", last: this.lastRun };
    }
    return { state: "idle" };
  }

  pushEvent(type: string, detail?: string): void {
    this.eventRing_.push(type, detail);
  }

  private finishRun(status: string): void {
    if (!this.activeRun) return;
    this.eventRing_.setTerminal();
    this.broker_.setRunTerminal();
    const events = this.eventRing_.events;
    const completedSteps = events.filter(e => e.event.type === "step_completed").length;
    const failedSteps = events.filter(e => e.event.type === "step_failed").length;
    this.lastRun = {
      runId: this.activeRun.runId,
      attemptedAt: this.activeRun.startedAt,
      finishedAt: Date.now(),
      status,
      resumable: status === "interrupted",
      completedSteps,
      failedSteps,
    };
    this.activeRun = null;
    this.abortController = null;
  }

  shutdown(): void {
    if (this.activeRun) {
      this.abortController?.abort();
      this.eventRing_.push("run_interrupted");
      this.eventRing_.setTerminal();
      this.lastRun = {
        runId: this.activeRun.runId,
        attemptedAt: this.activeRun.startedAt,
        finishedAt: Date.now(),
        status: "interrupted",
        resumable: true,
        completedSteps: 0,
        failedSteps: 0,
      };
      this.activeRun = null;
      this.abortController = null;
    }
    this.broker_.setRunTerminal();
    try { this.broker_.close(""); } catch { /* best effort */ }
  }

  get abortSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }
}
