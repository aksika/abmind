/**
 * transport-cutover.test.ts — Full MCP/transport cutover before live migration (#1930).
 *
 * Every personal-data transport funnels through two choke points:
 * - reads: MemoryManager.recallSearch (profiled new-model recall) and the
 *   readiness-gated hydration/session paths;
 * - writes: PrivateMemoryMutationStore.appendInstant (routes to durable when
 *   ready) and mutateOne/merge/cascadeDelete (refuse the retired model).
 *
 * Each test below fails if its transport bypasses the cutover: a store that
 * lands in the wrong model, a mutation that claims success invisibly, or a
 * read that serves retired rows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { setPersonalState } from "./personal-schema.js";
import { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";
import { personalRecall } from "./personal-recall.js";
import { buildWakeUp } from "./wake-up-builder.js";
import { checkWorthRetrieving, recallSearch } from "./recall-engine.js";
import { MemoryIndex } from "./memory-index.js";
import { SleepDataAccess } from "./sleep-data-access.js";
import { forgetPersonal } from "./personal-forget.js";

let tmpDir: string;
let db: Database.Database;
const OWNER = "cutover-owner";

function message(content: string, role = "user", ts = 1000): number {
  return Number(
    db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 'cut_A_main', ?, ?, ?)").run(OWNER, role, content, ts).lastInsertRowid,
  );
}

function readyStore(): PrivateMemoryMutationStore {
  return new PrivateMemoryMutationStore(db, OWNER);
}

const CTX = (userId = OWNER) => ({ userId, actorId: "cutover-test", operationKey: `cutover-${Date.now()}-${Math.random()}`, canDeclassifySecret: false, origin: "cli" as const });

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cutover-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  ensureInitialized(db, tmpDir);
  setPersonalState(db, "ready", { reason: "cutover test ready" });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("store cutover (MCP memory_store, host lifecycle store, CLI store)", () => {
  it("writes durable inference knowledge on ready datasets, recallable and owned", async () => {
    const store = readyStore();
    const result = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "the gate code is 4821", contentOriginal: "the gate code is 4821",
      memoryType: "fact", emotionScore: 0, actorId: "cutover-test",
    } as never);
    expect(result.stored).toBe(true);
    if (!result.stored) return;
    // Lands in the new model with inference authority, never legacy rows.
    const durable = db.prepare("SELECT authority, evidence FROM long_term_memories WHERE id = ?").get(result.memoryId) as
      | { authority: string; evidence: string } | undefined;
    expect(durable?.authority).toBe("inference");
    expect(JSON.parse(durable!.evidence)).toEqual([{ kind: "direct", ref: "direct", excerpt: "the gate code is 4821", classification: 1 }]);
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as { c: number }).c).toBe(0);
    // Recallable through the profiled path with the real reason attached.
    const recalled = personalRecall(db, OWNER, "recall_fast", "gate code");
    expect(recalled.hits.some((h) => h.layer === "durable" && h.id === result.memoryId)).toBe(true);
  });

  it("grounds evidence in owned source messages when supplied", async () => {
    const u = message("I prefer window seats");
    const store = readyStore();
    const result = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "window seat preference", contentOriginal: "window seat preference",
      memoryType: "preference", emotionScore: 0, sourceMessageIds: String(u), actorId: "cutover-test",
    } as never);
    expect(result.stored).toBe(true);
    if (!result.stored) return;
    const durable = db.prepare("SELECT evidence FROM long_term_memories WHERE id = ?").get(result.memoryId) as { evidence: string };
    const evidence = JSON.parse(durable.evidence) as Array<{ kind: string; ref: string }>;
    expect(evidence).toEqual([{ kind: "user_message", ref: `messages:${u}`, excerpt: "I prefer window seats", classification: 1 }]);
  });

  it("refuses foreign source messages and sealed direct stores without storing", async () => {
    const store = readyStore();
    const foreign = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "borrowed", contentOriginal: "borrowed",
      memoryType: "fact", emotionScore: 0, sourceMessageIds: "999999", actorId: "cutover-test",
    } as never);
    expect(foreign.stored).toBe(false);
    const sealed = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "label", contentOriginal: "hunter2",
      memoryType: "secret", emotionScore: 0, classification: 3, sealedLabel: "label", actorId: "cutover-test",
    } as never);
    expect(sealed.stored).toBe(false);
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c).toBe(0);
  });
});

describe("legacy mutation retirement (MCP memory_edit, sleep-apply, daemon edits)", () => {
  it("refuses edit/merge/cascade on ready datasets instead of writing invisible rows", async () => {
    const store = readyStore();
    const legacy = db.prepare(
      "INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, semantic_revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(OWNER, "old", "old", "fact", 1000, 1000, 1);
    const id = Number(legacy.lastInsertRowid);
    const edited = store.edit(
      CTX(), { userId: OWNER, memoryId: id, expectedRevision: 1, contentEn: "new" },
    );
    expect(edited.ok).toBe(false);
    const merged = store.merge(
      CTX(), { userId: OWNER, first: { memoryId: id, semanticRevision: 1 }, second: { memoryId: id + 1000, semanticRevision: 1 } },
    );
    expect(merged.ok).toBe(false);
    const u = message("doomed");
    expect(() => store.cascadeDelete(CTX(), { userId: OWNER, messageIds: [u] })).toThrow(/retired/);
    // Nothing was written or removed behind the refusal.
    expect((db.prepare("SELECT content_en FROM extracted_memories WHERE id = ?").get(id) as { content_en: string }).content_en).toBe("old");
    expect(db.prepare("SELECT 1 FROM messages WHERE id = ?").get(u)).toBeDefined();
  });
});

describe("sleep legacy steps retire on ready datasets", () => {
  it("contradiction invalidation declines instead of mutating retired rows", () => {
    const sleep = new SleepDataAccess(db, OWNER);
    const legacy = db.prepare(
      "INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, semantic_revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(OWNER, "old", "old", "fact", 1000, 1000, 1);
    const id = Number(legacy.lastInsertRowid);
    const result = sleep.invalidateMemory(OWNER, id, 1, "2026-01-01", "sleep:test");
    expect(result.ok).toBe(false);
  });
});

describe("read-path cutover (hooks, daemon recall, wake-up, heuristics)", () => {
  it("serves wake-up flashback from durable knowledge, never retired rows", () => {
    // A retired-model row with emotional content must stay invisible.
    db.prepare(
      "INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score, semantic_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(OWNER, "legacy heartbreak", "legacy heartbreak", "event", 1000, 1000, 5, 1);
    const u = message("we adopted a rescue dog");
    const store = readyStore();
    store.storePersonalDurable({
      userId: OWNER, memoryType: "fact", content: "adopted a rescue dog", authority: "user_statement",
      authorityBasis: "verbatim quote", applicabilityScope: { scope: "general" },
      provenance: {}, evidence: [{ kind: "user_message", ref: `messages:${u}`, excerpt: "we adopted a rescue dog", classification: 1 }],
      actorId: "cutover-test",
    });
    const wake = buildWakeUp(db, OWNER);
    expect(wake).toContain("rescue dog");
    expect(wake).not.toContain("heartbreak");
  });

  it("hides a forgotten durable row from the flashback", () => {
    const u = message("my secret hobby is lockpicking");
    const store = readyStore();
    const kept = store.storePersonalDurable({
      userId: OWNER, memoryType: "fact", content: "my secret hobby is lockpicking", authority: "user_statement",
      authorityBasis: "verbatim quote", applicabilityScope: { scope: "general" },
      provenance: {}, evidence: [{ kind: "user_message", ref: `messages:${u}`, excerpt: "my secret hobby is lockpicking", classification: 1 }],
      actorId: "cutover-test",
    });
    expect(forgetPersonal(db, { owner: OWNER, callerOwner: OWNER, targets: [{ kind: "durable", id: kept.id }], memoryDir: tmpDir, actorId: "cutover-test" }).state).toBe("complete");
    // The only durable candidate is forgotten: no flashback may render, and
    // the forgotten content must not appear.
    const wake = buildWakeUp(db, OWNER);
    expect(wake).not.toContain("lockpicking");
    expect(wake).not.toContain("[Flashback]");
  });

  it("skips uninformative ambient turns but never explicit ones", async () => {
    // Saturate the new-model corpus so every query term is over-common, the
    // same condition that made the retired heuristic vote skip.
    const store = readyStore();
    for (let i = 0; i < 8; i++) {
      const kept = store.storePersonalDurable({
        userId: OWNER, memoryType: "fact", content: `entirely ordinary note ${i}`, authority: "inference",
        authorityBasis: "cutover fixture", applicabilityScope: { scope: "general" },
        provenance: {}, evidence: [{ kind: "direct", ref: "direct", excerpt: `entirely ordinary note ${i}`, classification: 1 }],
        actorId: "cutover-test",
      });
      void kept;
    }
    // #1928 M3: the explicit path searches the owned indexed pipeline.
    const { buildRecallProjection } = await import("./recall-projection-build.js");
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const deps = { db, index: new MemoryIndex(db), memoryDir: tmpDir };
    // The cheap pre-check never skips on ready datasets: the retired
    // heuristic corpus cannot judge the new model.
    for (let i = 0; i < 8; i++) {
      db.prepare(
        "INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, semantic_revision) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(OWNER, `stale legacy filler ${i}`, `stale legacy filler ${i}`, "fact", 1000 + i, 1000 + i, 1);
    }
    expect(checkWorthRetrieving(db, { original: "entirely ordinary", userId: OWNER, limit: 5, maxClassification: 2 }).verdict).toBe("search");
    const ambient = await recallSearch(deps, { profile: "recall_fast", translated: ["entirely", "ordinary"], original: "entirely ordinary", intent: "ambient", userId: OWNER, limit: 5, maxClassification: 2 });
    expect(ambient.searchSkipped).toBe(true);
    expect(ambient.results).toHaveLength(0);
    const explicit = await recallSearch(deps, { profile: "recall_fast", translated: ["entirely", "ordinary"], original: "entirely ordinary", intent: "explicit", userId: OWNER, limit: 5, maxClassification: 2 });
    expect(explicit.searchSkipped).not.toBe(true);
    expect(explicit.results.length).toBeGreaterThan(0);
  });
});
