import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "../memory-db.js";
import { MemoryManager } from "../memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "../memory-config.js";
import { ContextEngine } from "../context-engine.js";
import { registerRuntime, _clearAllRuntimes } from "../runtime-store.js";
import { createMemoryPluginRuntime } from "./runtime-adapter.js";
import { abmindUri, parseAbmindUri } from "./runtime-adapter.js";
import { buildPromptSection } from "./prompt-builder.js";
import { buildListArtifacts } from "./public-artifacts.js";
import { buildAutoRecallHook, buildAutoCaptureHook } from "./hooks.js";
import type { AbmindPluginRuntime } from "./types.js";

async function makeRuntime(pluginId: string): Promise<{ runtime: AbmindPluginRuntime; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), `abmind-201-test-${pluginId}-`));
  const memoryDir = join(dir, "memory");
  mkdirSync(memoryDir, { recursive: true });
  const db = initializeDatabase(join(memoryDir, "memory.db"));
  const memoryConfig = { ...MEMORY_CONFIG_DEFAULTS, memoryDir };
  const memory = new MemoryManager(memoryConfig);
  await memory.initialize({ skipEmbeddingCheck: true });
  const contextEngine = new ContextEngine(db);
  const runtime: AbmindPluginRuntime = {
    pluginId,
    contextEngine,
    memory,
    db,
    completeFn: async () => "",
    config: { abmlVersion: "plain", compactionThreshold: 0.5, sleepEnabled: false, autoRecall: false, autoCapture: false, autoRecallMaxResults: 3, autoRecallMinScore: 0.3 },
    memoryConfig,
  };
  return { runtime, cleanup: () => { memory.close(); rmSync(dir, { recursive: true, force: true }); } };
}

describe("OpenClaw memory-capability (#201)", () => {
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => { _clearAllRuntimes(); cleanupFns = []; });
  afterEach(() => { for (const fn of cleanupFns) fn(); _clearAllRuntimes(); });

  // ── URI helpers ──────────────────────────────────────────────────────────

  describe("abmindUri / parseAbmindUri", () => {
    it("round-trips a memory id", () => {
      const uri = abmindUri(42);
      expect(uri).toBe("abmind://memory/42");
      expect(parseAbmindUri(uri)).toEqual({ memoryId: 42 });
    });

    it("rejects non-abmind URIs", () => {
      expect(parseAbmindUri("memory/42.md")).toBeNull();
      expect(parseAbmindUri("file:///tmp/x")).toBeNull();
      expect(parseAbmindUri("")).toBeNull();
    });

    it("rejects invalid ids", () => {
      expect(parseAbmindUri("abmind://memory/abc")).toBeNull();
      expect(parseAbmindUri("abmind://memory/-1")).toBeNull();
      expect(parseAbmindUri("abmind://memory/0")).toBeNull();
    });
  });

  // ── MemoryPluginRuntime ──────────────────────────────────────────────────

  describe("createMemoryPluginRuntime", () => {
    it("getMemorySearchManager returns a manager with search + readFile + status", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const pluginRuntime = createMemoryPluginRuntime("p1");
      const { manager } = pluginRuntime.getMemorySearchManager({});
      expect(manager).toBeDefined();
      expect(typeof manager.search).toBe("function");
      expect(typeof manager.readFile).toBe("function");
      expect(typeof manager.status).toBe("function");
    });

    it("search returns empty array on fresh DB", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const { manager } = createMemoryPluginRuntime("p1").getMemorySearchManager({});
      const results = await manager.search("anything");
      expect(results).toEqual([]);
    });

    it("readFile throws on non-abmind URI", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const { manager } = createMemoryPluginRuntime("p1").getMemorySearchManager({});
      await expect(manager.readFile({ relPath: "memory/1.md" })).rejects.toThrow(/not an abmind:\/\/ URI/);
    });

    it("readFile throws on missing memory id", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const { manager } = createMemoryPluginRuntime("p1").getMemorySearchManager({});
      await expect(manager.readFile({ relPath: "abmind://memory/99999" })).rejects.toThrow(/not found/);
    });

    it("status reports backend and embedding state", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const { manager } = createMemoryPluginRuntime("p1").getMemorySearchManager({});
      const s = manager.status();
      expect(s.backend).toBe("abmind-sqlite");
      expect(typeof s.embeddingAvailable).toBe("boolean");
    });

    it("resolveMemoryBackendConfig returns builtin", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const result = createMemoryPluginRuntime("p1").resolveMemoryBackendConfig({});
      expect(result.backend).toBe("builtin");
    });
  });

  // ── Prompt builder ───────────────────────────────────────────────────────

  describe("buildPromptSection", () => {
    it("returns non-empty string array", () => {
      const lines = buildPromptSection({});
      expect(Array.isArray(lines)).toBe(true);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(typeof line).toBe("string");
    });
  });

  // ── Public artifacts ─────────────────────────────────────────────────────

  describe("buildListArtifacts", () => {
    it("returns empty array on fresh install (no markdown files)", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const listFn = buildListArtifacts("p1");
      const artifacts = await listFn();
      expect(artifacts).toEqual([]);
    });

    it("finds daily markdown files when present", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      // Seed a daily file
      const dailyDir = join(runtime.memoryConfig.memoryDir, "daily");
      mkdirSync(dailyDir, { recursive: true });
      writeFileSync(join(dailyDir, "daily_20260501.md"), "# Test daily\n");

      const listFn = buildListArtifacts("p1");
      const artifacts = await listFn();
      expect(artifacts.length).toBe(1);
      expect(artifacts[0].category).toBe("daily");
      expect(artifacts[0].relPath).toBe("daily/daily_20260501.md");
    });
  });

  // ── Hooks ────────────────────────────────────────────────────────────────

  describe("autoRecall hook", () => {
    it("returns empty object when no prompt in event", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const handler = buildAutoRecallHook({ pluginId: "p1", maxResults: 3, minScore: 0.3 });
      const result = await handler({});
      expect(result).toEqual({});
    });

    it("returns empty object when no memories match", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const handler = buildAutoRecallHook({ pluginId: "p1", maxResults: 3, minScore: 0.3 });
      const result = await handler({ prompt: "something nobody ever said" });
      expect(result).toEqual({});
    });
  });

  describe("autoCapture hook", () => {
    it("records user messages from event", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const handler = buildAutoCaptureHook({ pluginId: "p1" });
      await handler({
        messages: [
          { role: "user", content: "remember this fact" },
          { role: "assistant", content: "I will remember it" },
        ],
        userId: "test-user",
        sessionId: "test-session",
      });

      // Verify message was recorded (user only, not assistant)
      const msgs = runtime.memory.loadRecentMessages("test-user", "test-session", 10);
      expect(msgs.length).toBe(1);
      expect(msgs[0]!.content).toBe("remember this fact");
      expect(msgs[0]!.role).toBe("user");
    });

    it("skips assistant messages (self-poisoning mitigation)", async () => {
      const { runtime, cleanup } = await makeRuntime("p1");
      cleanupFns.push(cleanup);
      registerRuntime("p1", runtime);

      const handler = buildAutoCaptureHook({ pluginId: "p1" });
      await handler({
        messages: [{ role: "assistant", content: "I am the assistant" }],
        userId: "test-user",
        sessionId: "test-session",
      });

      const msgs = runtime.memory.loadRecentMessages("test-user", "test-session", 10);
      expect(msgs.length).toBe(0);
    });
  });
});
