/**
 * #1863 acceptance §5: deterministic multi-principal journey over the real
 * preparation and publication path. Model output is fixtured (stub
 * sendPrompt); ownership selection, filesystem publication, and recall stay
 * real. Each test states the invariant it protects.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";
import { makeMemoryTestConfig } from "../test-helpers.js";
import { buildDailySummary, writeDailyFile, publishConsolidationFile, parseArtifactOwner } from "./sleep-daily-summary.js";
import { consolidationInputs } from "./step-prepare.js";
import { searchConsolidationFiles } from "../consolidation-search.js";
import { buildSessionStartContext } from "../session-context.js";
import { resolveOwnerSnapshot, PrimaryIdentityError } from "../user-utils.js";

const MASTER = "master-user";
const OTHER = "other-user";
const MASTER_TEXT = "master summit on tuesday decided the harbor route";
const OTHER_TEXT = "other picnic on friday planned the mountain menu";

describe("#1863 multi-principal ownership journey", () => {
  let root = "";
  let home = "";
  let memoryDir = "";
  let savedAbmindHome: string | undefined;
  let memory: MemoryManager;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "attribution-1863-"));
    home = join(root, "home");
    memoryDir = join(root, "memory");
    mkdirSync(home, { recursive: true });
    mkdirSync(memoryDir, { recursive: true });
    // Isolated home with a manifest identity — the owner's authority.
    writeFileSync(join(home, "manifest.json"), JSON.stringify({ encryptionUser: MASTER }));
    savedAbmindHome = process.env.ABMIND_HOME;
    process.env.ABMIND_HOME = home;

    memory = new MemoryManager({ ...makeMemoryTestConfig(memoryDir), memoryEnabled: true });
    await memory.initialize({ skipEmbeddingCheck: true });
    expect(memory.getOwnerSnapshot()).toBe(MASTER);

    const now = Date.now();
    memory.recordMessage({ role: "user", content: MASTER_TEXT, timestamp: now - 1000, userId: MASTER, sessionId: "s_A_1" });
    memory.recordMessage({ role: "user", content: OTHER_TEXT, timestamp: now - 500, userId: OTHER, sessionId: "s_A_2" });
  });

  afterEach(async () => {
    await memory.close();
    if (savedAbmindHome === undefined) delete process.env.ABMIND_HOME;
    else process.env.ABMIND_HOME = savedAbmindHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("master sleep input contains only master messages (owner-scoped preparation)", async () => {
    let seenPrompt = "";
    const result = await buildDailySummary(
      memory.getSleepData().getDb(),
      async (prompt: string) => { seenPrompt = prompt; return "fixtured summary"; },
      { ctxWindow: 128000, memoryDir, userId: MASTER, watermarkTs: 0 },
    );
    expect(result).not.toBeNull();
    expect(seenPrompt).toContain(MASTER_TEXT);
    expect(seenPrompt).not.toContain(OTHER_TEXT);
  });

  it("write principal assertion admits master and refuses secondary", () => {
    const sleepData = memory.getSleepData();
    expect(() => sleepData.assertWritePrincipal(MASTER)).not.toThrow();
    expect(() => sleepData.assertWritePrincipal(OTHER)).toThrow(PrimaryIdentityError);
  });

  it("published daily carries verified master provenance; legacy polluted input is excluded and reported", () => {
    const sleepData = memory.getSleepData();
    sleepData.assertWritePrincipal(MASTER);
    const start = Date.now() - 86_400_000;
    const dailyPath = writeDailyFile(memoryDir, start, Date.now(), "fixtured summary", Date.now(), MASTER);
    expect(parseArtifactOwner(readFileSync(dailyPath, "utf-8"))).toBe(MASTER);

    // Legacy polluted daily: in-range date, no provenance.
    const legacyDay = new Date(start - 86_400_000).toISOString().slice(0, 10);
    const legacyPath = join(memoryDir, "daily", `daily_${legacyDay}.md`);
    writeFileSync(legacyPath, `# Daily Summary ${legacyDay}\n\npolluted curriculum minutiae`);
    const sel = consolidationInputs(memoryDir, new Date(start), false, MASTER);
    expect(sel.excluded).toContain(legacyPath);
    expect(sel.selected.every((s) => s.path !== legacyPath)).toBe(true);
  });

  it("supersede never deletes a verified different-owner daily", () => {
    const otherPath = writeDailyFile(memoryDir, Date.now() - 86_400_000, Date.now(), "other principal daily", Date.now(), OTHER);
    writeDailyFile(memoryDir, Date.now() - 86_400_000, Date.now(), "master rewrite", Date.now(), MASTER);
    expect(existsSync(otherPath)).toBe(true);
  });

  it("S6 returns master artifacts to master and nothing to a secondary principal", () => {
    const weeklyPath = publishConsolidationFile(memoryDir, join(memoryDir, "weekly", "weekly_2026-09-27.md"), "harbor route summit notes", {
      owner: MASTER,
      coveredRange: "2026-09-21 to 2026-09-27",
      sourcePaths: [],
    });
    void weeklyPath;
    const masterHits = searchConsolidationFiles(memoryDir, ["harbor"], { requesterUserId: MASTER });
    expect(masterHits.length).toBeGreaterThan(0);
    const otherHits = searchConsolidationFiles(memoryDir, ["harbor"], { requesterUserId: OTHER });
    expect(otherHits).toHaveLength(0);
  });

  it("session-start context injects verified master artifacts for master only", () => {
    const start = Date.now() - 3600_000;
    writeDailyFile(memoryDir, start, Date.now(), MASTER_TEXT, Date.now(), MASTER);
    writeDailyFile(memoryDir, start, Date.now(), OTHER_TEXT, Date.now() + 1, OTHER);
    const savedEnv = process.env.ABMIND_USER_ID;
    process.env.ABMIND_USER_ID = MASTER;
    try {
      const masterCtx = buildSessionStartContext(memory, MASTER, 128000, { now: Date.now() });
      expect(masterCtx.text ?? "").toContain(MASTER_TEXT);
      expect(masterCtx.text ?? "").not.toContain(OTHER_TEXT);
      const otherCtx = buildSessionStartContext(memory, OTHER, 128000, { now: Date.now() });
      expect(otherCtx.text ?? "").not.toContain(MASTER_TEXT);
    } finally {
      if (savedEnv === undefined) delete process.env.ABMIND_USER_ID;
      else process.env.ABMIND_USER_ID = savedEnv;
    }
  });

  it("startup snapshot resolves from the manifest and fails closed without one", () => {
    expect(resolveOwnerSnapshot(home)).toBe(MASTER);
    expect(() => resolveOwnerSnapshot(join(root, "nope"))).toThrow(PrimaryIdentityError);
  });

  it("consolidation publication binds provenance and refuses escape targets", () => {
    const path = publishConsolidationFile(memoryDir, join(memoryDir, "weekly", "weekly_2026-09-27.md"), "# Weekly\nbody", {
      owner: MASTER,
      coveredRange: "2026-09-21 to 2026-09-27",
      sourcePaths: [join(memoryDir, "daily", "d.md")],
    });
    expect(parseArtifactOwner(readFileSync(path, "utf-8"))).toBe(MASTER);
    expect(() => publishConsolidationFile(memoryDir, join(root, "evil.md"), "x", {
      owner: MASTER, coveredRange: "r", sourcePaths: [],
    })).toThrow();
    expect(() => publishConsolidationFile(memoryDir, join(memoryDir, "weekly", "w.md"), "   ", {
      owner: MASTER, coveredRange: "r", sourcePaths: [],
    })).toThrow();
  });
});

