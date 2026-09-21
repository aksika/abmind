import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  estimateTokens, chunkMessages,
  utcDayLabel, dailyWriteFilename, parseDailyWrittenAt, parseLegacyDailyDay,
  parseLegacyDailyWriteTs, formatDailyHeading, parseDailyHeading,
  buildDailySummary, writeDailyFile,
} from "./sleep-daily-summary.js";

describe("estimateTokens", () => {
  it("estimates ~4 chars per token", () => {
    expect(estimateTokens("hello")).toBe(2);
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("chunkMessages", () => {
  const makeMsg = (content: string, id = 1) => ({
    id, role: "user", content, timestamp: Date.now(),
  });

  it("returns single batch when all fit", () => {
    const msgs = [makeMsg("hello"), makeMsg("world")];
    const batches = chunkMessages(msgs, 10000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
  });

  it("splits into multiple batches when over budget", () => {
    // Realistic messages with spaces/punctuation (not stripped as binary)
    const text = "The user asked about deploying the new version to production. We discussed the rollback strategy and decided to use blue-green deployment.";
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg(text.repeat(3), i));
    // Each msg: ~420 chars = ~105 tokens * 1.2 = ~126. Budget 200 → ~1-2 per batch
    const batches = chunkMessages(msgs, 200);
    expect(batches.length).toBeGreaterThan(1);
    const total = batches.reduce((sum, b) => sum + b.length, 0);
    expect(total).toBe(10);
  });

  it("returns empty array for no messages", () => {
    expect(chunkMessages([], 10000)).toEqual([]);
  });
});

describe("#1821 daily filename/heading codec", () => {
  it("round-trips single-day and range headings", () => {
    expect(formatDailyHeading("2026-09-19", "2026-09-19")).toBe("# Daily Summary 2026-09-19");
    expect(formatDailyHeading("2026-09-19", "2026-09-20")).toBe("# Daily Summary 2026-09-19 — 2026-09-20");
    expect(parseDailyHeading("# Daily Summary 2026-09-19")).toEqual({ startDay: "2026-09-19", endDay: "2026-09-19" });
    expect(parseDailyHeading("# Daily Summary 2026-09-19 — 2026-09-20")).toEqual({ startDay: "2026-09-19", endDay: "2026-09-20" });
  });

  it("rejects dateless, reversed, and out-of-range headings", () => {
    expect(parseDailyHeading("# Daily Summary")).toBeNull();
    expect(parseDailyHeading("# Daily Summary 2026-09-20 — 2026-09-19")).toBeNull();
    expect(parseDailyHeading("# Daily Summary 2026-13-01")).toBeNull();
    expect(parseDailyHeading("# Daily Summary 2026-09-99")).toBeNull();
    expect(parseDailyHeading("something else")).toBeNull();
  });

  it("names files by UTC write instant with a Z suffix", () => {
    const now = Date.UTC(2026, 8, 21, 0, 2);
    expect(dailyWriteFilename(now)).toBe("daily_2026-09-21-0002Z.md");
    expect(utcDayLabel(now)).toBe("2026-09-21");
    expect(parseDailyWrittenAt("daily_2026-09-21-0002Z.md")).toBe(now);
  });

  it("parses write stamps; rejects legacy and malformed names", () => {
    expect(parseDailyWrittenAt("daily_2026-09-21-0002Z.md")).toBe(Date.UTC(2026, 8, 21, 0, 2));
    expect(parseDailyWrittenAt("daily_2026-09-21-2359Z.md")).toBe(Date.UTC(2026, 8, 21, 23, 59));
    expect(parseDailyWrittenAt("daily_2026-09-21.md")).toBeNull();
    expect(parseDailyWrittenAt("daily_2026-09-21-0002.md")).toBeNull();
    expect(parseDailyWrittenAt("daily_2026-09-21-2500Z.md")).toBeNull();
    expect(parseDailyWrittenAt("daily_2026-13-01-0000Z.md")).toBeNull();
    expect(parseLegacyDailyDay("daily_2026-09-19.md")).toBe("2026-09-19");
    expect(parseLegacyDailyDay("daily_2026-09-21-0002Z.md")).toBeNull();
    expect(parseLegacyDailyWriteTs("daily_2026-09-19.md")).toBe(Date.UTC(2026, 8, 19));
  });

  it("rejects impossible calendar days instead of producing NaN stamps", () => {
    expect(parseLegacyDailyDay("daily_2026-13-01.md")).toBeNull();
    expect(parseLegacyDailyDay("daily_2026-02-30.md")).toBeNull();
    expect(parseLegacyDailyWriteTs("daily_2026-02-30.md")).toBeNull();
    expect(parseDailyHeading("# Daily Summary 2026-02-30 — 2026-03-01")).toBeNull();
  });
});

describe("#1821 writeDailyFile", () => {
  let dir: string;
  const NOW = Date.UTC(2026, 8, 21, 0, 2);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daily-write-"));
    mkdirSync(join(dir, "daily"), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function dailyDir(): string[] {
    return readdirSync(join(dir, "daily")).sort();
  }

  it("writes a timestamped file with the covered single-day heading", () => {
    const path = writeDailyFile(dir, Date.UTC(2026, 8, 19, 12, 0), Date.UTC(2026, 8, 19, 23, 0), "body", NOW);
    expect(path).toBe(join(dir, "daily", "daily_2026-09-21-0002Z.md"));
    const lines = readFileSync(path, "utf-8").split("\n");
    expect(lines[0]).toBe("# Daily Summary 2026-09-19");
  });

  it("writes a range heading when the window spans days", () => {
    const path = writeDailyFile(dir, Date.UTC(2026, 8, 19, 12, 0), Date.UTC(2026, 8, 20, 15, 30), "body", NOW);
    const lines = readFileSync(path, "utf-8").split("\n");
    expect(lines[0]).toBe("# Daily Summary 2026-09-19 — 2026-09-20");
  });

  it("deletes only contained earlier files, never itself", () => {
    writeFileSync(join(dir, "daily", "x.md"), "x");
    const contained = join(dir, "daily", "daily_2026-09-18.md");
    writeFileSync(contained, "# Daily Summary 2026-09-18\n\nold");
    const outside = join(dir, "daily", "daily_2026-09-20.md");
    writeFileSync(outside, "# Daily Summary 2026-09-20\n\nnewer");
    const path = writeDailyFile(dir, Date.UTC(2026, 8, 17, 1, 0), Date.UTC(2026, 8, 19, 23, 0), "body", NOW);
    expect(dailyDir()).toEqual(["daily_2026-09-20.md", "daily_2026-09-21-0002Z.md", "x.md"].sort());
    expect(path).toBe(join(dir, "daily", "daily_2026-09-21-0002Z.md"));
  });

  it("keeps partial-overlap files, unparseable headings, and non-daily files", () => {
    const partial = join(dir, "daily", "daily_2026-09-19.md");
    writeFileSync(partial, "# Daily Summary 2026-09-19 — 2026-09-25\n\nwider");
    const junk = join(dir, "daily", "daily_notes.md");
    writeFileSync(junk, "no heading here");
    const weekly = join(dir, "daily", "weekly_2026-09-18.md");
    writeFileSync(weekly, "# Weekly\n\nstuff");
    writeDailyFile(dir, Date.UTC(2026, 8, 19, 0, 0), Date.UTC(2026, 8, 20, 0, 0), "body", NOW);
    expect(dailyDir()).toContain("daily_2026-09-19.md");
    expect(dailyDir()).toContain("daily_notes.md");
    expect(dailyDir()).toContain("weekly_2026-09-18.md");
  });

  it("deletes a same-window file (retry idempotence)", () => {
    writeFileSync(join(dir, "daily", "daily_2026-09-19.md"), "# Daily Summary 2026-09-19\n\npartial");
    const again = writeDailyFile(dir, Date.UTC(2026, 8, 19, 0, 0), Date.UTC(2026, 8, 19, 23, 59), "retry", NOW);
    expect(dailyDir()).toEqual(["daily_2026-09-21-0002Z.md"]);
    expect(again).toBe(join(dir, "daily", "daily_2026-09-21-0002Z.md"));
  });

  it("throws on non-finite timestamps instead of writing garbage names", () => {
    expect(() => writeDailyFile(dir, Number.NaN, Date.now(), "body")).toThrow();
  });
});

describe("#1821 buildDailySummary window", () => {
  let db: Database.Database;
  let memDir: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(
      "CREATE TABLE messages (id INTEGER PRIMARY KEY, user_id TEXT, session_id TEXT, role TEXT, content TEXT, timestamp INTEGER)"
    );
    memDir = mkdtempSync(join(tmpdir(), "daily-build-"));
  });

  afterEach(() => {
    db.close();
    rmSync(memDir, { recursive: true, force: true });
  });

  function seed(id: number, ts: number, content = "hello world from the user today"): void {
    db.prepare("INSERT INTO messages (id, user_id, session_id, role, content, timestamp) VALUES (?,?,?,?,?,?)")
      .run(id, "u1", "main", "user", content, ts);
  }

  it("returns the first/last summarized message timestamps", async () => {
    const t1 = Date.UTC(2026, 8, 19, 12, 0);
    const t2 = Date.UTC(2026, 8, 20, 15, 30);
    seed(1, t2, "later message with enough words to summarize");
    seed(2, t1, "earlier message with enough words to summarize");
    const result = await buildDailySummary(db, async () => "canned summary", {
      ctxWindow: 128000, memoryDir: memDir, userId: "u1", watermarkTs: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.startTs).toBe(t1);
    expect(result!.endTs).toBe(t2);
    expect(result!.summary).toContain("canned summary");
  });

  it("returns null with no messages (skip, no write)", async () => {
    const result = await buildDailySummary(db, async () => "never used", {
      ctxWindow: 128000, memoryDir: memDir, userId: "u1", watermarkTs: 0,
    });
    expect(result).toBeNull();
  });

  it("window spans only the batches that contributed", async () => {
    const tA = Date.UTC(2026, 8, 19, 10, 0);
    const tB = Date.UTC(2026, 8, 20, 10, 0);
    // Force batching (one message per batch) and exceed the single-shot ratio.
    const bigA = `AAAA ${"alpha ".repeat(2400)}`;
    const bigB = `BBBB ${"beta ".repeat(2400)}`;
    seed(1, tA, bigA);
    seed(2, tB, bigB);
    const result = await buildDailySummary(db, async (prompt) => {
      if (prompt.includes("AAAA")) return "summary for the first batch";
      throw new Error("provider down for the second batch");
    }, {
      ctxWindow: 10000, memoryDir: memDir, userId: "u1", watermarkTs: 0,
    });
    expect(result).not.toBeNull();
    expect(result!.startTs).toBe(tA);
    expect(result!.endTs).toBe(tA);
  });
});
