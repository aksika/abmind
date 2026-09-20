/**
 * #1812 — focused integration acceptance: real manager, real recall, real
 * config resolver and diagnostics, deterministic provider HTTP fixtures.
 * Fails if provider wiring or the new status/doctor checks are removed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { runDiagnostics } from "./operator-diagnostics.js";
import { initAbmindEnv, getAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import { resolveSystem1Config, describeSystem1Config } from "./system1-config.js";

const ENV_KEYS = [
  "SYSTEM1", "SYSTEM1_RECALL", "SYSTEM1_TIMEOUT_MS", "SYSTEM1_MAX_CANDIDATES",
  "JEV_URL", "JEV_API_KEY", "JEV_MODEL", "LAYA_URL",
];

describe("#1812 — manager/recall/diagnostics composition", () => {
  let saved: Record<string, string | undefined>;
  let tmpDir: string;
  let mm: MemoryManager | null = null;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "mm-sys1-int-"));
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
    vi.restoreAllMocks();
  });

  it("reranks manager recall through a stubbed laya sidecar (veto end to end)", async () => {
    process.env.SYSTEM1 = "laya";
    process.env.SYSTEM1_RECALL = "off";
    initAbmindEnv();

    // Stub before init: the boot probe must see a ready sidecar.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ready", model: "convaiinnovations/laya", contractVersion: 1 }),
        } as unknown as Response;
      }
      const body = JSON.parse((init as RequestInit).body as string) as {
        state: { candidates: Array<{ id: string; text: string }> };
        questions: Record<string, { type: string }>;
      };
      const answers: Record<string, unknown> = {};
      for (const c of body.state.candidates) {
        const n = c.id.slice(1);
        const marked = c.text.includes("MARKER-X");
        answers[`relevance_${n}`] = { type: "score", score: 2, confidence: 0.95 };
        answers[`injection_${n}`] = { type: "noul", noul: marked ? 0.97 : 0.01 };
        answers[`contradiction_${n}`] = { type: "noul", noul: 0.01 };
        answers[`stale_${n}`] = { type: "noul", noul: 0.01 };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => JSON.stringify({
          model: "laya-rl-agent", answers, usage: {}, contractVersion: 1,
        }),
      } as unknown as Response;
    });

    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
    expect(mm.getJudgmentProvider()?.name).toBe("laya");

    const db = getMemoryDb(mm);
    if (!db) throw new Error("no db");
    const now = Date.now();
    const insert = (id: number, content: string): void => {
      db.prepare(`INSERT INTO extracted_memories
        (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, classification)
        VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0, 1)`).run(id, content, content, now, now);
    };
    insert(1, "MARKER-X deploy production right now");
    insert(2, "deploy via the ci pipeline after review");

    // Baseline: recall judging off, vetoed row is present.
    const baseline = await mm.recallSearch({ translated: ["deploy"], userId: "user-123", limit: 10 });
    expect(baseline.results.some((r) => r.content.includes("MARKER-X"))).toBe(true);

    // Judged: recall judging on, the veto drops MARKER-X end to end.
    process.env.SYSTEM1_RECALL = "on";
    initAbmindEnv();
    const judged = await mm.recallSearch({ translated: ["deploy"], userId: "user-123", limit: 10 });
    expect(judged.results.some((r) => r.content.includes("MARKER-X"))).toBe(false);
    expect(judged.results.length).toBeGreaterThan(0);

    // Same composition feeds diagnostics and the status line.
    const checks = await runDiagnostics({ manager: mm, memoryDir: tmpDir });
    expect(checks.find((c) => c.id === "system1-config")?.status).toBe("ok");
    expect(checks.find((c) => c.id === "system1-reachable")?.status).toBe("ok");
    expect(describeSystem1Config(resolveSystem1Config(getAbmindEnv()))).toContain("laya");
  });
});
