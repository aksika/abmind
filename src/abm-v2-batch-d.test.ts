import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { buildWakeUp } from "./wake-up-builder.js";

describe("wake-up-builder", () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(async () => {
    process.env.ABMIND_USER_ID = "user-1";
    tmpDir = mkdtempSync(join(tmpdir(), "abm-wakeup-"));
    process.env["ABMIND_HOME"] = tmpDir;
    mm = new MemoryManager(makeMemoryTestConfig(join(tmpDir, "memory")));
    await mm.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm.close();
    delete process.env["ABMIND_HOME"];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty for null db", () => {
    expect(buildWakeUp(null, "user-1")).toBe("");
  });

  it("includes current time", () => {
    const result = buildWakeUp(getMemoryDb(mm)!, "user-1");
    expect(result).toContain("[Current time:");
  });

  it("includes flashback when emotional memories exist", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const result = buildWakeUp(getMemoryDb(mm)!, "user-1");
    expect(result).toContain("[Flashback]");
  });

  it("no flashback when no emotional memories", () => {
    const result = buildWakeUp(getMemoryDb(mm)!, "user-1");
    expect(result).not.toContain("[Flashback]");
    expect(result).toContain("[Current time:");
  });

  it("obeys strict maxChars bound with emotional memory via direct builder", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const small = buildWakeUp(getMemoryDb(mm)!, "user-1", 10);
    expect(small.length).toBeLessThanOrEqual(10);
  });

  it("obeys strict maxChars bound via MemoryManager", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const small = mm.buildWakeUp("user-1", 10);
    expect(small.length).toBeLessThanOrEqual(10);
  });

  it("large budget retains flashback", async () => {
    await mm.editor.instantStore({
      userId: "user-1", contentEn: "Amazing breakthrough on the project",
      contentOriginal: "test", memoryType: "event", emotionScore: 4, topic: "coding",
    });

    const large = mm.buildWakeUp("user-1", 2000);
    expect(large.length).toBeLessThanOrEqual(2000);
    expect(large).toContain("[Flashback]");
  });

  it("returns empty for zero budget", () => {
    const result = buildWakeUp(getMemoryDb(mm)!, "user-1", 0);
    expect(result).toBe("");
  });

  it("returns empty for negative budget", () => {
    const result = buildWakeUp(getMemoryDb(mm)!, "user-1", -1);
    expect(result).toBe("");
  });
});

describe("#1658 session-start wake-up — strict owner", () => {
  let mm2: MemoryManager;
  let tmpDir2: string;

  beforeEach(async () => {
    tmpDir2 = mkdtempSync(join(tmpdir(), "abm-wakeup-owner-"));
    process.env.ABMIND_USER_ID = "user-1";
    mm2 = new MemoryManager(makeMemoryTestConfig(join(tmpDir2, "memory")));
    await mm2.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    mm2.close();
    rmSync(tmpDir2, { recursive: true, force: true });
  });

  it("includes an owned emotional memory and excludes a foreign one", async () => {
    await mm2.editor.instantStore({
      userId: "user-1", contentEn: "owned emotional milestone", contentOriginal: "x",
      memoryType: "event", emotionScore: 5, topic: "coding",
    });
    const db = getMemoryDb(mm2)!;
    db.prepare(
      `INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score)
       VALUES ('foreign', 'foreign flashback', 'foreign emotional memory', 'event', ?, ?, 5)`,
    ).run(Date.now(), Date.now());

    const result = mm2.buildWakeUp("user-1", 5000);
    expect(result).toContain("owned emotional milestone");
    expect(result).not.toContain("foreign emotional memory");
  });
});
