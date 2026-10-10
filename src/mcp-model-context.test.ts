/**
 * mcp-model-context.test.ts — safe owner context projection (#1384).
 *
 * Proves the primary-owner boundary and MEMORY_TEST behavior of the new
 * private.modelContext dispatch: composition, authorization mapping,
 * history-free assembly, and strict input validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { dispatchModelContext } from "./abmind-memory-dispatch.js";
import { PrivateMutationError } from "./abmind-memory-dispatch.js";
import { validatePayload } from "./abmind-request-validation.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { _resetAbmindEnv } from "./env-schema.js";

const USER = "mcp-owner";
const FOREIGN = "mcp-foreign";

const MARK = {
  soul: "MODELCTX-SOUL-1",
  profile: "MODELCTX-PROFILE-1",
  notes: "MODELCTX-NOTES-1",
  tools: "MODELCTX-TOOLS-1",
  facts: "MODELCTX-FACTS-1",
  recent: "MODELCTX-RECENT-PAIR-1",
  flashback: "MODELCTX-FLASHBACK-1",
};

function writeCoreFiles(dir: string): void {
  const core = join(dir, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.md"), `# Soul\n\n${MARK.soul}`, "utf-8");
  writeFileSync(join(core, "user_profile.md"), `# Profile\n\n${MARK.profile}`, "utf-8");
  writeFileSync(join(core, "agent_notes.md"), `# Notes\n\n${MARK.notes}`, "utf-8");
  writeFileSync(join(core, "memory-tools.md"), `# Tools\n\n${MARK.tools}`, "utf-8");
  writeFileSync(join(core, "core_facts.md"), `# Facts\n\n${MARK.facts}`, "utf-8");
}

function insertPair(manager: MemoryManager, userContent: string): void {
  const db = getMemoryDb(manager)!;
  const now = Date.now();
  db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'user', ?, ?)",
  ).run(USER, userContent, now);
  db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'assistant', ?, ?)",
  ).run(USER, `reply to ${userContent}`, now + 500);
}

function insertFlashbackFact(manager: MemoryManager): void {
  const db = getMemoryDb(manager)!;
  const now = Date.now();
  db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, preserved_keyword, emotion_score, classification, trust, credibility, integrity)
     VALUES (?, ?, ?, 'event', ?, ?, 0, NULL, 5, 1, 2, 3, 2)`,
  ).run(USER, MARK.flashback, MARK.flashback, now, now);
}

function setMemoryTest(on: boolean): void {
  if (on) process.env["MEMORY_TEST"] = "ON";
  else delete process.env["MEMORY_TEST"];
  _resetAbmindEnv();
}

describe("private.modelContext owner projection", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  let savedUser: string | undefined;
  let savedHome: string | undefined;

  beforeEach(async () => {
    savedUser = process.env["ABMIND_USER_ID"];
    savedHome = process.env["ABMIND_HOME"];
    delete process.env["ABMIND_USER_ID"];
    // Isolate the manifest identity: the snapshot override below is the
    // authority, never ambient files.
    process.env["ABMIND_HOME"] = mkdtempSync(join(tmpdir(), "mcp-home-"));
    setMemoryTest(false);
    tmpDir = mkdtempSync(join(tmpdir(), "mcp-ctx-"));
    writeCoreFiles(tmpDir);
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir), { ownerSnapshot: USER });
    await manager.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(process.env["ABMIND_HOME"]!, { recursive: true, force: true });
    if (savedUser === undefined) delete process.env["ABMIND_USER_ID"];
    else process.env["ABMIND_USER_ID"] = savedUser;
    if (savedHome === undefined) delete process.env["ABMIND_HOME"];
    else process.env["ABMIND_HOME"] = savedHome;
    setMemoryTest(false);
  });

  it("composes wakeup plus each core part once, including core facts", () => {
    const out = dispatchModelContext(manager, { userId: USER });
    expect(out.memoryTest).toBe(false);
    for (const marker of [MARK.soul, MARK.profile, MARK.notes, MARK.tools, MARK.facts]) {
      expect(out.text).toContain(marker);
    }
    expect(out.text).toContain("Current time");
  });

  it("never hydrates conversation history", () => {
    insertPair(manager, MARK.recent);
    const out = dispatchModelContext(manager, { userId: USER });
    expect(out.text).not.toContain(MARK.recent);
    expect(out.text).not.toContain("reply to");
  });

  it("refuses a non-primary requester with permanent unauthorized", () => {
    try {
      dispatchModelContext(manager, { userId: FOREIGN });
      expect.unreachable("non-primary context must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PrivateMutationError);
      const body = (err as PrivateMutationError).errorBody;
      expect(body.code).toBe("unauthorized");
      expect(body.retryable).toBe(false);
      expect(body.message).toContain("non_primary_memory_owner");
    }
  });

  it("MEMORY_TEST suppresses memory-derived parts and flashback, keeps tools and time", () => {
    insertFlashbackFact(manager);
    const before = dispatchModelContext(manager, { userId: USER });
    expect(before.text).toContain("[Flashback]");
    setMemoryTest(true);
    const out = dispatchModelContext(manager, { userId: USER });
    expect(out.memoryTest).toBe(true);
    const dumped = out.text;
    for (const marker of [MARK.soul, MARK.profile, MARK.notes, MARK.facts, MARK.flashback]) {
      expect(dumped).not.toContain(marker);
    }
    expect(dumped).toContain(MARK.tools);
    expect(dumped).toContain("Current time");
    expect(dumped).not.toContain("[Flashback]");
  });

  it("maps a missing primary identity to unavailable, not unauthorized", async () => {
    const bareDir = mkdtempSync(join(tmpdir(), "mcp-ctx-bare-"));
    const bare = new MemoryManager(makeMemoryTestConfig(bareDir));
    await bare.initialize({ skipEmbeddingCheck: true });
    try {
      dispatchModelContext(bare, { userId: USER });
      expect.unreachable("missing primary identity must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PrivateMutationError);
      const body = (err as PrivateMutationError).errorBody;
      expect(body.code).toBe("unavailable");
      expect(body.retryable).toBe(true);
      expect(body.message).toContain("primary_identity_missing");
    } finally {
      bare.close();
      rmSync(bareDir, { recursive: true, force: true });
    }
  });

  it("rejects unknown input fields instead of ignoring them", () => {
    expect(validatePayload("private.modelContext", { userId: USER })).toBeNull();
    expect(validatePayload("private.modelContext", { userId: USER, includeHistory: true } as never))
      .toContain("unknown field");
    expect(validatePayload("private.modelContext", {} as never)).toContain("userId");
  });
});
