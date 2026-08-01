import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { buildSessionStartContext } from "./session-context.js";

function insertMessage(manager: MemoryManager, role: string, content: string, timestamp: number): void {
  const db = getMemoryDb(manager)!;
  db.prepare(
    "INSERT INTO messages (role, content, timestamp, user_id, session_id) VALUES (?, ?, ?, '1', 's1')"
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
    expect(buildSessionStartContext(manager, "1").text).toBeNull();
  });

  it("returns daily summary in [PAST DAYS] section", () => {
    const dailyContent = "# Daily Summary\n\nDiscussed memory refactor.";
    const today = new Date().toISOString().slice(0, 10);
    writeDaily(tmpDir, today, dailyContent);

    const result = buildSessionStartContext(manager, "1").text;

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

    const result = buildSessionStartContext(manager, "1").text!;

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

    const result = buildSessionStartContext(manager, "1").text!;

    expect(result).toContain("[RECENT — last session, ended");
    expect(result).toContain("new message");
  });

  it("enrichment fills backward (older pairs) with consolidation interleave", () => {
    // #1321: use a fixed "now" a few hours after UTC midnight of the newest daily's
    // date, so the freshness guard (24h window) deterministically keeps it fresh
    // regardless of wall-clock time when the test runs.
    const today = new Date("2026-07-11T06:00:00Z");
    const now = today.getTime();
    for (let i = 0; i < 20; i++) {
      insertMessage(manager, "user", `msg-${i}`, now - (20 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i}`, now - (20 - i) * 2000 + 500);
    }
    // Provide dailies + weeklies so enrichment loop can run
    for (let d = 0; d < 7; d++) {
      const date = new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10);
      writeDaily(tmpDir, date, `Daily summary for ${date}`);
    }
    const weeklyDir = join(tmpDir, "weekly");
    mkdirSync(weeklyDir, { recursive: true });
    writeFileSync(join(weeklyDir, "weekly_2026-W25.md"), "Weekly summary W25");
    writeFileSync(join(weeklyDir, "weekly_2026-W24.md"), "Weekly summary W24");

    // Large budget = enrichment adds older pairs interleaved with consolidations
    const result = buildSessionStartContext(manager, "1", 1000000, { now }).text!;

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

    const result = buildSessionStartContext(manager, "1", 1000000).text!;
    const stats = buildSessionStartContext(manager, "1", 1000000).stats;

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
    const result = buildSessionStartContext(manager, "1", 128000).text!;

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

    const result = buildSessionStartContext(manager, "1").text!;

    expect(result).toContain("[RECENT — last session, ended");
    expect(result).toContain("[SESSION START —");
  });
});

/** #1321 — stale daily summary must not be presented as current session-start context. */
describe("buildSessionStartContext — stale daily freshness guard (#1321)", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-ctx-1321-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes a fresh daily (written today, <24h old) as current context", () => {
    const now = Date.parse("2026-07-11T12:00:00Z");
    writeDaily(tmpDir, "2026-07-11", "Fresh daily content");

    const result = buildSessionStartContext(manager, "1", undefined, { now }).text;

    expect(result).not.toBeNull();
    expect(result).toContain("[PAST DAYS]");
    expect(result).toContain("Fresh daily content");
  });

  it("omits a stale daily (>24h old) from current session-start context", () => {
    // Daily file date is parsed as UTC midnight. "now" is 2 days later — well past 24h.
    const now = Date.parse("2026-07-13T12:00:00Z");
    writeDaily(tmpDir, "2026-07-11", "Stale daily content");
    // Give the store some recent messages so the result isn't just null.
    insertMessage(manager, "user", "hi", now - 1000);
    insertMessage(manager, "assistant", "hello", now - 500);

    const result = buildSessionStartContext(manager, "1", undefined, { now }).text;

    expect(result).not.toBeNull();
    expect(result).not.toContain("Stale daily content");
    expect(result).not.toContain("[PAST DAYS]");
  });

  it("does not fabricate recent history when the only daily is stale and there are no messages", () => {
    const now = Date.parse("2026-07-13T12:00:00Z");
    writeDaily(tmpDir, "2026-07-11", "Stale daily content");

    const result = buildSessionStartContext(manager, "1", undefined, { now });

    // No fresh daily, no messages → nothing to present as current.
    expect(result.text).toBeNull();
    expect(result.stats.dailies).toBe(0);
  });

  it("keeps weekly/quarterly consolidations even when the newest daily is stale", () => {
    const now = Date.parse("2026-07-13T12:00:00Z");
    writeDaily(tmpDir, "2026-07-11", "Stale daily content");
    const weeklyDir = join(tmpDir, "weekly");
    mkdirSync(weeklyDir, { recursive: true });
    writeFileSync(join(weeklyDir, "weekly_2026-W27.md"), "Weekly summary W27");

    // Give the enrichment loop something to pull from (pairs + budget).
    for (let i = 0; i < 20; i++) {
      insertMessage(manager, "user", `msg-${i}`, now - (20 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i}`, now - (20 - i) * 2000 + 500);
    }

    const result = buildSessionStartContext(manager, "1", 1000000, { now }).text;

    expect(result).not.toBeNull();
    expect(result).toContain("Weekly summary W27");
    // The stale daily is not omitted outright — it may still surface via
    // enrichment under the historical [PAST DAYS] header, just never as the
    // "current" floor slot. Assert the historical framing, not its absence.
    expect(result).toContain("[PAST DAYS]");
  });

  it("timezone/day boundary — a daily exactly 23h old (UTC-midnight timestamp) is treated as fresh", () => {
    // Daily file for 2026-07-11 parses to 2026-07-11T00:00:00Z.
    // "now" = 2026-07-11T23:00:00Z is 23h after that — inside the 24h freshness window.
    const now = Date.parse("2026-07-11T23:00:00Z");
    writeDaily(tmpDir, "2026-07-11", "Fresh daily content");

    const result = buildSessionStartContext(manager, "1", undefined, { now }).text;

    expect(result).toContain("Fresh daily content");
  });

  it("timezone/day boundary — a daily exactly 25h old (UTC-midnight timestamp) is treated as stale", () => {
    const now = Date.parse("2026-07-12T01:00:00Z");
    writeDaily(tmpDir, "2026-07-11", "Stale daily content");
    insertMessage(manager, "user", "hi", now - 1000);
    insertMessage(manager, "assistant", "hello", now - 500);

    const result = buildSessionStartContext(manager, "1", undefined, { now }).text;

    expect(result).not.toContain("Stale daily content");
  });

  it("falls back to recent messages when the daily is stale but conversation history exists", () => {
    const now = Date.parse("2026-07-13T12:00:00Z");
    writeDaily(tmpDir, "2026-07-11", "Stale daily content");
    insertMessage(manager, "user", "recent question", now - 1000);
    insertMessage(manager, "assistant", "recent answer", now - 500);

    const result = buildSessionStartContext(manager, "1", undefined, { now }).text;

    expect(result).not.toBeNull();
    expect(result).not.toContain("Stale daily content");
    expect(result).toContain("recent question");
    expect(result).toContain("[RECENT — last session, ended");
  });
});

/** #1349 — REGRESSION: getRecentConversation bounded-window fix correctness. */
describe("buildSessionStartContext — recent-conversation bounded window (#1349)", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "session-ctx-1349-"));
    manager = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await manager.initialize();
    // Provide a daily so [PAST DAYS] doesn't block [RECENT]
    const today = new Date().toISOString().slice(0, 10);
    writeDaily(tmpDir, today, "# Daily");
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Insert a user→assistant pair with recognizable marker text. */
  function insertPair(marker: string, timestamp: number): void {
    insertMessage(manager, "user", `user-${marker}`, timestamp);
    insertMessage(manager, "assistant", `asst-${marker}`, timestamp + 500);
  }

  it("[RECENT] contains only the newest pairs when DB has far more than minPairs+50", () => {
    const now = Date.now();
    // Insert 100 pairs — far more than minPairs(8) + 50 = 58
    for (let i = 0; i < 100; i++) {
      insertPair(String(i).padStart(3, "0"), now - (100 - i) * 2000);
    }

    const result = buildSessionStartContext(manager, "1").text!;

    // The newest pair marker should be present
    expect(result).toContain("user-099");
    expect(result).toContain("asst-099");
    // The oldest pair marker (000) should be absent — outside the bounded window
    expect(result).not.toContain("user-000");
    expect(result).not.toContain("asst-000");
    // The [RECENT] block only contains newest messages
    expect(result).toContain("[RECENT — last session, ended");
  });

  it("ended timestamp comes from the newest included turn", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      insertPair(String(i), now - (10 - i) * 2000);
    }

    const result = buildSessionStartContext(manager, "1").text!;

    // ended timestamp should be close to `now` (the newest turn)
    expect(result).toContain("[RECENT — last session, ended");
    const tsMatch = result.match(/ended (.+?)\]/);
    expect(tsMatch).not.toBeNull();
  });

  it("[RECENT] output is chronological within the block", () => {
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      insertPair(String(i).padStart(2, "0"), now - (20 - i) * 2000);
    }

    const result = buildSessionStartContext(manager, "1").text!;
    const recentMatch = result.match(/\[RECENT[\s\S]*?\[SESSION START/);
    expect(recentMatch).not.toBeNull();

    const recentBlock = recentMatch![0]!;
    // Find user markers in order
    const markers = [...recentBlock.matchAll(/user-(\d+)/g)].map(m => parseInt(m[1], 10));
    for (let i = 1; i < markers.length; i++) {
      expect(markers[i]).toBeGreaterThan(markers[i - 1]);
    }
  });

  it("excludes pairs outside the bounded window", () => {
    const now = Date.now();
    // Insert 70 pairs — well beyond the query limit
    for (let i = 0; i < 70; i++) {
      insertPair(String(i).padStart(2, "0"), now - (70 - i) * 2000);
    }

    const result = buildSessionStartContext(manager, "1").text!;

    // Newest included
    expect(result).toContain("user-69");
    // Early pairs should not appear
    expect(result).not.toContain("user-00");
    expect(result).not.toContain("user-05");
  });

  it("minimum-pair and budget behavior still holds with bounded window", () => {
    const now = Date.now();
    // Insert 30 pairs — far more than minPairs, budget-enforced
    for (let i = 0; i < 30; i++) {
      insertMessage(manager, "user", `msg-${i}`, now - (30 - i) * 2000);
      insertMessage(manager, "assistant", `reply-${i}`, now - (30 - i) * 2000 + 500);
    }

    // Small context window → tight budget (5% of 64K = 3200)
    const stats = buildSessionStartContext(manager, "1", 64000).stats;

    // At least minPairs should be present
    expect(stats.messages).toBeGreaterThanOrEqual(8);
    // Should NOT contain all 30 pairs
    expect(stats.messages).toBeLessThan(30);
    // used bytes should not exceed budget (budget is soft cap from enrichment)
    expect(stats.usedBytes).toBeLessThanOrEqual(stats.budget);
  });

  it("handles an empty store gracefully (no messages at all)", () => {
    const result = buildSessionStartContext(manager, "1").text!;
    // Should still have [PAST DAYS] and [SESSION START]
    expect(result).toContain("[PAST DAYS]");
    expect(result).toContain("[SESSION START —");
    // No [RECENT] since there are no messages
    expect(result).not.toContain("[RECENT —");
  });
});
