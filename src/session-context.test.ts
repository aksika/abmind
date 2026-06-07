import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { buildSessionStartContext } from "./session-context.js";

function insertMessage(manager: MemoryManager, role: string, content: string, timestamp: number): void {
  const db = manager.getDb()!;
  db.prepare(
    "INSERT INTO messages (role, content, timestamp, user_id, session_id) VALUES (?, ?, ?, 1, 's1')"
  ).run(role, content, timestamp);
}

function writeDaily(dir: string, date: string, content: string): void {
  const dailyDir = join(dir, "daily");
  mkdirSync(dailyDir, { recursive: true });
  writeFileSync(join(dailyDir, `daily_${date}.md`), content, "utf-8");
}

describe("buildSessionStartContext", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-ctx-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when DB is empty (no daily, no messages)", () => {
    expect(buildSessionStartContext(manager, 1).text).toBeNull();
  });

  it("returns daily summary in [PAST DAYS] section", () => {
    const dailyContent = "# Daily Summary\n\nDiscussed memory refactor.";
    const today = new Date().toISOString().slice(0, 10);
    writeDaily(tmpDir, today, dailyContent);

    const result = buildSessionStartContext(manager, 1).text;

    expect(result).not.toBeNull();
    expect(result).toContain("[PAST DAYS]");
    expect(result).toContain("Discussed memory refactor.");
    expect(result).toContain("[SESSION START —");
  });

  it("shows NEWEST messages in [RECENT] section", () => {
    const today = new Date().toISOString().slice(0, 10);
    writeDaily(tmpDir, today, "# Old daily");

    const now = Date.now();
    // Insert 12 pairs — only newest 8 should be in floor
    for (let i = 0; i < 12; i++) {
      insertMessage(manager, "user", `msg-${i}`, now - (12 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i}`, now - (12 - i) * 2000 + 500);
    }

    const result = buildSessionStartContext(manager, 1).text!;

    expect(result).toContain("[RECENT — last session, ended");
    expect(result).toContain("msg-11");
    expect(result).toContain("msg-10");
    expect(result).toContain("msg-4"); // floor = last 8 pairs
  });

  it("ended timestamp uses newest message, not oldest", () => {
    const now = Date.now();
    insertMessage(manager, "user", "old message", now - 60000);
    insertMessage(manager, "assistant", "old reply", now - 59500);
    insertMessage(manager, "user", "new message", now - 1000);
    insertMessage(manager, "assistant", "new reply", now - 500);

    const result = buildSessionStartContext(manager, 1).text!;

    expect(result).toContain("[RECENT — last session, ended");
    expect(result).toContain("new message");
  });

  it("enrichment fills backward (older pairs) within budget", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      insertMessage(manager, "user", `msg-${i}`, now - (20 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i}`, now - (20 - i) * 2000 + 500);
    }

    // Large context = large budget = enrichment should pull in older pairs
    const result = buildSessionStartContext(manager, 1, 1000000).text!;

    expect(result).toContain("msg-0");
    expect(result).toContain("msg-19");
  });

  it("respects budget — small context window limits messages", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      insertMessage(manager, "user", `msg-${i} ${"x".repeat(300)}`, now - (20 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i} ${"y".repeat(300)}`, now - (20 - i) * 2000 + 500);
    }

    // 128K context = 5% = 6400B budget. Each pair ~560 chars (300+head200+cut+tail50).
    // Floor 8 pairs ~4.5KB. Enrichment adds a few more but NOT all 20.
    const result = buildSessionStartContext(manager, 1, 128000).text!;

    // Newest floor pairs present
    expect(result).toContain("msg-19");
    expect(result).toContain("msg-12");
    // Oldest should NOT fit
    expect(result).not.toContain("msg-0 ");
    expect(result).not.toContain("msg-1 ");
  });

  it("wraps output in temporal markers", () => {
    const now = Date.now();
    insertMessage(manager, "user", "test message", now - 1000);
    insertMessage(manager, "assistant", "test reply", now - 500);

    const result = buildSessionStartContext(manager, 1).text!;

    expect(result).toContain("[RECENT — last session, ended");
    expect(result).toContain("[SESSION START —");
  });
});
