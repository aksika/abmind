import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { loadMemoryConfig, MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import * as logger from "./mem-logger.js";

vi.mock("./logger.js", () => ({
  logWarn: vi.fn(),
}));

/** Wipe all MEMORY_* env vars so each test starts clean. */
function clearMemoryEnv() {
  const keys = Object.keys(process.env).filter((k) => k.startsWith("MEMORY_"));
  for (const k of keys) delete process.env[k];
}

describe("loadMemoryConfig", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearMemoryEnv();
  });

  afterEach(() => {
    clearMemoryEnv();
  });

  // --- Defaults ---

  it("returns all defaults when no env vars are set", () => {
    const cfg = loadMemoryConfig();
    expect(cfg.memoryEnabled).toBe(true);
    expect(cfg.memoryDir).toBe(resolve(homedir(), ".abmind", "memory"));
    expect(cfg.maxMessagesPerChat).toBe(1000);
    expect(cfg.diskBudgetBytes).toBe(500 * 1024 * 1024);
    expect(cfg.stalenessThresholdMs).toBe(24 * 3_600_000);
    expect(cfg.restoreMessageCount).toBe(50);
  });

  // --- MEMORY_ENABLED ---

  it("parses MEMORY_ENABLED=false", () => {
    process.env["MEMORY_ENABLED"] = "false";
    expect(loadMemoryConfig().memoryEnabled).toBe(false);
  });

  it("parses MEMORY_ENABLED=1 as true", () => {
    process.env["MEMORY_ENABLED"] = "1";
    expect(loadMemoryConfig().memoryEnabled).toBe(true);
  });

  // --- MEMORY_DIR ---

  it("uses MEMORY_DIR from env when set", () => {
    process.env["MEMORY_DIR"] = "/tmp/custom-memory";
    expect(loadMemoryConfig().memoryDir).toBe("/tmp/custom-memory");
  });

  // --- MEMORY_MAX_MESSAGES_PER_CHAT ---

  it("parses MEMORY_MAX_MESSAGES_PER_CHAT as a number", () => {
    process.env["MEMORY_MAX_MESSAGES_PER_CHAT"] = "500";
    expect(loadMemoryConfig().maxMessagesPerChat).toBe(500);
  });

  it("falls back to default for invalid MEMORY_MAX_MESSAGES_PER_CHAT", () => {
    process.env["MEMORY_MAX_MESSAGES_PER_CHAT"] = "not-a-number";
    const cfg = loadMemoryConfig();
    expect(cfg.maxMessagesPerChat).toBe(1000);
  });

  // --- MEMORY_DISK_BUDGET_MB ---

  it("converts MEMORY_DISK_BUDGET_MB to bytes", () => {
    process.env["MEMORY_DISK_BUDGET_MB"] = "100";
    expect(loadMemoryConfig().diskBudgetBytes).toBe(100 * 1024 * 1024);
  });

  it("falls back to default for invalid MEMORY_DISK_BUDGET_MB", () => {
    process.env["MEMORY_DISK_BUDGET_MB"] = "abc";
    const cfg = loadMemoryConfig();
    expect(cfg.diskBudgetBytes).toBe(500 * 1024 * 1024);
  });

  // --- MEMORY_STALENESS_HOURS ---

  it("converts MEMORY_STALENESS_HOURS to milliseconds", () => {
    process.env["MEMORY_STALENESS_HOURS"] = "48";
    expect(loadMemoryConfig().stalenessThresholdMs).toBe(48 * 3_600_000);
  });

  it("falls back to default for invalid MEMORY_STALENESS_HOURS", () => {
    process.env["MEMORY_STALENESS_HOURS"] = "NaN";
    const cfg = loadMemoryConfig();
    expect(cfg.stalenessThresholdMs).toBe(24 * 3_600_000);
  });

  // --- MEMORY_RESTORE_MESSAGES ---

  it("parses MEMORY_RESTORE_MESSAGES", () => {
    process.env["MEMORY_RESTORE_MESSAGES"] = "100";
    expect(loadMemoryConfig().restoreMessageCount).toBe(100);
  });
});

// --- .env.memory sourcing (#210) ---

describe("loadMemoryConfig — sources ~/.abmind/config/.env.memory", () => {
  let tmpDir: string;
  let savedAbmindHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "env-memory-test-"));
    mkdirSync(join(tmpDir, "config"), { recursive: true });
    savedAbmindHome = process.env["ABMIND_HOME"];
    process.env["ABMIND_HOME"] = tmpDir;
    const keys = Object.keys(process.env).filter((k) => k.startsWith("MEMORY_"));
    for (const k of keys) delete process.env[k];
  });

  afterEach(() => {
    if (savedAbmindHome === undefined) delete process.env["ABMIND_HOME"];
    else process.env["ABMIND_HOME"] = savedAbmindHome;
    const keys = Object.keys(process.env).filter((k) => k.startsWith("MEMORY_"));
    for (const k of keys) delete process.env[k];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads MEMORY_DIR from .env.memory when process.env does not set it", () => {
    writeFileSync(join(tmpDir, "config", ".env.memory"), "MEMORY_DIR=/tmp/from-file\n");
    expect(loadMemoryConfig().memoryDir).toBe("/tmp/from-file");
  });

  it("host env wins over .env.memory (?? semantics)", () => {
    writeFileSync(join(tmpDir, "config", ".env.memory"), "MEMORY_DIR=/tmp/from-file\n");
    process.env["MEMORY_DIR"] = "/tmp/from-host";
    expect(loadMemoryConfig().memoryDir).toBe("/tmp/from-host");
  });
});
