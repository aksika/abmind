import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RuntimeBroker, SleepCompletionDeadlineError } from "./runtime-broker.js";
import type { RuntimeNextResult } from "./runtime-broker.js";

function expectOk(result: RuntimeNextResult): Extract<RuntimeNextResult, { status: "ok" }> {
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result;
}

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

  /** #1681: a refused admission throws here so a test that expects a queued
   *  completion fails loudly instead of silently operating on null. */
  function queued(broker: RuntimeBroker, runId: string, stepId: string, prompt: string, deadlineMs?: number): string {
    const admission = broker.queueCompletion(runId, stepId, prompt, deadlineMs);
    if (admission.status !== "queued") throw new Error(`queueCompletion refused: ${admission.status}`);
    return admission.completionId;
  }

  it("accepts a completion that crosses the former 60s boundary but settles before the new deadline", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");

    const nextResult = expectOk(await broker.next(leaseId, 0));
    expect(nextResult.status).toBe("ok");
    const req = nextResult.completionRequest;
    expect(req.deadline - Date.now()).toBe(180_000);

    vi.advanceTimersByTime(100_000);
    expect(broker.complete(leaseId, completionId!, "text").status).toBe("ok");
  });

  it("does not lose the serving lease to the old 120s idle bound while a 180s completion is in flight", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const req = expectOk(await broker.next(leaseId, 0)).completionRequest;

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
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const nextResult = await waiter;
    expect(nextResult.status).toBe("ok");
    expect(expectOk(nextResult).completionRequest.completionId).toBe(completionId);

    // Past the former 120s lease bound but before the deadline: lease intact.
    vi.advanceTimersByTime(150_000);
    expect(broker.complete(leaseId, completionId!, "text").status).toBe("ok");
  });

  it("rejects only the deadline-expired completion; the lease stays serviceable and the run continues (#1603)", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    await broker.next(leaseId, 0); // pump delivers the request, extending the lease
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);

    await vi.advanceTimersByTimeAsync(181_000);
    expect(rejected).toHaveBeenCalledTimes(1);
    const rejectedCall = rejected.mock.calls[0];
    if (rejectedCall === undefined) throw new Error("rejection callback not called");
    expect(rejectedCall[0]).toBeInstanceOf(SleepCompletionDeadlineError);
    // The lease was NOT revoked — it was returned to its idle window.
    expect(broker.hasProvider).toBe(true);
    // A fresh completion for the same run is delivered by the same lease.
    const secondId = queued(broker, "run-1", "step-2", "prompt-2");
    const nextResult = expectOk(await broker.next(leaseId, 0));
    expect(nextResult.status).toBe("ok");
    expect(expectOk(nextResult).completionRequest.stepId).toBe("step-2");
    expect(broker.complete(leaseId, secondId!, "text").status).toBe("ok");
  });

  it("serves the next completion on the same lease after a deadline expiry (#1603)", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    await broker.next(leaseId, 0);
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(() => {});
    await vi.advanceTimersByTimeAsync(181_000);

    const secondId = queued(broker, "run-1", "step-2", "prompt");
    const nextResult = expectOk(await broker.next(leaseId, 0));
    expect(nextResult.status).toBe("ok");
    expect(expectOk(nextResult).completionRequest.completionId).toBe(secondId);
  });

  it("provider_failed rejects the waiter but does not revoke the lease (#1279 containment unchanged)", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);
    await broker.next(leaseId, 0);

    expect(broker.fail(leaseId, completionId!, "provider_failed").status).toBe("ok");
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(broker.hasProvider).toBe(true);
  });

  it("normalizes untrusted failure metadata at the broker boundary", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId, new AbortController().signal).catch(rejected);
    await broker.next(leaseId, 0);

    expect(broker.fail(leaseId, completionId, "provider_failed", {
      cause: "not-a-sleep-cause",
      detail: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      commandFingerprint: "not-a-fingerprint",
    })).toEqual({ status: "ok" });
    await Promise.resolve();

    expect(rejected).toHaveBeenCalledTimes(1);
    const error = rejected.mock.calls[0]?.[0] as Error & { failure?: Record<string, unknown>; code?: string };
    expect(error.code).toBe("provider_failed");
    expect(error.message).toBe("Runtime provider failed");
    expect(error.failure).toEqual({ cause: "unknown", detail: "Bearer ***REDACTED***" });
  });

  it("isolates a stale pump: late complete/fail/close cannot touch the newer lease", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(() => {});
    // Deadline fires (lease returned to idle window), then the idle window
    // itself elapses — only then is the lease genuinely gone.
    await vi.advanceTimersByTimeAsync(181_000);
    await vi.advanceTimersByTimeAsync(121_000);

    const reopened = broker.open("test-provider");
    expect(reopened.status).toBe("ok");
    expect(reopened.leaseId).not.toBe(leaseId);
    const secondId = queued(broker, "run-2", "step-1", "prompt");
    void broker.waitForCompletion(secondId!, new AbortController().signal);

    expect(broker.complete(leaseId, completionId!, "stale")).toEqual({ status: "invalid_lease" });
    expect(broker.fail(leaseId, completionId!, "stale")).toEqual({ status: "invalid_lease" });
    expect(broker.close(leaseId)).toEqual({ status: "not_found" });

    vi.advanceTimersByTime(50_000);
    expect(broker.complete(reopened.leaseId!, secondId!, "fresh").status).toBe("ok");
  });

  it("deadline expiry wins over a simultaneously pending complete without killing the lease", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    await broker.next(leaseId, 0);
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);

    // Jump the clock past the deadline WITHOUT firing the timer: the explicit
    // timestamp check must reject the callback and terminalize immediately.
    vi.setSystemTime(Date.now() + 181_000);
    expect(broker.complete(leaseId, completionId!, "late-but-close")).toEqual({ status: "invalid_completion" });
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledTimes(1);
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "no_request", heartbeat: true });
  });

  it("setRunTerminal rejects unresolved work as terminal and invalidates the lease", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const rejected = vi.fn();
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(rejected);

    broker.setRunTerminal();
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(broker.complete(leaseId, completionId!, "x")).toEqual({ status: "invalid_lease" });
    expect(broker.close(leaseId)).toEqual({ status: "not_found" });
  });

  it("wakes waiting next() callers with a heartbeat when the completion deadline fires — the lease survives", async () => {
    const { broker, leaseId } = openBroker();
    // The pump is polling with a bounded wait when the deadline fires; the
    // lease is returned to its idle window, surfacing as a heartbeat.
    const waiter = broker.next(leaseId, 30_000);
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    await expect(waiter).resolves.toMatchObject({ status: "ok" });
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(() => {});

    await vi.advanceTimersByTimeAsync(181_000);
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "no_request", heartbeat: true });
  });

  it("abort of the sleep run settles the pending waiter as cancelled", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
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
    const completionId = queued(broker, "run-1", "step-1", "prompt");
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
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    void broker.waitForCompletion(completionId!, new AbortController().signal).catch(() => {});
    await vi.advanceTimersByTimeAsync(181_000);

    // Advancing far past the original deadline must not fire anything: no
    // deadline timer, no lease timer, no waiter remains attached.
    vi.advanceTimersByTime(10 * 60_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the lease valid through the in-flight completion deadline (#1603)", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const req = expectOk(await broker.next(leaseId, 0)).completionRequest;

    // At the deadline boundary the completion is terminal but the lease was
    // returned to its idle window — never revoked by a per-completion deadline.
    await vi.advanceTimersByTimeAsync(req.deadline - Date.now() + 5_000);
    expect(broker.complete(leaseId, completionId!, "after deadline")).toEqual({ status: "invalid_completion" });
    expect(broker.hasProvider).toBe(true);
    await expect(broker.next(leaseId, 0)).resolves.toMatchObject({ status: "no_request", heartbeat: true });
  });

  it("#1611: an explicit remaining window is honored exactly — never the 180s default", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt", 42_000);
    const req = expectOk(await broker.next(leaseId, 0)).completionRequest;
    expect(req.deadline - Date.now(), "the queued absolute deadline must be the explicit window").toBe(42_000);
  });

  it("#1611: a late complete against an explicit short deadline stays invalid_completion", async () => {
    const { broker, leaseId } = openBroker();
    const completionId = queued(broker, "run-1", "step-1", "prompt", 10_000);
    await broker.next(leaseId, 0);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(broker.complete(leaseId, completionId, "late")).toEqual({ status: "invalid_completion" });
    expect(broker.hasProvider).toBe(true);
  });

  it("#1681: repeated bounded long polls refresh the lease — a polling provider stays live past the 120s idle bound", async () => {
    const { broker, leaseId } = openBroker();
    // Production cadence: a 25s bounded poll. Each healthy heartbeat MUST
    // refresh the idle lease — without refresh the lease expires at 120s and
    // an actively polling provider would be reclaimed mid-run.
    for (let i = 0; i < 6; i++) {
      const waiter = broker.next(leaseId, 25_000);
      await vi.advanceTimersByTimeAsync(25_000);
      await expect(waiter).resolves.toMatchObject({ status: "no_request", heartbeat: true });
    }
    // 150s of continuous polling elapsed — the lease would have expired.
    expect(broker.hasProvider).toBe(true);

    // A fresh poll is waiting when a completion is queued: the exact live
    // waiter receives and settles it.
    const waiter = broker.next(leaseId, 25_000);
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const nextResult = await waiter;
    expect(nextResult.status).toBe("ok");
    expect(expectOk(nextResult).completionRequest.completionId).toBe(completionId);
    expect(broker.complete(leaseId, completionId, "text").status).toBe("ok");
  });

  it("#1681: the exact idle boundary is expired — an immediate heartbeat cannot revive or admit work", async () => {
    const { broker, leaseId } = openBroker();
    // Move the clock to the exact expiry without running the expiry timer. The
    // lease is already dead at this boundary and must not be refreshed by a
    // zero-wait poll or accepted by completion admission.
    vi.setSystemTime(new Date(Date.now() + 120_000));

    expect(broker.hasProvider).toBe(false);
    await expect(broker.next(leaseId, 0)).resolves.toEqual({ status: "lease_expired" });
    expect(broker.queueCompletion("run-1", "step-1", "prompt")).toEqual({ status: "provider_unavailable" });
  });

  it("#1681: a timed-out long-poll waiter is removed — a later completion reaches the live waiter, never the settled stale one", async () => {
    const { broker, leaseId } = openBroker();
    // First poll times out. Its promise is already settled, and the exact
    // waiter must be removed from the waiting set so it can never claim a
    // future completion.
    const stale = broker.next(leaseId, 25_000);
    await vi.advanceTimersByTimeAsync(25_000);
    await expect(stale).resolves.toMatchObject({ status: "no_request", heartbeat: true });

    // A second, live poll is waiting when a completion is queued.
    const live = broker.next(leaseId, 25_000);
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    const nextResult = await live;

    // If the stale waiter had survived (the pre-#1681 indexOf(resolve) bug),
    // wakeNext would have delivered the completion into its settled promise —
    // a silent no-op — and the live waiter would starve.
    expect(nextResult.status, "the live waiter receives the queued completion").toBe("ok");
    expect(expectOk(nextResult).completionRequest.completionId).toBe(completionId);
    expect(broker.complete(leaseId, completionId, "text").status).toBe("ok");
  });

  it("#1681: a stale-lease waiter can never claim a completion or mutate its pending state", async () => {
    const { broker, leaseId } = openBroker();
    // A waiter holding the OLD lease id sits in the queue while a completion
    // arrives for the CURRENT lease.
    const stale = broker.next("old-lease", 30_000);
    const completionId = queued(broker, "run-1", "step-1", "prompt");
    await expect(stale).resolves.toMatchObject({ status: "lease_expired" });
    // The pending completion was NOT consumed by the stale waiter — a fresh
    // poll on the current lease still receives it.
    const fresh = await broker.next(leaseId, 0);
    expect(fresh.status).toBe("ok");
    expect(expectOk(fresh).completionRequest.completionId).toBe(completionId);
    expect(broker.complete(leaseId, completionId, "text").status).toBe("ok");
  });

  it("#1681: completion admission reports provider_unavailable when no lease is held", () => {
    const broker = new RuntimeBroker();
    expect(broker.queueCompletion("run-1", "step-1", "prompt")).toEqual({ status: "provider_unavailable" });
  });

  it("#1681: completion admission reports provider_unavailable once the idle lease expired", () => {
    const { broker } = openBroker();
    vi.advanceTimersByTime(121_000);
    expect(broker.queueCompletion("run-1", "step-1", "prompt")).toEqual({ status: "provider_unavailable" });
  });

  it("#1681: completion admission reports completion_pending while a completion is already queued", () => {
    const { broker } = openBroker();
    queued(broker, "run-1", "step-1", "prompt");
    expect(broker.queueCompletion("run-1", "step-2", "prompt-2")).toEqual({ status: "completion_pending" });
  });
});
