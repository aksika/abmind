/**
 * #1821 — doctor daily-freshness must use parsed write stamps, not the
 * reverse-sorted filename. Real MemoryManager over a temp dir; no network.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { runDiagnostics } from "./operator-diagnostics.js";
import type { DoctorCheckResult } from "./abmind-protocol.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

const ENV_KEYS = [
  "SYSTEM1", "SYSTEM1_RECALL", "SYSTEM1_FASTPATH", "SYSTEM1_TIMEOUT_MS", "SYSTEM1_MAX_CANDIDATES",
  "JEV_URL", "JEV_API_KEY", "JEV_MODEL", "LAYA_URL",
];

function find(checks: DoctorCheckResult[], id: string): DoctorCheckResult {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`missing check ${id}`);
  return c;
}

describe("#1821 — doctor daily freshness", () => {
  let saved: Record<string, string | undefined>;
  let tmpDir: string;
  let mm: MemoryManager | null = null;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "mm-docdaily-"));
  });

  afterEach(() => {
    mm?.close();
    mm = null;
    rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
  });

  async function initManager(): Promise<MemoryManager> {
    initAbmindEnv();
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
    return mm;
  }

  it("picks the newest daily by write stamp, not reverse filename order", async () => {
    process.env.SYSTEM1 = "off";
    mkdirSync(join(tmpDir, "daily"), { recursive: true });
    writeFileSync(join(tmpDir, "daily", "daily_2020-06-15.md"), "# Daily Summary 2020-06-15\n\nlegacy");
    writeFileSync(join(tmpDir, "daily", "daily_2020-06-15-1200Z.md"), "# Daily Summary 2020-06-15\n\nstamped");
    const manager = await initManager();
    const check = find(await runDiagnostics({ manager, memoryDir: tmpDir }), "daily-freshness");
    expect(check.status).toBe("warn");
    expect(check.message).toContain("daily_2020-06-15-1200Z.md");
  });

  it("reports a freshly stamped daily as ok", async () => {
    process.env.SYSTEM1 = "off";
    mkdirSync(join(tmpDir, "daily"), { recursive: true });
    const d = new Date(Date.now() - 3_600_000);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const name = `daily_${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z.md`;
    writeFileSync(join(tmpDir, "daily", name), "# Daily Summary\n\nfresh");
    const manager = await initManager();
    const check = find(await runDiagnostics({ manager, memoryDir: tmpDir }), "daily-freshness");
    expect(check.status).toBe("ok");
    expect(check.message).toContain("latest 0d old");
  });
});
