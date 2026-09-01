import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SleepEventRing } from "./sleep-events.js";
import { RuntimeBroker } from "./runtime-broker.js";
import { logWarn } from "../mem-logger.js";
import { redactSecrets } from "../redact-secrets.js";

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
  formatVersion?: number;
}

export interface SleepServiceResult {
  status: string;
  report?: string;
  resumable: boolean;
}

export interface SleepStatus {
  state: "idle" | "running" | "terminal" | "interrupted";
  active?: ActiveRun;
  last?: LastRun;
}

const MAX_REPORT_LENGTH = 4000;
const LAST_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed", "no_work", "partial", "failed", "cancelled", "already_running", "interrupted",
]);

function boundedErrorDetail(err: unknown): string {
  let raw: string;
  try {
    raw = err instanceof Error ? err.message : String(err);
  } catch {
    raw = "no detail";
  }
  const detail = redactSecrets(raw).slice(0, 200);
  return detail || "no detail";
}

export class SleepCoordinator {
  private activeRun: ActiveRun | null = null;
  private lastRun: LastRun | null = null;
  private abortController: AbortController | null = null;
  private eventRing_ = new SleepEventRing();
  private broker_ = new RuntimeBroker();
  private persistPath_: string | null;
  private services_: { startSleep: (mode: string, level?: string, fresh?: boolean, runId?: string) => Promise<SleepServiceResult> } | null = null;
  private pendingCancel_ = false;
  private validateResumeCheckpoint_?: (runId?: string) => { valid: boolean; reason?: string };

  constructor(persistPath?: string) {
    this.persistPath_ = persistPath ?? null;
    if (this.persistPath_) this.loadPersisted_();
  }

  registerServices(services: { startSleep: (mode: string, level?: string, fresh?: boolean, runId?: string) => Promise<SleepServiceResult> }): void {
    // Resumability is a domain fact. The coordinator must preserve the
    // service's explicit bit and never infer it from a coarse status string.
    this.services_ = services;
  }

  registerResumeValidator(fn: (runId?: string) => { valid: boolean; reason?: string }): void {
    this.validateResumeCheckpoint_ = fn;
  }

  get isActive(): boolean { return this.activeRun !== null; }
  get runtimeBroker(): RuntimeBroker { return this.broker_; }
  get eventRing(): SleepEventRing { return this.eventRing_; }

  start(mode: string, level?: string, fresh?: boolean): { status: "accepted" | "already_running" | "unavailable"; runId?: string; reason?: string } {
    if (this.activeRun) {
      return { status: "already_running", runId: this.activeRun.runId };
    }
    if (!this.services_) {
      return { status: "unavailable", reason: "Sleep service not registered" };
    }

    const runId = randomUUID().slice(0, 12);
    this.abortController = new AbortController();
    this.pendingCancel_ = false;
    this.activeRun = { runId, mode, startedAt: Date.now(), percent: 0 };
    this.eventRing_ = new SleepEventRing();
    this.eventRing_.push("cycle_started", mode);

    const services = this.services_;
    // Normalize synchronous service throws into the same terminal path as
    // rejected promises; a test double or adapter must not strand activeRun.
    let servicePromise: Promise<SleepServiceResult>;
    try {
      servicePromise = services.startSleep(mode, level, fresh, runId);
    } catch (err) {
      servicePromise = Promise.reject(err);
    }
    servicePromise.then((result) => {
      this.finishRun(runId, result);
    }).catch((err) => {
      // A shutdown (or a newer run) may have replaced this run before the
      // service promise settled. Its result belongs to the old run and must
      // not mutate the current event ring or last-run record.
      if (!this.activeRun || this.activeRun.runId !== runId) return;
      const detail = boundedErrorDetail(err);
      this.eventRing_.push("step_failed", "service_failed");
      this.eventRing_.push("cycle_finished", "failed");
      // For service exceptions, check checkpoint validator for resumability
      let resumable = false;
      try {
        if (this.validateResumeCheckpoint_) {
          const v = this.validateResumeCheckpoint_(runId);
          resumable = v.valid;
        }
      } catch { /* ignore */ }
      this.finishRun(runId, { status: "failed", report: `Sleep failed\nStage: service\nCause: service_failed — ${detail}\nAction: Check daemon/service availability, then retry.${resumable ? "\nResume: /sleep resume" : ""}`, resumable });
    });

    return { status: "accepted", runId };
  }

  resume(runId?: string, level?: string): { status: "accepted" | "not_found" | "not_resumable" | "already_running" | "unavailable"; runId?: string; reason?: string } {
    if (this.activeRun) return { status: "already_running", runId: this.activeRun.runId };
    if (!this.services_) return { status: "unavailable", reason: "Sleep service not registered" };
    if (this.lastRun && (!runId || this.lastRun.runId === runId)) {
      if (this.lastRun.formatVersion !== undefined && this.lastRun.formatVersion !== 2) {
        return { status: "not_resumable", reason: "Unsupported sleep last-run format" };
      }
      // A completed/no-work run is healthy terminal state. Keep this safety
      // invariant even if an old or hand-edited sidecar claims resumable:true.
      if (this.lastRun.status === "completed" || this.lastRun.status === "no_work") {
        return { status: "not_resumable", reason: "Last run is not resumable" };
      }
      // Every new sidecar has a run identity. Without it, an explicit
      // resumable bit cannot be bound to a checkpoint and must fail closed.
      if (this.lastRun.resumable && !this.lastRun.runId) {
        return { status: "not_resumable", reason: "Resumable run has no run ID" };
      }
      // Legacy repair: failed/partial, absent formatVersion, resumable:false — consult checkpoint validator
      const isLegacyRepairable = this.lastRun.formatVersion === undefined
        && (this.lastRun.status === "failed" || this.lastRun.status === "partial")
        && this.lastRun.resumable === false;
      if (isLegacyRepairable) {
        if (!this.validateResumeCheckpoint_) return { status: "not_found", reason: "No resumable run found" };
        const v = this.validateResumeCheckpoint_(this.lastRun.runId);
        if (!v.valid) return { status: "not_found", reason: v.reason ?? "No resumable run found" };
        // Persist repaired resumability before starting
        this.lastRun = { ...this.lastRun, resumable: true, formatVersion: 2 };
        this.persistLastRun_();
        return this.start("resume", level);
      }
      if (this.lastRun.resumable) {
        return this.start("resume", level);
      }
      return { status: "not_resumable", reason: "Last run is not resumable" };
    }
    return { status: "not_found", reason: "No resumable run found" };
  }

  cancel(runId: string): { status: "cancelling" | "already_terminal" | "not_found" | "unavailable" } {
    if (!this.activeRun) return { status: "already_terminal" };
    if (this.activeRun.runId !== runId) return { status: "not_found" };
    this.abortController?.abort();
    this.pendingCancel_ = true;
    this.eventRing_.push("run_cancelled");
    // Do not immediately finish — service result owns final status; finishRun will handle cancellation
    // But push cancelled for UI; final status will be set when service settles or timeout
    // For now, keep activeRun so late result can terminalize correctly; shutdown is the hard fence
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

  private finishRun(runId: string, result: SleepServiceResult): void {
    if (!this.activeRun || this.activeRun.runId !== runId) return;
    // Shutdown is hard fence — ignore late results after shutdown terminalized
    // If no active run but lastRun is interrupted, we've already shutdown
    this.eventRing_.setTerminal();
    this.broker_.setRunTerminal();
    const { completedSteps, failedSteps } = this.stepCounts_();
    this.lastRun = {
      runId: this.activeRun.runId,
      attemptedAt: this.activeRun.startedAt,
      finishedAt: Date.now(),
      status: result.status,
      report: result.report ? redactSecrets(result.report).slice(0, MAX_REPORT_LENGTH) : undefined,
      resumable: result.resumable,
      completedSteps,
      failedSteps,
      formatVersion: 2,
    };
    this.activeRun = null;
    this.abortController = null;
    this.pendingCancel_ = false;
    this.persistLastRun_();
  }

  private stepCounts_(): { completedSteps: number; failedSteps: number } {
    const events = this.eventRing_.events;
    return {
      completedSteps: events.filter(e => e.event.type === "step_completed").length,
      failedSteps: events.filter(e => e.event.type === "step_failed").length,
    };
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
    const attemptedAt = r["attemptedAt"];
    const status = r["status"];
    if (typeof status !== "string" || !LAST_RUN_STATUSES.has(status)) return null;
    if (typeof attemptedAt !== "number" || !Number.isFinite(attemptedAt)) return null;
    const finishedAt = r["finishedAt"];
    const report = r["report"];
    const completedSteps = r["completedSteps"];
    const failedSteps = r["failedSteps"];
    const hasFormatVersion = Object.prototype.hasOwnProperty.call(r, "formatVersion");
    // Preserve the fact that an unsupported/malformed version was present.
    // It must not be mistaken for the absent version used by the one-time
    // legacy repair path.
    const formatVersion = !hasFormatVersion
      ? undefined
      : typeof r["formatVersion"] === "number" && Number.isSafeInteger(r["formatVersion"])
        ? r["formatVersion"]
        : -1;
    const runId = r["runId"];
    if (runId !== undefined && (typeof runId !== "string" || runId.length === 0 || runId.length > 128)) return null;
    return {
      runId: runId as string | undefined,
      attemptedAt,
      finishedAt: typeof finishedAt === "number" && Number.isFinite(finishedAt) ? finishedAt : undefined,
      status,
      report: typeof report === "string" ? redactSecrets(report).slice(0, MAX_REPORT_LENGTH) : undefined,
      resumable: r["resumable"] === true,
      completedSteps: typeof completedSteps === "number" && Number.isInteger(completedSteps) && completedSteps >= 0 ? completedSteps : 0,
      failedSteps: typeof failedSteps === "number" && Number.isInteger(failedSteps) && failedSteps >= 0 ? failedSteps : 0,
      formatVersion,
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
      const { completedSteps, failedSteps } = this.stepCounts_();
      this.lastRun = {
        runId: this.activeRun.runId,
        attemptedAt: this.activeRun.startedAt,
        finishedAt: Date.now(),
        status: "interrupted",
        resumable: true,
        completedSteps,
        failedSteps,
        formatVersion: 2,
      };
      this.activeRun = null;
      this.abortController = null;
      this.pendingCancel_ = false;
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
