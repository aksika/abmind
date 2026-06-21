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

  it("enrichment fills backward (older pairs) with consolidation interleave", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      insertMessage(manager, "user", `msg-${i}`, now - (20 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i}`, now - (20 - i) * 2000 + 500);
    }
    // Provide dailies + weeklies so enrichment loop can run
    const today = new Date();
    for (let d = 0; d < 7; d++) {
      const date = new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10);
      writeDaily(tmpDir, date, `Daily summary for ${date}`);
    }
    const weeklyDir = join(tmpDir, "weekly");
    mkdirSync(weeklyDir, { recursive: true });
    writeFileSync(join(weeklyDir, "weekly_2026-W25.md"), "Weekly summary W25");
    writeFileSync(join(weeklyDir, "weekly_2026-W24.md"), "Weekly summary W24");

    // Large budget = enrichment adds older pairs interleaved with consolidations
    const result = buildSessionStartContext(manager, 1, 1000000).text!;

    // Newest (floor) present
    expect(result).toContain("msg-19");
    expect(result).toContain("msg-12");
    // Enrichment pulled in older pairs
    expect(result).toContain("msg-5");
    // Consolidation files present
    expect(result).toContain("Daily summary");
    expect(result).toContain("Weekly summary");
  });

  it("stops enrichment when consolidation sources exhaust (#1107)", () => {
    const now = Date.now();
    for (let i = 0; i < 40; i++) {
      insertMessage(manager, "user", `msg-${i}`, now - (40 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i}`, now - (40 - i) * 2000 + 500);
    }
    // Only 1 daily, no weeklies, no quarterlies → enrichment stops after 1 round
    const today = new Date().toISOString().slice(0, 10);
    writeDaily(tmpDir, today, "Only daily");

    const result = buildSessionStartContext(manager, 1, 1000000).text!;
    const stats = buildSessionStartContext(manager, 1, 1000000).stats;

    // Floor = 8 pairs. Enrichment: round 0 (daily slot) → dailyCursor=1 exhausted → fallback all exhausted → stop.
    // So total = 8 floor + 1 enriched = 9 pairs max
    expect(stats.messages).toBeLessThanOrEqual(10);
    // Should NOT have all 40 pairs (the old greedy bug)
    expect(stats.messages).toBeLessThan(20);
    expect(result).not.toContain("msg-0");
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
