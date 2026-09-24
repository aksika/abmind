/**
 * #1813 — compact-delivery journey. One temp-DB scenario through the real
 * recallSearch composition (retrieval -> decision envelope), proving the
 * wiring rather than repeating unit rules: a compact turn, a fallback turn
 * on provider death, no direct-answer bypass, a profile-gated repeat pair
 * with session isolation, and cancel/release plus recovery.
 *
 * Scripted providers only (no network); abtars ACP/Direct consumption is
 * proved by its own pipeline E2E. Each assertion here fails if the
 * engine<->decision composition is removed or bypassed.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps, type RecallParams } from "./recall-engine.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import type { IJudgmentProvider, JudgmentAnswers } from "./judgment-provider.js";
import { createTurnScopeStore } from "./recall-turn-scope.js";

const ENV_KEYS = ["SYSTEM1_FASTPATH", "SYSTEM1_JEV_EGRESS", "SYSTEM1_RECALL", "SYSTEM1"];

function row(db: Database.Database, id: number, contentEn: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0)`).run(
    id, contentEn, contentEn, now, now,
  );
}

function repeatBank(adds: number): JudgmentAnswers {
  const out: JudgmentAnswers = {};
  for (let k = 0; k < 8; k++) {
    out[`adds_${k}`] = { type: "noul", noul: adds, derivedCertainty: Math.max(adds, 1 - adds) };
  }
  return out;
}

function scripted(answers: JudgmentAnswers | null): IJudgmentProvider {
  return {
    name: "jev", model: "jev-1.13.0", busy: false, lastFailure: null,
    judge: async () => answers === null ? null : { answers, provider: "jev", model: "jev-1.13.0", latencyMs: 1 },
  };
}

function intent(overrides?: Record<string, unknown>): RecallParams["fastPath"] {
  return {
    question: "How do I deploy to production?",
    answerLanguage: "en",
    principal: "user-123",
    session: "s1",
    turn: "t1",
    delivered: [],
    ...overrides,
  } as RecallParams["fastPath"];
}

describe("#1813 — compact-delivery journey", () => {
  let saved: Record<string, string | undefined>;
  let db: Database.Database;
  let scopes: ReturnType<typeof createTurnScopeStore>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    process.env["SYSTEM1_FASTPATH"] = "on";
    process.env["SYSTEM1_JEV_EGRESS"] = "repeat";
    initAbmindEnv();
    db = initializeDatabase(":memory:");
    row(db, 1, "Production deploys run via /deploy prod after CI passes on main.");
    row(db, 2, "Production rollbacks use /rollback prod within one hour.");
    row(db, 3, "The user prefers dark mode in the dashboard.");
    scopes = createTurnScopeStore();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
    db.close();
  });

  function deps(provider?: IJudgmentProvider): RecallDeps {
    const d: RecallDeps = { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory" };
    if (provider) d.judgmentProvider = provider;
    d.turnScopes = scopes;
    return d;
  }

  function search(provider?: IJudgmentProvider, fastPath?: RecallParams["fastPath"]) {
    return recallSearch(deps(provider), { translated: ["deploy"], userId: "user-123", limit: 5, fastPath });
  }

  it("compact turn, fallback turn, no bypass, repeat pair, isolation, cancel, recovery", async () => {
    // Turn 1 — compact: new information flows as continue with bounded refs;
    // no lookup profile exists, so the answer branch never fires.
    const t1 = await search(scripted(repeatBank(0.9)), intent());
    expect(t1.results.length).toBeGreaterThan(0);
    expect(t1.decision?.outcome).toBe("continue");
    expect(t1.decision!.selectedRefs.length).toBeLessThanOrEqual(2);

    // Turn 2 — fallback: dead provider abstains to continue (never a verdict
    // from missing judgments) with the exact baseline order.
    const baseline = await recallSearch(deps(), { translated: ["deploy"], userId: "user-123", limit: 5 });
    const t2 = await search(scripted(null), intent({ delivered: [{ id: 1, revision: 1 }] }));
    expect(t2.decision?.outcome).toBe("continue");
    expect(t2.results.map((r) => r.id)).toEqual(baseline.results.map((r) => r.id));

    // Turn 3 — repeat pair: same-turn repull suppresses, while a sibling
    // session presenting no delivered refs flows normally (no cross-session
    // leakage from s1's scope).
    const t3a = await search(scripted(repeatBank(0.1)), intent({ delivered: [{ id: 1, revision: 1 }] }));
    expect(t3a.decision?.outcome).toBe("already-supplied");
    const t3b = await search(
      scripted(repeatBank(0.1)),
      intent({ session: "s2", turn: "t1" }),
    );
    expect(t3b.decision?.outcome).toBe("continue");

    // Turn 4 — cancel: the release signal clears scope and returns no decision.
    const t4 = await search(scripted(repeatBank(0.1)), intent({ releaseScope: true }));
    expect(t4.decision).toBeUndefined();
    expect(scopes.size).toBe(0);

    // Turn 5 — recovery: after death and cancel, a live provider judges again.
    const t5 = await search(scripted(repeatBank(0.1)), intent({ delivered: [{ id: 1, revision: 1 }] }));
    expect(t5.decision?.outcome).toBe("already-supplied");
  });
});
