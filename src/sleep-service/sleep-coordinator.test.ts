import { describe, it, expect } from "vitest";
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
