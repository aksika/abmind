import { describe, expect, it } from "vitest";
import {
  SERVICE_DRAIN_TIMEOUT_MS,
  DAEMON_SHUTDOWN_BUDGET_MS,
  LEASE_RELEASE_RESERVE_MS,
  LAUNCHD_EXIT_TIMEOUT_SECONDS,
  createShutdownDeadline,
  remainingMs,
  serviceDrainEnd,
} from "./daemon-shutdown-contract.js";

describe("daemon shutdown contract constants (#1701)", () => {
  it("carries the exact production values", () => {
    expect(SERVICE_DRAIN_TIMEOUT_MS).toBe(30_000);
    expect(DAEMON_SHUTDOWN_BUDGET_MS).toBe(35_000);
    expect(LEASE_RELEASE_RESERVE_MS).toBe(1_000);
    // launchd retains at least five seconds beyond the daemon's own budget.
    expect(LAUNCHD_EXIT_TIMEOUT_SECONDS * 1000 - DAEMON_SHUTDOWN_BUDGET_MS).toBeGreaterThanOrEqual(5_000);
  });
});

describe("createShutdownDeadline", () => {
  it("derives deadlineAt and the one-second release reserve from now", () => {
    const d = createShutdownDeadline(1_000_000);
    expect(d.startedAt).toBe(1_000_000);
    expect(d.deadlineAt).toBe(1_000_000 + DAEMON_SHUTDOWN_BUDGET_MS);
    expect(d.releaseBy).toBe(d.deadlineAt - LEASE_RELEASE_RESERVE_MS);
  });

  it("keeps the reserve strictly inside the overall budget", () => {
    const d = createShutdownDeadline(0);
    expect(d.releaseBy).toBeLessThan(d.deadlineAt);
    expect(d.deadlineAt - d.releaseBy).toBe(LEASE_RELEASE_RESERVE_MS);
  });
});

describe("remainingMs", () => {
  it("gives a later phase less time than an earlier observation — phases share one decreasing clock", () => {
    const d = createShutdownDeadline(0);
    const early = remainingMs(d, 5_000);
    const later = remainingMs(d, 20_000);
    expect(later).toBeLessThan(early);
  });

  it("clamps a phase end at the overall deadline (no fresh full windows)", () => {
    const d = createShutdownDeadline(0);
    expect(remainingMs(d, 10_000, d.startedAt + SERVICE_DRAIN_TIMEOUT_MS + 30_000))
      .toBe(d.deadlineAt - 10_000);
  });

  it("honours a phase end earlier than the deadline", () => {
    const d = createShutdownDeadline(0);
    expect(remainingMs(d, 1_000, d.releaseBy)).toBe(d.releaseBy - 1_000);
  });

  it("never returns negative time once the deadline has passed", () => {
    const d = createShutdownDeadline(0);
    expect(remainingMs(d, d.deadlineAt + 60_000)).toBe(0);
    expect(remainingMs(d, d.deadlineAt + 60_000, d.releaseBy)).toBe(0);
  });

  it("reserves the final second for lease release after full drain", () => {
    const d = createShutdownDeadline(0);
    const drainEnd = serviceDrainEnd(d);
    expect(drainEnd).toBe(SERVICE_DRAIN_TIMEOUT_MS);
    // After consuming the whole drain window, transport finalization still
    // receives time up to releaseBy, and release keeps its reserved tail.
    const flushBudget = remainingMs(d, drainEnd, d.releaseBy);
    expect(flushBudget).toBe(DAEMON_SHUTDOWN_BUDGET_MS - LEASE_RELEASE_RESERVE_MS - SERVICE_DRAIN_TIMEOUT_MS);
    expect(flushBudget).toBeGreaterThan(0);
  });
});

describe("serviceDrainEnd", () => {
  it("ends at the earlier of the 30-second limit and the reserve boundary", () => {
    const d = createShutdownDeadline(0);
    expect(serviceDrainEnd(d)).toBe(Math.min(d.startedAt + SERVICE_DRAIN_TIMEOUT_MS, d.releaseBy));
  });

  it("never lets drain consume into the reserved release tail", () => {
    const d = createShutdownDeadline(0);
    expect(serviceDrainEnd(d)).toBeLessThanOrEqual(d.releaseBy);
  });
});
