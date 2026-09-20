/**
 * #1813 — fast-path decision tests. Real in-memory database for row
 * verification; scripted providers (no network) for combination behavior.
 * Each test pins one activation rule: absent intent/flag/provider/profile/
 * budget/grant means ordinary recall, never a verdict.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { MemoryIndex } from "./memory-index.js";
import { recallSearch, type RecallDeps, type RecallParams } from "./recall-engine.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import type { IJudgmentProvider, JudgmentAnswers, JudgmentResult } from "./judgment-provider.js";
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

function depsWith(db: Database.Database, provider?: IJudgmentProvider): RecallDeps {
  const deps: RecallDeps = { db, index: new MemoryIndex(db), memoryDir: "/tmp/test-memory" };
  if (provider) deps.judgmentProvider = provider;
  deps.turnScopes = createTurnScopeStore();
  return deps;
}

function scripted(name: string, model: string, answers: JudgmentAnswers | null): IJudgmentProvider {
  return {
    name, model, busy: false, lastFailure: null,
    judge: async () => answers === null ? null : { answers, provider: name, model, latencyMs: 1 },
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

function repeatAnswers(...adds: number[]): JudgmentAnswers {
  // Fill a full candidate bank: the engine judges up to five candidates and
  // suppression needs every judged candidate answered; per-test values take
  // precedence by index, the last value repeats for the rest.
  const out: JudgmentAnswers = {};
  for (let k = 0; k < 8; k++) {
    const addsValue = adds[Math.min(k, adds.length - 1)] ?? 0;
    out[`adds_${k}`] = {
      type: "noul",
      noul: addsValue,
      derivedCertainty: Math.max(addsValue, 1 - addsValue),
    };
  }
  return out;
}

describe("#1813 — decideFastPath", () => {
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
    vi.restoreAllMocks();
  });

  function enableFastpath(egress = ""): void {
    process.env["SYSTEM1_FASTPATH"] = "on";
    if (egress) process.env["SYSTEM1_JEV_EGRESS"] = egress;
    initAbmindEnv();
  }

  async function search(fastPath: RecallParams["fastPath"], provider?: IJudgmentProvider) {
    return recallSearch(depsWith(db, provider), {
      translated: ["deploy"], userId: "user-123", limit: 5, fastPath,
    });
  }

  it("omits the decision field without intent (ordinary recall untouched)", async () => {
    initAbmindEnv();
    const res = await recallSearch(depsWith(db), { translated: ["deploy"], userId: "user-123" });
    expect(res.decision).toBeUndefined();
    expect(res.results.length).toBeGreaterThan(0);
  });

  it("returns null decision with FASTPATH off even when intent is present", async () => {
    initAbmindEnv();
    const provider = scripted("jev", "jev-1.13.0", repeatAnswers(0.1));
    const res = await search(intent({ delivered: [{ id: 1, revision: 0 }] }), provider);
    expect(res.decision).toBeUndefined();
  });

  it("suppresses a same-turn repull on Jev with a passing profile", async () => {
    enableFastpath("repeat");
    const provider = scripted("jev", "jev-1.13.0", repeatAnswers(0.1));
    const res = await search(intent({ delivered: [{ id: 1, revision: 0 }] }), provider);
    expect(res.decision?.outcome).toBe("already-supplied");
    expect(res.decision?.questionSet).toBe("repeat-v1");
    expect(res.decision?.sourceIds).toEqual([1]);
  });

  it("lets new information through (no suppression above the gate)", async () => {
    enableFastpath("repeat");
    const provider = scripted("jev", "jev-1.13.0", repeatAnswers(0.9));
    const res = await search(intent({ delivered: [{ id: 1, revision: 0 }] }), provider);
    // Repeat passes, lookup has no profile: ordinary continue with no verdict.
    expect(res.decision?.outcome).toBe("continue");
    expect(res.decision?.profile).toBe("none");
  });

  it("keeps laya repeats inactive (no passing profile)", async () => {
    enableFastpath();
    const provider = scripted("laya", "laya-sidecar", repeatAnswers(0.0));
    const res = await search(intent({ delivered: [{ id: 1, revision: 0 }] }), provider);
    expect(res.decision?.outcome).toBe("continue");
  });

  it("abstains on Jev without an egress grant", async () => {
    enableFastpath();
    const provider = scripted("jev", "jev-1.13.0", repeatAnswers(0.0));
    const res = await search(intent({ delivered: [{ id: 1, revision: 0 }] }), provider);
    expect(res.decision?.outcome).toBe("continue");
  });

  it("releases scope and returns no decision on the release signal", async () => {
    enableFastpath("repeat");
    const scopes = createTurnScopeStore();
    const deps = depsWith(db, scripted("jev", "jev-1.13.0", repeatAnswers(0.0)));
    deps.turnScopes = scopes;
    const base = { translated: ["deploy"], userId: "user-123", limit: 5 } as RecallParams;
    await recallSearch(deps, { ...base, fastPath: intent({ delivered: [{ id: 1, revision: 0 }] }) });
    expect(scopes.size).toBe(1);
    const res = await recallSearch(deps, { ...base, fastPath: intent({ releaseScope: true }) });
    expect(res.decision).toBeUndefined();
    expect(scopes.size).toBe(0);
  });

  it("ignores delivered ids that fail verification", async () => {
    enableFastpath("repeat");
    const judged: Array<{ state: Record<string, unknown> }> = [];
    const provider: IJudgmentProvider = {
      name: "jev", model: "jev-1.13.0", busy: false, lastFailure: null,
      judge: async (state, questions) => {
        judged.push({ state });
        const result: JudgmentResult = {
          answers: repeatAnswers(0.0), provider: "jev", model: "jev-1.13.0", latencyMs: 1,
        };
        return result;
      },
    };
    // id 999 has no row: verification drops it, repeat has nothing to compare.
    const res = await search(intent({ delivered: [{ id: 999, revision: 0 }] }), provider);
    expect(judged.length).toBe(0);
    expect(res.decision?.outcome).toBe("continue");
  });
});
