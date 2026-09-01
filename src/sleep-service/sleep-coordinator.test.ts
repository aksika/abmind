import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SleepCoordinator } from "./sleep-coordinator.js";

describe("SleepCoordinator report passthrough (#1603)", () => {
  it("carries the run report on getStatus().last after a finished run", async () => {
    const coordinator = new SleepCoordinator();
    const report = `Sleep partial — 6 completed, 1 failed, 1 skipped (of 8). Essential failures: none.`;
    let resolveStart: (result: { status: string; report?: string }) => void = () => {};
    coordinator.registerServices({
      startSleep: () => new Promise((resolve) => { resolveStart = resolve; }),
    });

    const started = coordinator.start("manual");
    expect(started.status).toBe("accepted");
    expect(coordinator.getStatus().state).toBe("running");

    resolveStart({ status: "partial", report });
    // Let the .then() microtask run.
    await new Promise((r) => setTimeout(r, 0));

    const status = coordinator.getStatus();
    expect(status.state).toBe("terminal");
    expect(status.last?.status).toBe("partial");
    expect(status.last?.report).toBe(report);
  });

  it("caps the report at 4000 chars", async () => {
    const coordinator = new SleepCoordinator();
    const longReport = "x".repeat(10_000);
    let resolveStart: (result: { status: string; report?: string }) => void = () => {};
    coordinator.registerServices({
      startSleep: () => new Promise((resolve) => { resolveStart = resolve; }),
    });

    coordinator.start("manual");
    resolveStart({ status: "completed", report: longReport });
    await new Promise((r) => setTimeout(r, 0));

    expect(coordinator.getStatus().last?.report?.length).toBe(4000);
  });

  it("produces a bounded service_failed report when the run failed before producing one", async () => {
    const coordinator = new SleepCoordinator();
    let rejectStart: (err: Error) => void = () => {};
    coordinator.registerServices({
      startSleep: () => new Promise((_resolve, reject) => { rejectStart = reject; }),
    });

    coordinator.start("manual");
    rejectStart(new Error("transport down"));
    await new Promise((r) => setTimeout(r, 0));

    const status = coordinator.getStatus();
    expect(status.last?.status).toBe("failed");
    expect(status.last?.report).toContain("Stage: service");
    expect(status.last?.report).toContain("service_failed");
  });
});

describe("SleepCoordinator disk persistence (#1617)", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function tempPersistPath(): string {
    dir = mkdtempSync(join(tmpdir(), "sleep-coord-"));
    return join(dir, "sleep-last-run.json");
  }

  it("survives a coordinator restart — the /sleep last-cycle regression", async () => {
    const path = tempPersistPath();
    const first = new SleepCoordinator(path);
    let resolveStart: (result: { status: string; report?: string }) => void = () => {};
    first.registerServices({
      startSleep: () => new Promise((resolve) => { resolveStart = resolve; }),
    });

    first.start("scheduled");
    first.pushEvent("step_completed", "step-a");
    first.pushEvent("step_completed", "step-b");
    first.pushEvent("step_failed", "step-c");
    resolveStart({ status: "completed", report: "Sleep completed — 8 completed, 0 failed." });
    await new Promise((r) => setTimeout(r, 0));

    const second = new SleepCoordinator(path);
    const status = second.getStatus();
    expect(status.state).toBe("terminal");
    expect(status.last?.status).toBe("completed");
    expect(status.last?.report).toBe("Sleep completed — 8 completed, 0 failed.");
    expect(status.last?.attemptedAt).toBe(first.getStatus().last?.attemptedAt);
    expect(status.last?.completedSteps).toBe(2);
    expect(status.last?.failedSteps).toBe(1);
  });

  it("boots clean when the persisted file is corrupt", () => {
    const path = tempPersistPath();
    writeFileSync(path, "{not json", "utf-8");

    const coordinator = new SleepCoordinator(path);
    expect(coordinator.getStatus()).toEqual({ state: "idle" });
  });

  it("bounds and sanitizes fields loaded from the persisted sidecar", () => {
    const path = tempPersistPath();
    writeFileSync(path, JSON.stringify({
      attemptedAt: Date.now(),
      status: "completed",
      report: "x".repeat(10_000),
      completedSteps: -1,
      failedSteps: 1.5,
    }), "utf-8");

    const coordinator = new SleepCoordinator(path);
    expect(coordinator.getStatus().last?.report).toHaveLength(4000);
    expect(coordinator.getStatus().last?.completedSteps).toBe(0);
    expect(coordinator.getStatus().last?.failedSteps).toBe(0);
  });

  it("persists an interrupted run on shutdown as resumable across restarts", () => {
    const path = tempPersistPath();
    const first = new SleepCoordinator(path);
    first.registerServices({
      startSleep: () => new Promise(() => {}),
    });

    first.start("scheduled");
    first.pushEvent("step_completed", "step-a");
    first.pushEvent("step_failed", "step-b");
    first.shutdown();
    expect(first.getStatus().state).toBe("interrupted");

    const second = new SleepCoordinator(path);
    expect(second.getStatus().state).toBe("interrupted");
    expect(second.getStatus().last?.resumable).toBe(true);
    expect(second.getStatus().last?.completedSteps).toBe(1);
    expect(second.getStatus().last?.failedSteps).toBe(1);
  });
});

describe("SleepCoordinator shutdown terminalization (#1701)", () => {
  it("wakes an idle sleep.events long poll immediately with terminal=true", async () => {
    const coordinator = new SleepCoordinator();

    // No active run — a pure idle event waiter must not consume the drain
    // window after shutdown() terminalizes the ring.
    const poll = coordinator.eventRing.readAfter(999_999, 10, 60_000);

    setTimeout(() => coordinator.shutdown(), 50);
    const startedAt = Date.now();
    const result = await poll;

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.terminal).toBe(true);
    expect(result.events).toEqual([]);
  });

  it("shutdown is idempotent — repeated calls stay terminal and never throw", async () => {
    const coordinator = new SleepCoordinator();
    coordinator.registerServices({
      startSleep: () => new Promise(() => {}),
    });
    coordinator.start("manual");
    coordinator.shutdown();
    expect(coordinator.getStatus().state).toBe("interrupted");

    coordinator.shutdown();
    expect(coordinator.eventRing.isTerminal).toBe(true);

    // A late long poll resolves immediately as terminal instead of waiting.
    const result = await coordinator.eventRing.readAfter(0, 10, 60_000);
    expect(result.terminal).toBe(true);
  });

  it("wakes an idle runtime broker next-waiter on shutdown", async () => {
    const coordinator = new SleepCoordinator();
    const open = coordinator.runtimeBroker.open("provider-1");
    expect(open.status).toBe("ok");
    if (!open.leaseId) throw new Error("expected leaseId");

    const wait = coordinator.runtimeBroker.next(open.leaseId, 60_000);
    setTimeout(() => coordinator.shutdown(), 50);

    const startedAt = Date.now();
    const result = await wait;
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(["closed", "lease_expired"]).toContain(result.status);
  });
});
