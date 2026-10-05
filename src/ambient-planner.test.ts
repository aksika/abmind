/**
 * #1908 M2 — deterministic ambient planner tests. Real SQLite over a temp
 * store (scoped df reads only, no stages run); the corpus needs 5+ rows for
 * the df measure to carry signal.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";
import {
  planAmbientRecall,
  AMBIENT_CONTEXT_RANK_WEIGHT,
  type AmbientPlanInput,
} from "./ambient-planner.js";

const ENV_KEYS = ["SYSTEM1", "SYSTEM1_RECALL"];

const USER = "user-123";
const HOST = "test-host";
const CONV = "conv-1";

function row(db: Database.Database, id: number, content: string): void {
  const now = Date.now();
  db.prepare(`INSERT INTO extracted_memories
    (id, content_en, content_original, memory_type, created_at, source_timestamp, user_id, confidence, emotion_score, recall_count, relevance_score, semantic_revision)
    VALUES (?, ?, ?, 'fact', ?, ?, 'user-123', 3, 0, 0, 0, 0)`).run(
    id, content, content, now, now,
  );
}

/** Six-row corpus: three common-word carriers plus English + Hungarian + Cyrillic targets. */
function seed(db: Database.Database): void {
  row(db, 1, "Deploy production with the standard pipeline after CI passes.");
  row(db, 2, "Deploy rollbacks restore the previous production release.");
  row(db, 3, "Akkor meg hogy van ez mostanában a csapatban.");
  row(db, 4, "Akkor meg hogy lesz ez holnap is a megbeszélésen.");
  row(db, 5, "Tegnap akkor meg hogy döntöttünk a határidőről.");
  row(db, 6, "A telepítési útmutató a wiki oldalán van.");
}

function input(db: Database.Database, overrides: Partial<AmbientPlanInput> = {}): AmbientPlanInput {
  return {
    db,
    rawTurn: "akkor meg hogy",
    userId: USER,
    scope: { limit: 5, maxClassification: 2 },
    current: { host: HOST, conversation: CONV, executionId: "turn-2" },
    ...overrides,
  };
}

function snapshot(text: string, overrides = {}) {
  return {
    text,
    principal: USER,
    host: HOST,
    conversation: CONV,
    executionId: "turn-1",
    complete: true,
    recencyRank: 0,
    ...overrides,
  };
}

describe("#1908 ambient planner", () => {
  let saved: Record<string, string | undefined>;
  let db: Database.Database;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    initAbmindEnv();
    db = initializeDatabase(":memory:");
    seed(db);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
    db.close();
  });

  it("skips a measured common-only turn with no context", () => {
    const plan = planAmbientRecall(input(db));
    expect(plan.skip).toBe(true);
    expect(plan.diagnostics.plans).toBe("raw");
    expect(plan.diagnostics.skipReason).toBe("no-informative-terms");
  });

  it("searches an informative raw turn and keeps its terms", () => {
    const plan = planAmbientRecall(input(db, { rawTurn: "deploy pipeline" }));
    expect(plan.skip).toBe(false);
    expect(plan.rawTerms).toContain("deploy");
    expect(plan.diagnostics.semanticSource).toBe("raw");
    expect(plan.semanticText).toContain("deploy pipeline");
  });

  it("keeps an explicitly named current topic when the whole-turn measure is incomplete", () => {
    const prompts = [
      "What is the deployment pipeline we selected?",
      "Please explain which deployment plan follows our earlier discussion after checking project status again",
    ];
    for (const rawTurn of prompts) {
      const plan = planAmbientRecall(input(db, {
        rawTurn,
        contextOptions: [snapshot("Earlier we discussed rollbacks and release recovery.")],
      }));
      expect(plan.skip).toBe(false);
      expect(plan.diagnostics.plans).toBe("raw+context");
      expect(plan.rawTerms).toContain("deployment");
      expect(plan.diagnostics.semanticSource).toBe("raw");
      expect(plan.semanticText).toBe(rawTurn);
    }
  });

  it("extracts Unicode terms without a word list", () => {
    const plan = planAmbientRecall(input(db, { rawTurn: "hol a telepítési útmutató" }));
    expect(plan.skip).toBe(false);
    expect(plan.rawTerms).toContain("telepítési");
    expect(plan.rawTerms).toContain("útmutató");
  });

  it("an informative context rescues a common-word follow-up", () => {
    const plan = planAmbientRecall(input(db, {
      contextOptions: [snapshot("hol találom a telepítési útmutató oldalt")],
    }));
    expect(plan.skip).toBe(false);
    expect(plan.diagnostics.plans).toBe("raw+context");
    expect(plan.contextTerms).not.toBeNull();
    expect(plan.contextTerms).toContain("telepítési");
    // The common raw turn loses the semantic input to informative context.
    expect(plan.diagnostics.semanticSource).toBe("context");
    expect(plan.semanticText).toContain("telepítési");
  });

  it("a common context option does not rescue, and the skip holds", () => {
    const plan = planAmbientRecall(input(db, {
      contextOptions: [snapshot("akkor meg hogy akkor")],
    }));
    expect(plan.skip).toBe(true);
    expect(plan.diagnostics.plans).toBe("raw");
  });

  it("selects the newest eligible option deterministically", () => {
    const plan = planAmbientRecall(input(db, {
      rawTurn: "akkor meg hogy",
      contextOptions: [
        snapshot("akkor meg hogy akkor", { recencyRank: 0 }),
        snapshot("hol a telepítési útmutató", { recencyRank: 1, executionId: "turn-0" }),
      ],
    }));
    // Rank 0 is eligible but uninformative, so planning continues to rank 1.
    expect(plan.skip).toBe(false);
    expect(plan.diagnostics.plans).toBe("raw+context");
    expect(plan.contextText).toContain("telepítési");
  });

  it("rejects foreign, stale, current, incomplete, and checkpoint-only context", () => {
    // At most four options are considered per turn; split the hostile set
    // across two plans.
    const first = planAmbientRecall(input(db, {
      contextOptions: [
        snapshot("telepítési útmutató", { principal: "mallory" }),
        snapshot("telepítési útmutató", { executionId: "turn-2" }),
        { ...snapshot("telepítési útmutató"), complete: false as const },
        snapshot("telepítési útmutató", { checkpointOnly: true }),
      ],
    }));
    expect(first.skip).toBe(true);
    expect(first.diagnostics.plans).toBe("raw");
    expect(first.diagnostics.contextRejected["foreign-principal"]).toBe(1);
    expect(first.diagnostics.contextRejected["current-execution"]).toBe(1);
    expect(first.diagnostics.contextRejected["incomplete"]).toBe(1);
    expect(first.diagnostics.contextRejected["checkpoint-only"]).toBe(1);

    const second = planAmbientRecall(input(db, {
      contextOptions: [
        snapshot("telepítési útmutató", { host: "elsewhere" }),
        snapshot("telepítési útmutató", { conversation: "conv-9" }),
        snapshot("telepítési útmutató", { generation: 3 }),
      ],
    }));
    expect(second.skip).toBe(true);
    expect(second.diagnostics.contextRejected["foreign-host"]).toBe(1);
    expect(second.diagnostics.contextRejected["foreign-conversation"]).toBe(1);
    expect(second.diagnostics.contextRejected["stale-generation"]).toBe(1);
  });

  it("rejects context that cannot prove it is not the current turn", () => {
    const plan = planAmbientRecall(input(db, {
      contextOptions: [{ ...snapshot("telepítési útmutató"), executionId: undefined }],
    }));
    expect(plan.diagnostics.plans).toBe("raw");
    expect(plan.diagnostics.contextRejected["current-execution"]).toBe(1);
  });

  it("rejects an over-budget context option", () => {
    const big = `telepítési útmutató ${"x".repeat(9000)}`;
    const plan = planAmbientRecall(input(db, { contextOptions: [snapshot(big)] }));
    expect(plan.diagnostics.plans).toBe("raw");
    expect(plan.diagnostics.contextRejected["over-budget"]).toBe(1);
  });

  it("an over-budget informative option cannot block a justified skip", () => {
    // The newest option is informative but over budget; the only eligible
    // option left is common, so the combined evidence justifies the skip.
    const big = `telepítési útmutató ${"x".repeat(9000)}`;
    const plan = planAmbientRecall(input(db, {
      contextOptions: [
        snapshot(big, { recencyRank: 0 }),
        snapshot("akkor meg hogy akkor", { recencyRank: 1, executionId: "turn-0" }),
      ],
    }));
    expect(plan.skip).toBe(true);
    expect(plan.diagnostics.plans).toBe("raw");
    expect(plan.diagnostics.contextRejected["over-budget"]).toBe(1);
  });

  it("malformed context text is missing evidence, never a crash", () => {
    const plan = planAmbientRecall(input(db, {
      contextOptions: [
        { ...snapshot("telepítési útmutató"), text: 42 as unknown as string },
        { ...snapshot("telepítési útmutató"), text: undefined as unknown as string },
      ],
    }));
    expect(plan.diagnostics.plans).toBe("raw");
    expect(plan.diagnostics.contextRejected["incomplete"]).toBe(2);
  });

  it("folds informative hints into the raw plan and drops common ones", () => {
    const plan = planAmbientRecall(input(db, {
      rawTurn: "akkor meg hogy",
      hints: ["deploy", "akkor"],
    }));
    expect(plan.rawTerms).toContain("deploy");
    expect(plan.rawTerms).not.toContain("akkor");
    expect(plan.diagnostics.hintsTotal).toBe(2);
    expect(plan.diagnostics.hintsInformative).toBe(1);
    // The informative hint rescues the common raw turn from a skip.
    expect(plan.skip).toBe(false);
  });

  it("keeps the contextual weight strictly below the raw contribution", () => {
    expect(AMBIENT_CONTEXT_RANK_WEIGHT).toBeGreaterThan(0);
    expect(AMBIENT_CONTEXT_RANK_WEIGHT).toBeLessThan(1);
  });

  it("uses the raw text as fallback when nothing is measurable", () => {
    const plan = planAmbientRecall(input(db, { rawTurn: "ok", contextOptions: [] }));
    expect(plan.skip).toBe(false);
    expect(plan.diagnostics.semanticSource).toBe("raw");
  });

  it("keeps raw semantic input when both sides are unmeasurable (small corpus)", () => {
    const small = initializeDatabase(":memory:");
    try {
      row(small, 1, "hol a telepítési útmutató");
      row(small, 2, "akkor meg hogy");
      row(small, 3, "deploy pipeline");
      const plan = planAmbientRecall({
        db: small,
        rawTurn: "akkor meg hogy",
        userId: USER,
        scope: { limit: 5, maxClassification: 2 },
        current: { host: HOST, conversation: CONV, executionId: "turn-2" },
        contextOptions: [snapshot("hol a telepítési útmutató")],
      });
      // Plans still join (lexical retrieval is conservative), but the
      // inconclusive measure keeps the raw text as the semantic input.
      expect(plan.diagnostics.plans).toBe("raw+context");
      expect(plan.diagnostics.semanticSource).toBe("raw");
      expect(plan.skip).toBe(false);
    } finally {
      small.close();
    }
  });
});
