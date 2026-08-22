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

  it("omits the report when the run failed before producing one", async () => {
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
    expect(status.last?.report).toBeUndefined();
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
    resolveStart({ status: "completed", report: "Sleep completed — 8 completed, 0 failed." });
    await new Promise((r) => setTimeout(r, 0));

    const second = new SleepCoordinator(path);
    const status = second.getStatus();
    expect(status.state).toBe("terminal");
    expect(status.last?.status).toBe("completed");
    expect(status.last?.report).toBe("Sleep completed — 8 completed, 0 failed.");
    expect(status.last?.attemptedAt).toBe(first.getStatus().last?.attemptedAt);
  });

  it("boots clean when the persisted file is corrupt", () => {
    const path = tempPersistPath();
    writeFileSync(path, "{not json", "utf-8");

    const coordinator = new SleepCoordinator(path);
    expect(coordinator.getStatus()).toEqual({ state: "idle" });
  });

  it("persists an interrupted run on shutdown as resumable across restarts", () => {
    const path = tempPersistPath();
    const first = new SleepCoordinator(path);
    first.registerServices({
      startSleep: () => new Promise(() => {}),
    });

    first.start("scheduled");
    first.shutdown();
    expect(first.getStatus().state).toBe("interrupted");

    const second = new SleepCoordinator(path);
    expect(second.getStatus().state).toBe("interrupted");
    expect(second.getStatus().last?.resumable).toBe(true);
  });
});
