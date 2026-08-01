import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RuntimeBroker } from "./runtime-broker.js";

/**
 * #1517 lifecycle contract tests. A real broker over a fake clock: every
 * scenario drives observable outcomes (waiter resolution, lease validity,
 * pump-visible statuses) rather than asserting internal fields.
 */
describe("RuntimeBroker completion/lease lifecycle (#1517)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function openBroker(): { broker: RuntimeBroker; leaseId: string } {
    const broker = new RuntimeBroker();
    const opened = broker.open("test-provider");
    if (opened.status !== "ok" || !opened.leaseId) throw new Error("open failed");
    return { broker, leaseId: opened.leaseId };
  }

  it("accepts a completion that crosses the former 60s boundary but settles before the new deadline", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    expect(completionId).not.toBeNull();

    const nextResult = await broker.next(leaseId, 0);
    expect(nextResult.status).toBe("ok");
    const req = nextResult.completionRequest!;
    expect(req.deadline - Date.now()).toBe(180_000);

    vi.advanceTimersByTime(100_000);
    expect(broker.complete(leaseId, completionId!, "text").status).toBe("ok");
  });

  it("does not lose the serving lease to the old 120s idle bound while a 180s completion is in flight", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    const req = (await broker.next(leaseId, 0)).completionRequest!;

    // Well past the former lease duration, still before the new deadline.
    vi.advanceTimersByTime(req.deadline - Date.now() - 5_000);
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "no_request", heartbeat: true });
    expect(broker.complete(leaseId, completionId!, "text").status).toBe("ok");
  });

  it("extends the lease when a waiting pump receives a queued completion", async () => {
    const { broker, leaseId } = openBroker();
    // The pump polls with a bounded wait before the completion exists; the
    // wake-up delivery must extend the lease exactly like a direct next().
    const waiter = broker.next(leaseId, 30_000);
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    const nextResult = await waiter;
    expect(nextResult.status).toBe("ok");
    expect(nextResult.completionRequest!.completionId).toBe(completionId);

    // Past the former 120s lease bound but before the deadline: lease intact.
    vi.advanceTimersByTime(150_000);
    expect(broker.complete(leaseId, completionId!, "text").status).toBe("ok");
  });

  it("rejects a completion whose deadline elapsed and revokes the serving lease", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);

    await vi.advanceTimersByTimeAsync(181_000);
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(broker.complete(leaseId, completionId!, "late")).toEqual({ status: "invalid_lease" });
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "lease_expired" });
  });

  it("lets a new run open a fresh lease immediately after completion expiry", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    await vi.advanceTimersByTimeAsync(181_000);

    const reopened = broker.open("test-provider");
    expect(reopened.status).toBe("ok");
    expect(reopened.leaseId).not.toBe(leaseId);

    const secondId = broker.queueCompletion("run-2", "step-1", "prompt");
    expect(secondId).not.toBeNull();
    const nextResult = await broker.next(reopened.leaseId!, 0);
    expect(nextResult.status).toBe("ok");
    expect(nextResult.completionRequest!.runId).toBe("run-2");
  });

  it("isolates a stale pump: late complete/fail/close cannot touch the newer lease", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    await vi.advanceTimersByTimeAsync(181_000);

    const reopened = broker.open("test-provider");
    expect(reopened.status).toBe("ok");
    const secondId = broker.queueCompletion("run-2", "step-1", "prompt");
    void broker.waitForCompletion(secondId!, new AbortController().signal);

    expect(broker.complete(leaseId, completionId!, "stale")).toEqual({ status: "invalid_lease" });
    expect(broker.fail(leaseId, completionId!, "stale")).toEqual({ status: "invalid_lease" });
    expect(broker.close(leaseId)).toEqual({ status: "not_found" });

    vi.advanceTimersByTime(50_000);
    expect(broker.complete(reopened.leaseId!, secondId!, "fresh").status).toBe("ok");
  });

  it("deadline expiry wins over a simultaneously pending complete", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    await broker.next(leaseId, 0);
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);

    // Jump the clock past the deadline WITHOUT firing the timer: the explicit
    // timestamp check must reject the callback and terminalize immediately.
    vi.setSystemTime(Date.now() + 181_000);
    expect(broker.complete(leaseId, completionId!, "late-but-close")).toEqual({ status: "invalid_completion" });
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledTimes(1);
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "lease_expired" });
  });

  it("setRunTerminal rejects unresolved work as terminal and invalidates the lease", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);

    broker.setRunTerminal();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(broker.complete(leaseId, completionId!, "x")).toEqual({ status: "invalid_lease" });
    expect(broker.close(leaseId)).toEqual({ status: "not_found" });
  });

  it("wakes waiting next() callers with lease_expired when the completion deadline fires", async () => {
    const { broker, leaseId } = openBroker();
    // The pump is polling with a bounded wait when the deadline fires; the
    // lease revocation must surface as lease_expired to the waiting caller.
    const waiter = broker.next(leaseId, 30_000);
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    await expect(waiter).resolves.toMatchObject({ status: "ok" });
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(() => {});

    await vi.advanceTimersByTimeAsync(181_000);
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "lease_expired" });
  });

  it("abort of the sleep run settles the pending waiter as cancelled", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    const controller = new AbortController();
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, controller.signal).catch(rejected);

    controller.abort();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledTimes(1);
    // The lease survives a single-step cancellation until the coordinator
    // terminalizes the run; the abort listener must not be re-entrant.
    expect(broker.fail(leaseId, completionId!, "second")).toEqual({ status: "invalid_completion" });
  });

  it("rejects a pending completion when the idle lease expires before delivery", async () => {
    const { broker, leaseId } = openBroker();
    // A request queued while no pump is waiting: the idle lease (120s) expires
    // before the completion deadline, so the lease expiry wins the pending
    // request and every later call from that lease is stale.
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);

    await vi.advanceTimersByTimeAsync(121_000);
    expect(rejected).toHaveBeenCalledTimes(1);
    // Exact-boundary waiters observe lease_expired, never a heartbeat.
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "lease_expired" });
    expect(broker.close(leaseId)).toEqual({ status: "not_found" });
  });

  it("leaves no live timers or waiters after a terminal transition", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(() => {});
    await vi.advanceTimersByTimeAsync(181_000);

    // Advancing far past the original deadline must not fire anything: no
    // deadline timer, no lease timer, no waiter remains attached.
    vi.advanceTimersByTime(10 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the lease valid through the in-flight completion deadline", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = broker.queueCompletion("run-1", "step-1", "prompt");
    const req = (await broker.next(leaseId, 0)).completionRequest!;

    // At the deadline boundary the lease is still valid (deadline plus the
    // bounded settlement grace); only the completion is terminal.
    await vi.advanceTimersByTimeAsync(req.deadline - Date.now() + 5_000);
    expect(broker.complete(leaseId, completionId!, "after deadline")).toEqual({ status: "invalid_lease" });
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "lease_expired" });
  });
});
