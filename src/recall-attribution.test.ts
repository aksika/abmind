/**
 * #1813 — attribution operation tests. Real in-memory database for source
 * verification; scripted providers (no network) for combination behavior.
 * Pins the gray zone (used / not-used / unknown) and the rule that
 * unverifiable sources report unknown, never a negative.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import type { IJudgmentProvider, JudgmentAnswers } from "./judgment-provider.js";
import { judgeAttribution } from "./recall-attribution.js";

const ENV_KEYS = ["SYSTEM1_FASTPATH", "SYSTEM1_JEV_EGRESS"];

function row(db: Database.Database, id: number, contentEn: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0)`).run(
    id, contentEn, contentEn, now, now,
  );
}

function scripted(name: string, model: string, used: number[]): IJudgmentProvider {
  const answers: JudgmentAnswers = {};
  used.forEach((p, k) => {
    answers[`used_${k}`] = { type: "noul", noul: p, derivedCertainty: Math.max(p, 1 - p) };
  });
  return {
    name, model, busy: false, lastFailure: null,
    judge: async () => ({ answers, provider: name, model, latencyMs: 1 }),
  };
}

describe("#1813 — judgeAttribution", () => {
  let saved: Record<string, string | undefined>;
  let db: Database.Database;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    db = initializeDatabase(":memory:");
    row(db, 1, "Production deploys run via /deploy prod after CI passes on main.");
    row(db, 2, "The user prefers dark mode in the dashboard.");
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
    db.close();
  });

  function enable(egress = ""): void {
    process.env["SYSTEM1_FASTPATH"] = "on";
    if (egress) process.env["SYSTEM1_JEV_EGRESS"] = egress;
    initAbmindEnv();
  }

  it("returns null without the flag, provider, response, or sources", async () => {
    initAbmindEnv();
    const provider = scripted("laya", "laya-sidecar", [0.9]);
    const base = { userId: "user-123", response: "Deploys run via /deploy prod.", sourceIds: [1] };
    expect(await judgeAttribution({ db }, base)).toBeNull();
    expect(await judgeAttribution({ db, judgmentProvider: provider }, { ...base, response: "  " })).toBeNull();
    expect(await judgeAttribution({ db, judgmentProvider: provider }, { ...base, sourceIds: [] })).toBeNull();
  });

  it("reports used and not-used outside the gray zone", async () => {
    enable();
    const provider = scripted("laya", "laya-sidecar", [0.9, 0.1]);
    const res = await judgeAttribution(
      { db, judgmentProvider: provider },
      { userId: "user-123", response: "Deploys run via /deploy prod.", sourceIds: [1, 2] },
    );
    expect(res?.questionSet).toBe("attribution-v1");
    expect(res?.sources).toEqual([
      { id: 1, verdict: "used" },
      { id: 2, verdict: "not-used" },
    ]);
  });

  it("reports mid-zone probabilities as unknown, not negative", async () => {
    enable();
    const provider = scripted("laya", "laya-sidecar", [0.5, 0.5]);
    const res = await judgeAttribution(
      { db, judgmentProvider: provider },
      { userId: "user-123", response: "Something vaguely deploy-ish.", sourceIds: [1, 2] },
    );
    expect(res?.sources).toEqual([
      { id: 1, verdict: "unknown" },
      { id: 2, verdict: "unknown" },
    ]);
  });

  it("reports unverifiable sources as unknown, never negative", async () => {
    enable();
    const provider = scripted("laya", "laya-sidecar", [0.9, 0.9]);
    const res = await judgeAttribution(
      { db, judgmentProvider: provider },
      { userId: "user-123", response: "Deploys run via /deploy prod.", sourceIds: [1, 999] },
    );
    expect(res?.sources).toEqual([
      { id: 1, verdict: "used" },
      { id: 999, verdict: "unknown" },
    ]);
  });

  it("abstains on Jev without an egress grant", async () => {
    enable();
    const provider = scripted("jev", "jev-1.13.0", [0.9]);
    const res = await judgeAttribution(
      { db, judgmentProvider: provider },
      { userId: "user-123", response: "Deploys run via /deploy prod.", sourceIds: [1] },
    );
    expect(res).toBeNull();
  });

  it("attributes on Jev with the grant", async () => {
    enable("attribution");
    const provider = scripted("jev", "jev-1.13.0", [0.9]);
    const res = await judgeAttribution(
      { db, judgmentProvider: provider },
      { userId: "user-123", response: "Deploys run via /deploy prod.", sourceIds: [1] },
    );
    expect(res?.sources).toEqual([{ id: 1, verdict: "used" }]);
    expect(res?.profile).toContain("attribution-v1");
  });
});
