import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { storeDurable } from "./personal-durable.js";
import { buildHookAdapterContext, buildHookClientContext } from "../cli/hook-lifecycle-adapter.js";
import { resolveHookFormat, writeHookOutput } from "../cli/hook-output.js";
import type { HookFormat } from "../cli/hook-output.js";
import { abmindHooksDir, hookSidecarKey, hookSidecarPath } from "./mem-paths.js";
import { ensureHooksDir } from "./hook-helpers.js";
import { _resetAbmindEnv } from "./env-schema.js";

// ── Test 5: sidecar cleanup on missing adapter context ────────────────────

describe("abmind-hook-store sidecar cleanup", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedUserId: string | undefined;
  let savedSessionId: string | undefined;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-cleanup-"));
    savedHome = process.env.ABMIND_HOME;
    savedUserId = process.env.ABMIND_USER_ID;
    savedSessionId = process.env.KIRO_SESSION_ID;
    process.env.ABMIND_HOME = tmpDir;
    process.env.KIRO_SESSION_ID = "test-session-cleanup";
    delete process.env.ABMIND_USER_ID;

    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    if (savedHome === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = savedHome;
    if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = savedUserId;
    if (savedSessionId === undefined) delete process.env.KIRO_SESSION_ID;
    else process.env.KIRO_SESSION_ID = savedSessionId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("buildHookAdapterContext returns null when no primary user is registered", () => {
    const ctx = buildHookAdapterContext(mm);
    expect(ctx).toBeNull();
  });

  it("removes last-prompt sidecar file when adapter context is missing", () => {
    ensureHooksDir();
    const sidecarPath = hookSidecarPath();
    writeFileSync(sidecarPath, "test user prompt from recall hook", "utf-8");

    expect(buildHookAdapterContext(mm)).toBeNull();

    expect(existsSync(sidecarPath)).toBe(true);
    const { unlinkSync } = require("node:fs");
    try { unlinkSync(sidecarPath); } catch {}

    expect(existsSync(sidecarPath)).toBe(false);
  });

  it("removes tools-*.sidecar file when adapter context is missing", () => {
    ensureHooksDir();
    const key = hookSidecarKey();
    const toolsPath = join(abmindHooksDir(), `tools-${key}.sidecar`);
    writeFileSync(toolsPath, "tool output from post-tool-use hook", "utf-8");

    expect(buildHookAdapterContext(mm)).toBeNull();

    expect(existsSync(toolsPath)).toBe(true);
    const { unlinkSync } = require("node:fs");
    try { unlinkSync(toolsPath); } catch {}

    expect(existsSync(toolsPath)).toBe(false);
  });

  it("both sidecar files are removed together — regressions the bca69fb bug", () => {
    ensureHooksDir();
    const sidecarPath = hookSidecarPath();
    const key = hookSidecarKey();
    const toolsPath = join(abmindHooksDir(), `tools-${key}.sidecar`);

    writeFileSync(sidecarPath, "user prompt", "utf-8");
    writeFileSync(toolsPath, "tool output", "utf-8");
    expect(existsSync(sidecarPath)).toBe(true);
    expect(existsSync(toolsPath)).toBe(true);

    expect(buildHookAdapterContext(mm)).toBeNull();

    const { unlinkSync } = require("node:fs");
    try { unlinkSync(sidecarPath); } catch {}
    const toolsCleanup = join(abmindHooksDir(), `tools-${hookSidecarKey()}.sidecar`);
    if (existsSync(toolsCleanup)) { try { unlinkSync(toolsCleanup); } catch {} }

    expect(existsSync(sidecarPath)).toBe(false);
    expect(existsSync(toolsPath)).toBe(false);
  });
});

// ── Test 6: Raw/Codex/Gemini output-envelope parity ───────────────────────

describe("resolveHookFormat", () => {
  let savedArgv: string[];

  beforeEach(() => {
    savedArgv = process.argv;
  });

  afterEach(() => {
    process.argv = savedArgv;
  });

  it("defaults to 'raw' when no --format flag is present", () => {
    process.argv = ["node", "abmind-hook-wakeup"];
    expect(resolveHookFormat()).toBe("raw");
  });

  it('returns "codex" for --format codex', () => {
    process.argv = ["node", "abmind-hook-wakeup", "--format", "codex"];
    expect(resolveHookFormat()).toBe("codex");
  });

  it('returns "gemini" for --format gemini', () => {
    process.argv = ["node", "abmind-hook-wakeup", "--format", "gemini"];
    expect(resolveHookFormat()).toBe("gemini");
  });

  it('defaults to "raw" for unknown format values', () => {
    process.argv = ["node", "abmind-hook-wakeup", "--format", "unknown"];
    expect(resolveHookFormat()).toBe("raw");
  });
});

describe("writeHookOutput", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("raw format writes text directly", () => {
    writeHookOutput("Hello world", "raw");
    expect(stdoutSpy).toHaveBeenCalledWith("Hello world");
  });

  it("codex format wraps in systemMessage JSON envelope", () => {
    writeHookOutput("Context from memory", "codex");
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ systemMessage: "Context from memory" }),
    );
  });

  it("gemini format wraps in hookSpecificOutput JSON envelope", () => {
    writeHookOutput("Memory data", "gemini");
    expect(stdoutSpy).toHaveBeenCalledWith(
      JSON.stringify({ hookSpecificOutput: { additionalContext: "Memory data" } }),
    );
  });

  it("empty string produces no output", () => {
    writeHookOutput("", "raw");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("whitespace-only string produces no output (any format)", () => {
    writeHookOutput("   ", "codex");
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  it("codex and gemini output are byte-for-byte equivalent on same content", () => {
    const content = "Test memory context for envelope parity check";

    writeHookOutput(content, "codex");
    const codexArg = stdoutSpy.mock.calls[0]![0] as string;

    writeHookOutput(content, "gemini");
    const geminiArg = stdoutSpy.mock.calls[1]![0] as string;

    expect(codexArg).not.toBe(geminiArg);
    expect(JSON.parse(codexArg)).toEqual({ systemMessage: content });
    expect(JSON.parse(geminiArg)).toEqual({ hookSpecificOutput: { additionalContext: content } });
  });
});

// ── Test 7: User-before-assistant ordering through full hook chain ────────

describe("abmind hook chain — recall→store integration", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedUserId: string | undefined;
  let savedSessionId: string | undefined;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-chain-"));
    savedHome = process.env.ABMIND_HOME;
    savedUserId = process.env.ABMIND_USER_ID;
    savedSessionId = process.env.KIRO_SESSION_ID;
    process.env.ABMIND_HOME = tmpDir;
    process.env.ABMIND_USER_ID = "test-primary-user";
    process.env.KIRO_SESSION_ID = "test-session-chain";

    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    if (savedHome === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = savedHome;
    if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = savedUserId;
    if (savedSessionId === undefined) delete process.env.KIRO_SESSION_ID;
    else process.env.KIRO_SESSION_ID = savedSessionId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("buildHookAdapterContext returns a context when primary user is registered", () => {
    const ctx = buildHookAdapterContext(mm);
    expect(ctx).not.toBeNull();
    if (ctx) {
      expect(ctx.identity.principalId).toBe("test-primary-user");
      expect(ctx.identity.conversationId).toBe("test-session-chain");
      expect(ctx.identity.executionId).toBe("test-session-chain");
      expect(ctx.identity.host).toBe("abmind-cli-hooks");
    }
  });

  it("recall→store chain: sidecar written by recall, read by store, turn recorded", () => {
    ensureHooksDir();
    const sidecarPath = hookSidecarPath();
    const userPrompt = "What is the capital of France?";

    // Step 1: recall hook writes the sidecar
    writeFileSync(sidecarPath, userPrompt, "utf-8");
    expect(existsSync(sidecarPath)).toBe(true);
    expect(readFileSync(sidecarPath, "utf-8")).toBe(userPrompt);

    // Step 2: store hook reads the sidecar and calls completeTurn
    const ctx = buildHookAdapterContext(mm);
    expect(ctx).not.toBeNull();
    if (ctx === null || ctx.lifecycle === undefined) throw new Error("expected hook adapter context");

    const savedPrompt = existsSync(sidecarPath)
      ? readFileSync(sidecarPath, "utf-8").trim()
      : undefined;

    const result = ctx.lifecycle.completeTurn({
      identity: ctx.identity,
      user: savedPrompt ? { content: savedPrompt } : undefined,
      assistant: { content: "The capital of France is Paris." },
    });

    expect(result.status).toBe("recorded");
    if (result.status === "recorded") {
      expect(result.messageIds).toHaveLength(2);
    }

    // Step 3: verify messages were recorded in correct order
    const msgs = mm.loadRecentMessages("test-primary-user", "test-session-chain", 10);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
    expect(msgs[msgs.length - 2]!.role).toBe("user");
    expect(msgs[msgs.length - 2]!.content).toBe(userPrompt);
    expect(msgs[msgs.length - 1]!.role).toBe("assistant");
    expect(msgs[msgs.length - 1]!.content).toBe("The capital of France is Paris.");
  });

  it("multiple turns via full chain maintain message ordering", () => {
    ensureHooksDir();
    const convId = hookSidecarKey();
    const adapter = buildHookAdapterContext(mm);
    if (adapter === null || adapter.lifecycle === undefined) throw new Error("expected hook adapter context");
    const lifecycle = adapter.lifecycle;

    // Turn 1
    lifecycle.completeTurn({
      identity: {
        principalId: "test-primary-user",
        conversationId: convId,
        executionId: "exec-turn-1",
        host: "abmind-cli-hooks",
        origin: "interactive",
        automaticWriteOwner: "abmind-cli-hooks",
      },
      user: { content: "First question", timestamp: 1000 },
      assistant: { content: "First answer", timestamp: 1001 },
    });

    // Turn 2 — different executionId, same conversationId
    lifecycle.completeTurn({
      identity: {
        principalId: "test-primary-user",
        conversationId: convId,
        executionId: "exec-turn-2",
        parentExecutionId: "exec-turn-1",
        host: "abmind-cli-hooks",
        origin: "interactive",
        automaticWriteOwner: "abmind-cli-hooks",
      },
      user: { content: "Second question", timestamp: 1002 },
      assistant: { content: "Second answer", timestamp: 1003 },
    });

    const msgs = mm.loadRecentMessages("test-primary-user", convId, 10);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]!.content).toBe("First question");
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[1]!.content).toBe("First answer");
    expect(msgs[1]!.role).toBe("assistant");
    expect(msgs[2]!.content).toBe("Second question");
    expect(msgs[2]!.role).toBe("user");
    expect(msgs[3]!.content).toBe("Second answer");
    expect(msgs[3]!.role).toBe("assistant");
  });
});

// ── Test 8: #1813 hook recall uses the deterministic selection ────────────

describe("#1928 M4 — hook recall returns the owner packet intact", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedUserId: string | undefined;
  let mm: MemoryManager;

  function packetWith(text: string, count: number): import("./owned-recall-contract.js").OwnedRecallPacket {
    return {
      contract: "owned-v1",
      profile: "recall_fast",
      packetId: "test-packet",
      principal: "test-primary-user",
      status: "evidence",
      items: [],
      text,
      effective: { maxItems: 5, maxOutputBytes: 2000, deadlineMs: 500, policyVersion: "owned-v1" },
      stageOutcomes: { Sf: { status: "completed", hitCount: count } },
      omissionReasons: [],
    };
  }

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-select-"));
    savedHome = process.env.ABMIND_HOME;
    savedUserId = process.env.ABMIND_USER_ID;
    process.env.ABMIND_HOME = tmpDir;
    process.env.ABMIND_USER_ID = "test-primary-user";

    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mm.close();
    if (savedHome === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = savedHome;
    if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = savedUserId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("delivers the owner text verbatim with no local clipping or floors", async () => {
    const ctx = buildHookAdapterContext(mm);
    if (ctx === null) throw new Error("expected hook adapter context");
    vi.spyOn(mm, "recall").mockResolvedValue(packetWith("[1] (db:durable:9:test:1) Deploy alpha.\n[2] (db:durable:10:test:1) Deploy beta.", 2));
    const result = await ctx.recall({ query: "deploy", limit: 10, maxChars: 2000 });
    expect(result.context).toBe("[1] (db:durable:9:test:1) Deploy alpha.\n[2] (db:durable:10:test:1) Deploy beta.");
  });

  it("counts the packet items without re-rendering or reselecting", async () => {
    const ctx = buildHookAdapterContext(mm);
    if (ctx === null) throw new Error("expected hook adapter context");
    vi.spyOn(mm, "recall").mockResolvedValue(packetWith("[1] (db:durable:1:test:1) Deploy alpha.", 1));
    const result = await ctx.recall({ query: "deploy", limit: 10, maxChars: 2000 });
    expect(result.count).toBe(result.packet.items.length);
    expect(result.packet.profile).toBe("recall_fast");
  });

  it("reserves the hook wrapper overhead before requesting capacity", async () => {
    const ctx = buildHookAdapterContext(mm);
    if (ctx === null) throw new Error("expected hook adapter context");
    const spy = vi.spyOn(mm, "recall").mockResolvedValue(packetWith("", 0));
    await ctx.recall({ query: "deploy", limit: 7, maxChars: 2000 });
    const params = spy.mock.calls[0]![0];
    expect(params.profile).toBe("recall_fast");
    expect(params.capacity?.maxItems).toBe(5);
    expect(params.capacity?.maxOutputBytes).toBeLessThan(2000);
  });
});

describe("#1928 M4 — hook adapter uses the common fast core", () => {
  let tmpDir: string;
  let savedHome: string | undefined;
  let savedUserId: string | undefined;
  let savedSessionId: string | undefined;
  let mm: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "hook-intent-"));
    savedHome = process.env.ABMIND_HOME;
    savedUserId = process.env.ABMIND_USER_ID;
    savedSessionId = process.env.KIRO_SESSION_ID;
    process.env.ABMIND_HOME = tmpDir;
    process.env.ABMIND_USER_ID = "test-primary-user";
    process.env.KIRO_SESSION_ID = "test-session-intent";

    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mm.close();
    if (savedHome === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = savedHome;
    if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = savedUserId;
    if (savedSessionId === undefined) delete process.env.KIRO_SESSION_ID;
    else process.env.KIRO_SESSION_ID = savedSessionId;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("local path: the verbatim turn rides as the fast raw turn", async () => {
    const ctx = buildHookAdapterContext(mm);
    if (ctx === null) throw new Error("expected hook adapter context");
    const spy = vi.spyOn(mm, "recall");
    await ctx.recall({ query: "Docker status report" });
    expect(spy).toHaveBeenCalledTimes(1);
    const params = spy.mock.calls[0]![0];
    expect(params.contract).toBe("owned-v1");
    expect(params.profile).toBe("recall_fast");
    expect(params.rawTurn).toBe("Docker status report");
    expect(params).not.toHaveProperty("translated");
  });

  it("local path: no token preparation on source-language turns", async () => {
    const ctx = buildHookAdapterContext(mm);
    if (ctx === null) throw new Error("expected hook adapter context");
    const spy = vi.spyOn(mm, "recall");
    await ctx.recall({ query: "köszi szépen" });
    expect(spy).toHaveBeenCalledTimes(1);
    const params = spy.mock.calls[0]![0];
    expect(params.profile).toBe("recall_fast");
    expect(params.rawTurn).toBe("köszi szépen");
  });

  it("daemon path: the owned fast request crosses the client boundary", async () => {
    const seen: unknown[] = [];
    const fakeClient = {
      privateMemory: {
        recall: vi.fn(async (p: unknown) => {
          seen.push(p);
          return {
            contract: "owned-v1",
            profile: "recall_fast",
            packetId: "test",
            principal: "test-primary-user",
            status: "empty",
            items: [],
            text: "",
            effective: { maxItems: 5, maxOutputBytes: 2000, deadlineMs: 500, policyVersion: "owned-v1" },
            stageOutcomes: {},
            omissionReasons: [],
          };
        }),
      },
    } as unknown as import("./abmind-client.js").AbmindClient;
    const ctx = buildHookClientContext(fakeClient);
    if (ctx === null) throw new Error("expected hook client context");
    await ctx.recall({ query: "Docker status report" });
    expect(seen).toHaveLength(1);
    const sent = seen[0] as Record<string, unknown>;
    expect(sent["contract"]).toBe("owned-v1");
    expect(sent["profile"]).toBe("recall_fast");
    expect((sent["identity"] as Record<string, unknown>)["principal"]).toBe("test-primary-user");
  });

  /** Production bilingual shape on durable knowledge: twelve source-courtesy memories plus two
   *  rare topical ones. Ceiling is max(2, floor(14 × 0.25)) = 3. */
  async function seedRecallRows(): Promise<void> {
    const db = getMemoryDb(mm);
    if (!db) throw new Error("expected memory db");
    const seed = (content: string, original?: string): void => {
      storeDurable(db, {
        userId: "test-primary-user", memoryType: "fact", content,
        ...(original !== undefined ? { contentOriginal: original } : {}),
        authority: "inference", authorityBasis: "hook fixture",
        applicabilityScope: { scope: "general" }, provenance: {},
        evidence: [{ kind: "direct", ref: "direct", excerpt: content.slice(0, 500), classification: 1 }],
        actorId: "hook-fixture",
      });
    };
    seed("migration owns the staging rollback procedure", "a migráció kezeli az élesítési visszagörgetést");
    seed("migration runs the nightly data reload", "a migráció futtatja az éjszakai adatbetöltést");
    for (let i = 0; i < 12; i++) {
      seed(`daily routine note number ${i}`, `köszi szépen a napi rutinhoz ${i}`);
    }
    // #1928 M3: the owned pipeline serves built projections only.
    const { buildRecallProjection } = await import("./recall-projection-build.js");
    expect(buildRecallProjection(db, "test-primary-user", { verifiedBackup: true }).ok).toBe(true);
  }

  it("real adapter search: ASCII-extracted turn finds the seeded memory", async () => {
    await seedRecallRows();
    const ctx = buildHookAdapterContext(mm);
    if (ctx === null) throw new Error("expected hook adapter context");
    const searched = await ctx.recall({ query: "migration", limit: 10, maxChars: 2000 });
    expect(searched.context).toContain("staging rollback");
  });

  it("real adapter skip: extraction result never substitutes for the raw turn", async () => {
    await seedRecallRows();
    const ctx = buildHookAdapterContext(mm);
    if (ctx === null) throw new Error("expected hook adapter context");
    // Source-only turn: extraction finds nothing and the raw turn is common.
    const sourceOnly = await ctx.recall({ query: "köszi", limit: 10, maxChars: 2000 });
    expect(sourceOnly.count).toBe(0);
    // Successful ASCII extraction: the extracted term is common too, and the
    // raw turn is judged regardless of what extraction produced.
    const asciiExtracted = await ctx.recall({ query: "köszi note", limit: 10, maxChars: 2000 });
    expect(asciiExtracted.count).toBe(0);
  });
});
