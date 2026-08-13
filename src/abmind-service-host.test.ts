import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AbmindServiceHost, createEmbeddedAbmind } from "./abmind-service-host.js";
import { InjectableProcessIdentity } from "./abmind-owner-lease.js";
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
