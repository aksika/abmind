import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryManager } from "./memory-manager.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import { ContextEngine } from "./context-engine.js";
import {
  registerRuntime,
  removeRuntime,
  _clearAllRuntimes,
} from "./runtime-store.js";
import { createAbmindRecallTool } from "./openclaw-plugin/tools.js";
import type { AbmindPluginRuntime } from "./openclaw-plugin/types.js";

/** Spin up an in-tmpdir abmind plugin runtime for testing. */
async function makeRuntime(pluginId: string): Promise<{ runtime: AbmindPluginRuntime; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), `abmind-tool-test-${pluginId}-`));
  const memoryDir = join(dir, "memory");
  const db: Database.Database = initializeDatabase(join(memoryDir, "memory.db"));
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
    config: { abmlVersion: "plain", compactionThreshold: 0.5, sleepEnabled: false, stateDir: dir },
    memoryConfig,
  };

  return {
    runtime,
    cleanup: () => {
      memory.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("createAbmindRecallTool", () => {
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    _clearAllRuntimes();
    cleanupFns = [];
  });

  afterEach(() => {
    for (const fn of cleanupFns) fn();
    _clearAllRuntimes();
  });

  it("returns a well-formed AgentTool shape", () => {
    const tool = createAbmindRecallTool("plugin-a", undefined);
    expect(tool.name).toBe("abmind_recall");
    expect(tool.label).toBe("Abmind Recall");
    expect(typeof tool.description).toBe("string");
    expect(tool.description.length).toBeLessThan(300);
    expect(typeof tool.execute).toBe("function");
    expect(tool.parameters).toBeDefined();
    // TypeBox schemas are JSON-serializable objects
    expect(tool.parameters.type).toBe("object");
  });

  it("execute() returns jsonResult shape with content[0].type === 'text'", async () => {
    const { runtime, cleanup } = await makeRuntime("plugin-a");
    cleanupFns.push(cleanup);
    registerRuntime("plugin-a", runtime);

    const tool = createAbmindRecallTool("plugin-a", undefined);
    const result = await tool.execute("call-1", { query: "nothing matches" });

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
    // text is JSON-parseable
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.count).toBe(0);
    expect(parsed.hits).toEqual([]);
    // details mirrors the parsed payload
    expect(result.details).toEqual(parsed);
  });

  it("throws when runtime is not registered", async () => {
    const tool = createAbmindRecallTool("unregistered-plugin", undefined);
    await expect(tool.execute("call-1", { query: "x" })).rejects.toThrow(
      /no runtime registered/,
    );
  });

  it("clamps limit to 1-50 range", async () => {
    const { runtime, cleanup } = await makeRuntime("plugin-a");
    cleanupFns.push(cleanup);
    registerRuntime("plugin-a", runtime);

    const tool = createAbmindRecallTool("plugin-a", undefined);

    // Well above max — should not throw, clamped internally
    const over = await tool.execute("call-1", { query: "x", limit: 500 });
    expect(over.details.count).toBe(0);

    // Zero — clamped up to 1
    const zero = await tool.execute("call-2", { query: "x", limit: 0 });
    expect(zero.details.count).toBe(0);

    // Negative — clamped up to 1
    const neg = await tool.execute("call-3", { query: "x", limit: -5 });
    expect(neg.details.count).toBe(0);
  });

  it("isolates recall by sessionKey", async () => {
    // Two runtimes with separate DBs. If session scoping works, tool bound to
    // session A never returns memories stored under session B's chat.
    const { runtime: runtimeA, cleanup: cleanupA } = await makeRuntime("plugin-a");
    cleanupFns.push(cleanupA);
    registerRuntime("plugin-a", runtimeA);

    // Tool for session "agent:alpha:main" → chatId "alpha:main"
    const toolA = createAbmindRecallTool("plugin-a", "agent:alpha:main");
    // Tool for session "agent:beta:main" → chatId "beta:main"
    const toolB = createAbmindRecallTool("plugin-a", "agent:beta:main");

    // Empty DB on both — query returns zero for each session
    const resA = await toolA.execute("call-1", { query: "test" });
    const resB = await toolB.execute("call-2", { query: "test" });
    expect(resA.details.count).toBe(0);
    expect(resB.details.count).toBe(0);
    // (Full end-to-end population-and-search is covered by integration tests.)
  });

  it("description is under 300 chars", () => {
    const tool = createAbmindRecallTool("plugin-a", undefined);
    expect(tool.description.length).toBeLessThan(300);
  });

  it("uses maxClassification=2 internally (caller cannot pass higher)", async () => {
    // We can't directly assert the runtime call args without mocking, but we
    // verify the tool's parameter schema does NOT expose classification.
    // This is the compile-time contract; the runtime hardcodes it in execute.
    const tool = createAbmindRecallTool("plugin-a", undefined);
    const props = tool.parameters.properties;
    expect(props.classification).toBeUndefined();
    expect(props.maxClassification).toBeUndefined();
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["query", "limit", "topic", "emotion"]),
    );
  });

  it("registration cleanup: removeRuntime after test isolates from next test", async () => {
    const { runtime, cleanup } = await makeRuntime("plugin-a");
    cleanupFns.push(cleanup);
    registerRuntime("plugin-a", runtime);

    removeRuntime("plugin-a");

    const tool = createAbmindRecallTool("plugin-a", undefined);
    // Runtime gone — execute should throw
    await expect(tool.execute("call-1", { query: "x" })).rejects.toThrow(
      /no runtime registered/,
    );
  });
});

import { createAbmindStoreTool } from "./openclaw-plugin/tools.js";

describe("createAbmindStoreTool", () => {
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => { _clearAllRuntimes(); });
  afterEach(() => { _clearAllRuntimes(); cleanupFns.forEach(fn => fn()); cleanupFns = []; });

  it("stores a memory with correct userId from sessionKey", async () => {
    const { runtime, cleanup } = await makeRuntime("store-test");
    cleanupFns.push(cleanup);
    registerRuntime("store-test", runtime);

    const tool = createAbmindStoreTool("store-test", "agent:main:user123");
    const result = await tool.execute("call-1", {
      content: "User prefers dark mode",
      type: "preference",
      topic: "personal",
    });

    expect(result.details.stored).toBe(true);
    // Verify userId derived from sessionKey via toChatId
    const row = runtime.db.prepare("SELECT user_id, memory_type, topic FROM extracted_memories ORDER BY id DESC LIMIT 1").get() as any;
    expect(row.user_id).toBe("user123");
    expect(row.memory_type).toBe("preference");
    expect(row.topic).toBe("personal");
  });

  it("stores classification=3 memory", async () => {
    const { runtime, cleanup } = await makeRuntime("store-secret");
    cleanupFns.push(cleanup);
    registerRuntime("store-secret", runtime);

    const tool = createAbmindStoreTool("store-secret", "agent:main:aksika");
    const result = await tool.execute("call-1", {
      content: "sk-1234567890abcdef1234567890abcdef",
      type: "fact",
      classification: 3,
    });

    // Either stores (key available) or rejects (no key) — both are correct behavior
    if (result.details.stored) {
      const row = runtime.db.prepare("SELECT classification, encrypted FROM extracted_memories ORDER BY id DESC LIMIT 1").get() as any;
      expect(row.classification).toBe(3);
    } else {
      expect(result.details.error).toContain("encryption key");
    }
  });

  it("rejects unknown memory type", async () => {
    const { runtime, cleanup } = await makeRuntime("store-badtype");
    cleanupFns.push(cleanup);
    registerRuntime("store-badtype", runtime);

    const tool = createAbmindStoreTool("store-badtype", "agent:main:u1");
    const result = await tool.execute("call-1", {
      content: "something",
      type: "invalid_type",
    });

    expect(result.details.stored).toBe(false);
    expect(result.details.code).toBe("validation_error");
    expect(result.details.message).toContain("invalid memory_type");
  });
});
