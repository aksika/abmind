import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AbmindServiceHost, createEmbeddedAbmind } from "./abmind-service-host.js";
import { InjectableProcessIdentity, type ProcessIdentityProvider } from "./abmind-owner-lease.js";
import type { DomainName } from "./abmind-protocol.js";
import type { MemoryConfig } from "./memory-config.js";

const MEM_CONFIG: MemoryConfig = {
  memoryEnabled: true,
  memoryDir: "",
  maxMessagesPerChat: 100,
  diskBudgetBytes: 1048576,
  stalenessThresholdMs: 86400000,
  restoreMessageCount: 50,
  ingestChunkMaxTokens: 512,
  embeddingModel: "nomic-embed-text",
  forgetThreshold: 0.8,
  searchEnhancements: {
    searchTimeoutMs: 1000,
    decayHalflifeDays: 30,
    mmrLambda: 0.7,
    compactThresholdPct: 85,
  },
};

describe("AbmindServiceHost", () => {
  it("starts and stops successfully", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-host-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 2001, startToken: "boot-abc" });
      const host = new AbmindServiceHost({
        mode: "embedded",
        memory: { ...MEM_CONFIG, memoryDir: dir },
        policy: { principalId: "test", role: "local_user", grantedDomains: ["system", "private", "operational"], authenticatedBy: "embedded" },
        leaseRoot: dir,
        processIdentity: identity,
      });

      expect(host.started).toBe(false);
      await host.start();
      expect(host.started).toBe(true);
      expect(host.manager).not.toBeNull();
      expect(host.service).not.toBeNull();

      await host.stop();
      expect(host.started).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-host2-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 3001, startToken: "boot-def" });
      const host = new AbmindServiceHost({
        mode: "embedded",
        memory: { ...MEM_CONFIG, memoryDir: dir },
        policy: { principalId: "test", role: "local_user", grantedDomains: ["system"], authenticatedBy: "embedded" },
        leaseRoot: dir,
        processIdentity: identity,
      });

      await host.start();
      await host.start(); // second start should be no-op
      expect(host.started).toBe(true);
      await host.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stop is idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-host3-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 4001, startToken: "boot-ghi" });
      const host = new AbmindServiceHost({
        mode: "embedded",
        memory: { ...MEM_CONFIG, memoryDir: dir },
        policy: { principalId: "test", role: "local_user", grantedDomains: ["system"], authenticatedBy: "embedded" },
        leaseRoot: dir,
        processIdentity: identity,
      });

      await host.start();
      await host.stop();
      await host.stop(); // second stop should be no-op
      expect(host.started).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates an owner lease on start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-host4-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 5001, startToken: "boot-jkl" });
      const host = new AbmindServiceHost({
        mode: "embedded",
        memory: { ...MEM_CONFIG, memoryDir: dir },
        policy: { principalId: "test", role: "local_user", grantedDomains: ["system"], authenticatedBy: "embedded" },
        leaseRoot: dir,
        processIdentity: identity,
      });

      await host.start();

      const dbHash = createHash("sha256").update(join(dir, "memory.db")).digest("hex");
      const leaseDir = join(dir, "owners", `${dbHash}.lease`);
      expect(existsSync(leaseDir)).toBe(true);

      await host.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the lease namespace separate from the memory directory", async () => {
    const memoryDir = mkdtempSync(join(tmpdir(), "abmind-host-lease-memory-"));
    const leaseRoot = mkdtempSync(join(tmpdir(), "abmind-host-lease-root-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 5002, startToken: "boot-lease-root" });
      const host = new AbmindServiceHost({
        mode: "embedded",
        memory: { ...MEM_CONFIG, memoryDir },
        policy: { principalId: "test", role: "local_user", grantedDomains: ["system"], authenticatedBy: "embedded" },
        leaseRoot,
        processIdentity: identity,
      });

      await host.start();

      const dbHash = createHash("sha256").update(join(memoryDir, "memory.db")).digest("hex");
      expect(existsSync(join(leaseRoot, "owners", `${dbHash}.lease`))).toBe(true);
      expect(existsSync(join(memoryDir, "owners", `${dbHash}.lease`))).toBe(false);

      await host.stop();
    } finally {
      rmSync(memoryDir, { recursive: true, force: true });
      rmSync(leaseRoot, { recursive: true, force: true });
    }
  });
});

describe("createEmbeddedAbmind", () => {
  it("creates host + client in one call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-embedded-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 6001, startToken: "boot-mno" });
      const result = await createEmbeddedAbmind({
        mode: "embedded",
        memory: { ...MEM_CONFIG, memoryDir: dir },
        policy: { principalId: "app", role: "host_agent", grantedDomains: ["system", "private", "operational"], authenticatedBy: "embedded" },
        leaseRoot: dir,
        processIdentity: identity,
      }, { principalId: "app", role: "host_agent" });

      expect(result.host).toBeInstanceOf(AbmindServiceHost);
      expect(result.client.system).toBeDefined();
      expect(result.client.privateMemory).toBeDefined();
      expect(result.client.operational).toBeDefined();

      const health = await result.client.system.health();
      expect(health.status).toBe("healthy");

      await result.host.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── #1701: start/stop race safety and shared shutdown completion ────────────

/** Identity provider whose captureSelf() blocks until the test releases it. */
class DeferredProcessIdentity implements ProcessIdentityProvider {
  released = false;
  private readonly deferred: Promise<{ pid: number; startToken: string }>;
  release!: (identity: { pid: number; startToken: string }) => void;

  constructor() {
    this.deferred = new Promise((resolve) => {
      this.release = (id) => { this.released = true; resolve(id); };
    });
  }

  captureSelf(): Promise<{ pid: number; startToken: string }> {
    return this.deferred;
  }

  async inspect(): Promise<{ state: "live"; startToken: string }> {
    return { state: "live", startToken: "deferred-token" };
  }
}

function leaseDirFor(dir: string): string {
  const dbHash = createHash("sha256").update(join(dir, "memory.db")).digest("hex");
  return join(dir, "owners", `${dbHash}.lease`);
}

const LOCAL_CONTEXT = {
  principalId: "test",
  role: "local_user" as const,
  grantedDomains: new Set<DomainName>(["system"]),
  capabilities: new Set<string>(["sleep_events"]),
  authenticatedBy: "embedded" as const,
};

function makeHostConfig(dir: string, identity: ProcessIdentityProvider): import("./abmind-service-host.js").AbmindOwnerConfig {
  return {
    mode: "embedded",
    memory: { ...MEM_CONFIG, memoryDir: dir },
    policy: {
      principalId: LOCAL_CONTEXT.principalId,
      role: LOCAL_CONTEXT.role,
      grantedDomains: ["system"],
      authenticatedBy: "embedded",
      capabilities: [...LOCAL_CONTEXT.capabilities],
    },
    leaseRoot: dir,
    processIdentity: identity,
  };
}

function longPollRequest(requestId: string, waitMs: number) {
  return { version: 1 as const, requestId, method: "sleep.events" as const, payload: { afterSeq: 999_999, limit: 10, waitMs } };
}

describe("AbmindServiceHost lifecycle races (#1701)", () => {
  it("a stop racing a blocked startup settles both with no published host and no leftover lease", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-host-race-"));
    try {
      const identity = new DeferredProcessIdentity();
      const host = new AbmindServiceHost(makeHostConfig(dir, identity));

      const startPromise = host.start();
      // Let start() reach the blocked identity capture before requesting stop.
      await new Promise((r) => setTimeout(r, 50));
      expect(host.started).toBe(false);

      const stopPromise = host.stop();
      identity.release({ pid: process.pid, startToken: "late-token" });

      await expect(startPromise).rejects.toThrow(/Shutdown requested during startup/);
      await stopPromise;

      expect(host.started).toBe(false);
      expect(host.manager).toBeNull();
      expect(host.service).toBeNull();
      expect(existsSync(leaseDirFor(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("concurrent stop() calls join one completion; the lease disappears before any caller observes completion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-host-stop2-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 7102, startToken: "boot-stop2" });
      const host = new AbmindServiceHost(makeHostConfig(dir, identity));
      await host.start();
      expect(existsSync(leaseDirFor(dir))).toBe(true);

      // An idle sleep long poll in flight — beginShutdown must unwind it
      // before final teardown rather than leaving it blocking the drain.
      let pollSettledAt = 0;
      const poll = host.service!.handle(longPollRequest("lp-1", 60_000), LOCAL_CONTEXT)
        .then((r) => { pollSettledAt = Date.now(); return r; });
      await new Promise((r) => setTimeout(r, 150));
      expect(host.service!.inFlight).toBe(1);

      const stop1 = host.stop();
      const stop2 = host.stop();

      await Promise.all([stop1, stop2, poll]);

      // The bounded waiter was unwound by shutdown (not left consuming the
      // window), teardown completed, and ownership was released before any
      // stop() caller could observe completion.
      expect(pollSettledAt).toBeGreaterThan(0);
      expect(existsSync(leaseDirFor(dir))).toBe(false);
      expect(host.started).toBe(false);
      expect(host.manager).toBeNull();

      // A later third stop joins the memoized outcome without re-releasing.
      await host.stop();
      expect(existsSync(leaseDirFor(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("beginShutdown rejects new requests immediately and unwinds accepted sleep waiters", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-host-begin-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 7103, startToken: "boot-begin" });
      const host = new AbmindServiceHost(makeHostConfig(dir, identity));
      await host.start();

      const longPoll = host.service!.handle(longPollRequest("lp-2", 60_000), LOCAL_CONTEXT);
      await new Promise((r) => setTimeout(r, 150));
      expect(host.service!.inFlight).toBe(1);

      host.beginShutdown();

      const late = await host.service!.handle(
        { version: 1, requestId: "late-1", method: "system.health", payload: {} },
        LOCAL_CONTEXT,
      );
      expect(late.ok).toBe(false);
      if (!late.ok) expect(late.error.code).toBe("unavailable");

      // New work is refused, but the accepted request is unwound promptly by
      // sleep-coordinator terminalization — it must not consume the window.
      const startedAt = Date.now();
      const response = await longPoll;
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(response.ok).toBe(true);
      expect(response.ok && response.result.terminal).toBe(true);
      expect(await host.drainAcceptedWork(5_000)).toMatchObject({ drained: true, remainingInFlight: 0 });

      await host.finishStop();
      expect(existsSync(leaseDirFor(dir))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
