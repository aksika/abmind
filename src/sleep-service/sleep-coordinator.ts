import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SleepEventRing } from "./sleep-events.js";
import { RuntimeBroker } from "./runtime-broker.js";
import { logWarn } from "../mem-logger.js";

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
  report?: string;
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
  private persistPath_: string | null;
  private services_: { startSleep: (mode: string, level?: string, fresh?: boolean, runId?: string) => Promise<{ status: string; report?: string }> } | null = null;

  constructor(persistPath?: string) {
    this.persistPath_ = persistPath ?? null;
    if (this.persistPath_) this.loadPersisted_();
  }

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
        this.finishRun(result.status, result.report);
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

  private finishRun(status: string, report?: string): void {
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
      report: report?.slice(0, 4000),
      resumable: status === "interrupted",
      completedSteps,
      failedSteps,
    };
    this.activeRun = null;
    this.abortController = null;
    this.persistLastRun_();
  }

  private loadPersisted_(): void {
    if (!this.persistPath_) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath_, "utf-8")) as unknown;
      this.lastRun = SleepCoordinator.sanitizeLastRun(raw);
    } catch {
      this.lastRun = null;
    }
  }

  private persistLastRun_(): void {
    if (!this.persistPath_ || !this.lastRun) return;
    try {
      mkdirSync(dirname(this.persistPath_), { recursive: true });
      const tmp = `${this.persistPath_}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.lastRun), "utf-8");
      renameSync(tmp, this.persistPath_);
    } catch (err) {
      logWarn("sleep-coordinator", `failed to persist last-run record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private static sanitizeLastRun(raw: unknown): LastRun | null {
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r["attemptedAt"] !== "number" || typeof r["status"] !== "string") return null;
    return {
      runId: typeof r["runId"] === "string" ? r["runId"] : undefined,
      attemptedAt: r["attemptedAt"],
      finishedAt: typeof r["finishedAt"] === "number" ? r["finishedAt"] : undefined,
      status: r["status"],
      report: typeof r["report"] === "string" ? r["report"] : undefined,
      resumable: r["resumable"] === true,
      completedSteps: typeof r["completedSteps"] === "number" ? r["completedSteps"] : 0,
      failedSteps: typeof r["failedSteps"] === "number" ? r["failedSteps"] : 0,
    };
  }

  /**
   * #1701: idempotently terminalize all bounded waiters so daemon cleanup can
   * unwind them before the manager closes — active runs are interrupted, idle
   * event-ring long polls resolve immediately as terminal, and runtime broker
   * waiters observe the closed run. Safe to call repeatedly.
   */
  shutdown(): void {
    if (this.activeRun) {
      this.abortController?.abort();
      this.eventRing_.push("run_interrupted");
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
      this.persistLastRun_();
    }
    // Terminalize even without an active run: an idle `sleep.events` long poll
    // must not consume the entire service drain window waiting for events that
    // will never arrive in a shutting-down daemon.
    this.eventRing_.setTerminal();
    this.broker_.setRunTerminal();
    try { this.broker_.close(""); } catch { /* best effort */ }
  }

  get abortSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }
}
