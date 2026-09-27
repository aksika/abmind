/**
 * #1869 — core injection repair and test-mode session context.
 *
 * Protection: the assembled context must carry each core part exactly once
 * through one addressable contract (additive `parts` alongside the legacy
 * fields), and under MEMORY_TEST=ON it must contain no memory-derived
 * content — asserted against the assembled OUTPUT, never the env setting,
 * so a future injection path that ignores the flag fails these tests.
 * A fact that exists only in the database must still be retrievable under
 * the flag: that is the genuine end-to-end retrieval proof (non-vacuous
 * probes). Operator readers (/facts) stay truthful under the flag.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { _resetAbmindEnv } from "./env-schema.js";
import {
  dispatchAssembleSessionContext,
  dispatchGetCoreKnowledge,
  dispatchGetRuntimeStatus,
} from "./abmind-memory-dispatch.js";
import { buildWakeUp } from "./wake-up-builder.js";
import { joinCoreParts } from "./core-composition.js";

const USER = "test-user";
const MARK = {
  soul: "COREPROBE-SOUL-1869",
  profile: "COREPROBE-PROFILE-1869",
  notes: "COREPROBE-NOTES-1869",
  tools: "COREPROBE-TOOLS-1869",
  facts: "COREPROBE-FACTS-1869",
  daily: "COREPROBE-DAILY-1869",
  weekly: "COREPROBE-WEEKLY-1869",
  quarterly: "COREPROBE-QUARTERLY-1869",
  recent: "COREPROBE-RECENT-1869",
  flashback: "COREPROBE-FLASHBACK-1869",
  dbFact: "COREPROBE-DBONLY-1869",
} as const;
const MEMORY_MARKERS = [MARK.soul, MARK.profile, MARK.notes, MARK.facts, MARK.daily, MARK.weekly, MARK.quarterly, MARK.recent, MARK.flashback] as const;

function writeCoreFiles(dir: string): void {
  const core = join(dir, "core");
  mkdirSync(core, { recursive: true });
  writeFileSync(join(core, "SOUL.md"), `# Soul\n\n${MARK.soul}`, "utf-8");
  writeFileSync(join(core, "user_profile.md"), `# Profile\n\n${MARK.profile}`, "utf-8");
  writeFileSync(join(core, "agent_notes.md"), `# Notes\n\n${MARK.notes}`, "utf-8");
  writeFileSync(join(core, "memory-tools.md"), `# Tools\n\n${MARK.tools}`, "utf-8");
  writeFileSync(join(core, "core_facts.md"), `# Facts\n\n${MARK.facts}`, "utf-8");
}

function writeConsolidations(dir: string): void {
  const today = new Date().toISOString().slice(0, 10);
  mkdirSync(join(dir, "daily"), { recursive: true });
  writeFileSync(join(dir, "daily", `daily_${today}.md`), `# Daily\n\n${MARK.daily}`, "utf-8");
  mkdirSync(join(dir, "weekly"), { recursive: true });
  writeFileSync(join(dir, "weekly", "weekly_probe.md"), `# Weekly\n\n${MARK.weekly}`, "utf-8");
  mkdirSync(join(dir, "quarterly"), { recursive: true });
  writeFileSync(join(dir, "quarterly", "quarterly_probe.md"), `# Quarterly\n\n${MARK.quarterly}`, "utf-8");
}

function insertPair(manager: MemoryManager, userContent: string, timestamp: number): void {
  const db = getMemoryDb(manager)!;
  db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'user', ?, ?)",
  ).run(USER, userContent, timestamp);
  db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'assistant', ?, ?)",
  ).run(USER, `reply to ${userContent}`, timestamp + 500);
}

function insertDbFact(manager: MemoryManager, contentEn: string, emotionScore: number): void {
  const db = getMemoryDb(manager)!;
  const now = Date.now();
  db.prepare(
    `INSERT INTO extracted_memories
       (user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        preserve_original, preserved_keyword, emotion_score, classification, trust, credibility, integrity)
     VALUES (?, ?, ?, 'fact', ?, ?, 0, NULL, ?, 1, 2, 3, 2)`,
  ).run(USER, contentEn, contentEn, now, now, emotionScore);
}

function setMemoryTest(on: boolean): void {
  if (on) process.env["MEMORY_TEST"] = "ON";
  else delete process.env["MEMORY_TEST"];
  _resetAbmindEnv();
}

describe("#1869 core injection contract and test mode", () => {
  let tmpDir: string;
  let manager: MemoryManager;
  let savedAbmindUserId: string | undefined;

  beforeEach(async () => {
    savedAbmindUserId = process.env["ABMIND_USER_ID"];
    delete process.env["ABMIND_USER_ID"];
    setMemoryTest(false);
    tmpDir = mkdtempSync(join(tmpdir(), "core-1869-"));
    writeCoreFiles(tmpDir);
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (savedAbmindUserId === undefined) delete process.env["ABMIND_USER_ID"];
    else process.env["ABMIND_USER_ID"] = savedAbmindUserId;
    setMemoryTest(false);
  });

  it("adds an addressable parts map with content identical to the legacy soulBundle", () => {
    const out = dispatchAssembleSessionContext(manager, { userId: USER });
    expect(out.parts).toEqual(out.soulBundle);
    expect(out.parts).toEqual({
      soul: expect.stringContaining(MARK.soul),
      profile: expect.stringContaining(MARK.profile),
      notes: expect.stringContaining(MARK.notes),
      memoryTools: expect.stringContaining(MARK.tools),
      coreFacts: expect.stringContaining(MARK.facts),
    });
    // Legacy fields unchanged: same parts, same content as before.
    expect(out.coreKnowledge).toContain(MARK.profile);
    expect(out.coreKnowledge).toContain(MARK.notes);
  });

  it("every harness composition shares the single part set (parity source)", () => {
    const parts = manager.getSessionParts();
    const text = joinCoreParts(parts);
    for (const marker of [MARK.soul, MARK.profile, MARK.notes, MARK.tools, MARK.facts]) {
      expect(text).toContain(marker);
    }
    expect(dispatchAssembleSessionContext(manager, { userId: USER }).parts).toEqual(parts);
  });

  it("a knowledge-file change after boot is visible to the next assembly without a restart", () => {
    const before = dispatchAssembleSessionContext(manager, { userId: USER });
    expect(before.parts?.profile).toContain(MARK.profile);
    // A nightly sleep rewrites the file; the next session-start assembly
    // reads it fresh — no cached copy, no rebuild trigger.
    writeFileSync(join(tmpDir, "core", "user_profile.md"), `# Profile\n\nCOREPROBE-PROFILE-ROTATED`, "utf-8");
    const after = dispatchAssembleSessionContext(manager, { userId: USER });
    expect(after.parts?.profile).toContain("COREPROBE-PROFILE-ROTATED");
    expect(after.parts?.profile).not.toContain(MARK.profile);
  });

  it("MEMORY_TEST=ON removes all memory-derived content from the assembled output", () => {
    writeConsolidations(tmpDir);
    insertPair(manager, MARK.recent, Date.now() - 1000);
    insertDbFact(manager, MARK.flashback, 5);
    setMemoryTest(true);

    const out = dispatchAssembleSessionContext(manager, { userId: USER });
    const dumped = JSON.stringify(out);
    // Asserted against the assembled result, not the env setting: any future
    // injection path that ignores the flag fails here instead of leaking.
    for (const marker of MEMORY_MARKERS) {
      expect(dumped).not.toContain(marker);
    }
    expect(out.recall).toBe("");
    expect(out.coreKnowledge).toBe("");
    expect(out.soulBundle).toEqual({ soul: "", profile: "", notes: "", memoryTools: expect.stringContaining(MARK.tools), coreFacts: "" });
    expect(out.parts).toEqual(out.soulBundle);
    // The wakeUp time line stays (computed, not recalled); the flashback is gone.
    expect(out.wakeUp).toContain("Current time");
    expect(out.wakeUp).not.toContain("[Flashback]");
  });

  it("drives skipDailies/skipMessages from the mode and composes with the non-primary rule", () => {
    writeConsolidations(tmpDir);
    insertPair(manager, MARK.recent, Date.now() - 1000);
    // Non-primary users keep their existing suppression without the flag.
    process.env["ABMIND_USER_ID"] = "someone-else";
    const nonPrimary = dispatchAssembleSessionContext(manager, { userId: USER });
    expect(nonPrimary.recall).not.toContain(MARK.daily);
    // Primary user under the flag is suppressed through the same options.
    delete process.env["ABMIND_USER_ID"];
    setMemoryTest(true);
    const suppressed = dispatchAssembleSessionContext(manager, { userId: USER });
    expect(suppressed.recall).toBe("");
  });

  it("operator /facts stays truthful under the flag", () => {
    setMemoryTest(true);
    const facts = dispatchGetCoreKnowledge(manager);
    expect(facts).toContain(MARK.profile);
    expect(facts).toContain(MARK.notes);
  });

  it("a database-only fact is still retrieved under the flag (non-vacuous proof)", async () => {
    insertDbFact(manager, `The bridge mascot is ${MARK.dbFact}.`, 0);
    setMemoryTest(true);

    const out = dispatchAssembleSessionContext(manager, { userId: USER });
    expect(JSON.stringify(out)).not.toContain(MARK.dbFact);

    const recall = await manager.recallSearch({ translated: [MARK.dbFact], userId: USER, limit: 5 });
    expect(recall.results.some((r) => r.content.includes(MARK.dbFact))).toBe(true);
  });

  it("runtime status reports the active mode", () => {
    expect(dispatchGetRuntimeStatus(manager, {})).toMatchObject({ memoryTest: false });
    setMemoryTest(true);
    expect(dispatchGetRuntimeStatus(manager, {})).toMatchObject({ memoryTest: true });
  });

  it("suppressFlashback keeps the time line and drops the flashback", () => {
    insertDbFact(manager, MARK.flashback, 5);
    const db = getMemoryDb(manager)!;
    const full = buildWakeUp(db, USER);
    expect(full).toContain("[Flashback]");
    expect(full).toContain(MARK.flashback);
    const suppressed = buildWakeUp(db, USER, undefined, { suppressFlashback: true });
    expect(suppressed).toContain("Current time");
    expect(suppressed).not.toContain("[Flashback]");
    expect(suppressed).not.toContain(MARK.flashback);
  });
});
