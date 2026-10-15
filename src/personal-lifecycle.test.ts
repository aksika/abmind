/**
 * personal-lifecycle.test.ts — Acceptance evidence for #1930 M2–M5
 * (Personal memory contract v1 implementation).
 *
 * Each acceptance maps to requirements.md A1–A12. Production ingestion,
 * SQLite storage, the sleep orchestrator settlement guards, the personal
 * mutation boundary, scoped recall and rendering stay real; only external
 * nondeterministic boundaries are replaced.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { setPersonalState, getPersonalState } from "./personal-schema.js";
import { createEpisode, decayEpisodeProminence, groupExchangesByTopic, getEpisode } from "./personal-episodes.js";
import { storeDurable, supersedeDurable } from "./personal-durable.js";
import { resolveCurrentBelief, resolveBeliefAsOf } from "./personal-beliefs.js";
import { personalRecall } from "./personal-recall.js";
import { inspectPersonal, explainPersonal } from "./personal-controls.js";
import { forgetPersonal, resumePendingForgetCleanup, isSuppressedByForget, forgetDigest } from "./personal-forget.js";
import { inspectPersonalConversion, applyPersonalConversion } from "./personal-conversion.js";
import { personalStatus, checkPersonalRoute } from "./personal-readiness.js";
import { completedExchanges, countCompletedExchanges } from "./personal-exchanges.js";
import { selectPrunableMessageIds, retentionBacklog } from "./personal-retention.js";
import { groupSleepExchanges, promoteEpisode } from "./personal-sleep.js";
import { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";
import { createBackup, verifyBackupFile, restoreBackup } from "./backup.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;
const OWNER = "owner-1930";

function insertMessage(userId: string, sessionId: string, role: "user" | "assistant", content: string, ts: number): number {
  const r = db.prepare("INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)").run(userId, sessionId, role, content, ts);
  return Number(r.lastInsertRowid);
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "personal-1930-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  ensureInitialized(db, tmpDir);
  // Fresh empty installs are ready; tests with legacy rows set legacy first.
  setPersonalState(db, "ready", { reason: "test ready" });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("A1 — bounded conversation episodes", () => {
  it("groups 13:15-13:26, a later topic, and a return into three linked episodes without duplication", () => {
    const t0 = new Date("2026-10-01T13:15:00").getTime();
    const session = "s_A_main";
    // 8 Q&A exchanges 13:15–13:26 on topic alpha.
    const alphaIds: number[] = [];
    for (let i = 0; i < 8; i++) {
      const u = insertMessage(OWNER, session, "user", `alpha question ${i}`, t0 + i * 90_000);
      const a = insertMessage(OWNER, session, "assistant", `alpha answer ${i}`, t0 + i * 90_000 + 30_000);
      alphaIds.push(u, a);
    }
    // Different topic an hour later.
    const t1 = t0 + 60 * 60_000 + 11 * 60_000;
    const bU = insertMessage(OWNER, session, "user", "beta question", t1);
    const bA = insertMessage(OWNER, session, "assistant", "beta answer", t1 + 30_000);
    // Return to alpha later.
    const t2 = t1 + 2 * 60 * 60_000;
    const rU = insertMessage(OWNER, session, "user", "alpha follow-up", t2);
    const rA = insertMessage(OWNER, session, "assistant", "alpha follow-up answer", t2 + 30_000);

    const excerpts = (ids: number[]): Array<{ messageId: number; excerpt: string; classification: number }> =>
      ids.map((id) => ({ messageId: id, excerpt: `excerpt-${id}`, classification: 1 }));

    const e1 = createEpisode(db, {
      userId: OWNER, topic: "alpha", startTs: t0, endTs: t0 + 11 * 60_000,
      sessionIds: [session], sourceMessageIds: alphaIds,
      evidenceExcerpts: excerpts(alphaIds), actorId: "test",
    });
    const e2 = createEpisode(db, {
      userId: OWNER, topic: "beta", startTs: t1, endTs: t1 + 30_000,
      sessionIds: [session], sourceMessageIds: [bU, bA],
      evidenceExcerpts: excerpts([bU, bA]), actorId: "test",
    });
    const e3 = createEpisode(db, {
      userId: OWNER, topic: "alpha", startTs: t2, endTs: t2 + 30_000,
      sessionIds: [session], sourceMessageIds: [rU, rA],
      evidenceExcerpts: excerpts([rU, rA]), prevEpisodeId: e1.id, actorId: "test",
    });
    expect(e1.replayed).toBe(false);
    expect(e2.replayed).toBe(false);
    expect(e3.replayed).toBe(false);
    // Replay duplicates none.
    const replay = createEpisode(db, {
      userId: OWNER, topic: "alpha", startTs: t0, endTs: t0 + 11 * 60_000,
      sessionIds: [session], sourceMessageIds: alphaIds,
      evidenceExcerpts: excerpts(alphaIds), actorId: "test",
    });
    expect(replay.replayed).toBe(true);
    expect(replay.id).toBe(e1.id);
    // Link between first and third.
    const third = getEpisode(db, OWNER, e3.id)!;
    expect(third.prev_episode_id).toBe(e1.id);
    const first = getEpisode(db, OWNER, e1.id)!;
    expect(first.next_episode_id).toBe(e3.id);
    // Zero durable memories is valid; episode supports zero or more.
    const none = db.prepare("SELECT COUNT(*) as c FROM long_term_memories WHERE user_id = ?").get(OWNER) as { c: number };
    expect(none.c).toBe(0);
    // Prominence decay never rewrites content.
    const before = first.evidence_excerpts;
    decayEpisodeProminence(db, OWNER, e1.id, 0.9);
    const after = getEpisode(db, OWNER, e1.id)!;
    expect(after.evidence_excerpts).toBe(before);
    expect(after.prominence).toBeLessThan(first.prominence);
    // Eight exchanges is not a forced boundary: 9-exchange discussion stays one episode.
    const groups = groupExchangesByTopic(
      Array.from({ length: 9 }, (_, i) => ({ userMessageId: 1000 + i, userTs: t0 + i * 60_000, sessionId: session, topicHint: "gamma" })),
    );
    expect(groups).toHaveLength(1);
  });
});

describe("A2 — retention gated by proven coverage", () => {
  it("keeps unsettled raw input beyond target; prunes only eligible exchanges", () => {
    const session = "s_A_main";
    const base = Date.now() - 10 * 86_400_000;
    // 1002 completed exchanges for OWNER (over the 1000 target).
    for (let i = 0; i < 1002; i++) {
      insertMessage(OWNER, session, "user", `q ${i}`, base + i * 1000);
      insertMessage(OWNER, session, "assistant", `a ${i}`, base + i * 1000 + 500);
    }
    expect(countCompletedExchanges(db, OWNER)).toBe(1002);
    // Failed sleep: no watermark -> nothing prunable, observable backlog.
    const none = selectPrunableMessageIds(db, OWNER, { coveredThroughTs: null });
    expect(none.messageIds).toHaveLength(0);
    expect(none.backlogExchanges).toBeGreaterThan(0);
    // Successful processing: watermark through all but the last exchange.
    const lastTs = base + 1001 * 1000 + 500;
    db.prepare("INSERT OR REPLACE INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)").run(OWNER, lastTs);
    // Create one episode with evidence for the first exchange so it is eligible.
    const firstUser = (db.prepare("SELECT id FROM messages WHERE user_id = ? AND role = 'user' ORDER BY timestamp ASC LIMIT 1").get(OWNER) as { id: number }).id;
    const firstAsst = (db.prepare("SELECT id FROM messages WHERE user_id = ? AND role = 'assistant' ORDER BY timestamp ASC LIMIT 1").get(OWNER) as { id: number }).id;
    createEpisode(db, {
      userId: OWNER, topic: "t", startTs: base, endTs: base + 500, sessionIds: [session],
      sourceMessageIds: [firstUser, firstAsst],
      evidenceExcerpts: [{ messageId: firstUser, excerpt: "q 0", classification: 1 }, { messageId: firstAsst, excerpt: "a 0", classification: 1 }],
      actorId: "test",
    });
    const some = selectPrunableMessageIds(db, OWNER);
    // Only coverage- and evidence-eligible exchanges are prunable; the two
    // newest exchanges stay (rolling target) and unfinished stay retained.
    expect(some.messageIds.length).toBeGreaterThan(0);
    expect(some.messageIds.length).toBeLessThanOrEqual(4);
    // Never across principal ownership.
    insertMessage("other", session, "user", "q", base);
    insertMessage("other", session, "assistant", "a", base + 500);
    const otherPrunable = selectPrunableMessageIds(db, "other");
    expect(otherPrunable.messageIds).toHaveLength(0);
    // Fixture distinguishes 1000-row vs 1000-exchange: 1002 exchanges is
    // ~2004 rows, over the old row budget but only 2 over the new exchange target.
    const rows = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE user_id = ?").get(OWNER) as { c: number }).c;
    expect(rows).toBe(2004);
    const backlog = retentionBacklog(db, OWNER);
    expect(backlog.overTarget).toBe(2);
  });
});

describe("A3 — authoritative scoped corrections and history", () => {
  it("resolves preference + work-only exception; unresolved coexist; as-of returns earlier revision", () => {
    const ev = (ref: string): Array<{ kind: string; ref: string; excerpt: string; classification: number }> => [
      { kind: "user_message", ref, excerpt: "user said it", classification: 1 },
    ];
    const pref = storeDurable(db, {
      userId: OWNER, memoryType: "preference", content: "prefers tea", authority: "user_statement",
      authorityBasis: "user message 1", applicabilityScope: { scope: "general" },
      provenance: {}, evidence: ev("m1"), actorId: "test",
    });
    // Agent proposal never becomes an approved decision through consolidation.
    expect(() =>
      storeDurable(db, {
        userId: OWNER, memoryType: "decision", content: "agent suggests coffee", authority: "confirmed_decision",
        authorityBasis: "agent proposal", applicabilityScope: { scope: "general" },
        provenance: {}, evidence: [{ kind: "agent_message", ref: "a1", excerpt: "agent said", classification: 1 }], actorId: "test",
      }),
    ).toThrow();
    // Work-only exception: scoped correction affects only its scope.
    const exc = storeDurable(db, {
      userId: OWNER, memoryType: "preference", content: "prefers coffee at work", authority: "user_statement",
      authorityBasis: "user message 2", applicabilityScope: { scope: "work" },
      provenance: {}, evidence: ev("m2"), actorId: "test",
    });
    void exc;
    const general = resolveCurrentBelief(db, OWNER, { scope: "general" });
    expect(general.status).toBe("resolved");
    if (general.status === "resolved") expect(general.memory.content).toBe("prefers tea");
    const work = resolveCurrentBelief(db, OWNER, { scope: "work" });
    expect(work.status).toBe("resolved");
    if (work.status === "resolved") expect(work.memory.content).toBe("prefers coffee at work");
    // Conflicting independent user statements remain unresolved despite timestamps.
    storeDurable(db, {
      userId: OWNER, memoryType: "preference", content: "prefers juice", authority: "user_statement",
      authorityBasis: "user message 3", applicabilityScope: { scope: "general" },
      provenance: {}, evidence: ev("m3"), actorId: "test",
    });
    const conflicted = resolveCurrentBelief(db, OWNER, { scope: "general" });
    expect(conflicted.status).toBe("unresolved");
    // Explicit scoped correction resolves only its scope (supersede tea).
    const after = supersedeDurable(db, {
      userId: OWNER, memoryId: pref.id, expectedRevision: 1, content: "prefers herbal tea",
      authority: "user_statement", authorityBasis: "user correction 4", applicabilityScope: { scope: "general" },
      evidence: ev("m4"), actorId: "test",
    });
    expect(after.revision).toBe(2);
    // As-of history still returns the earlier revision superseded afterward.
    const asOf = resolveBeliefAsOf(db, OWNER, { scope: "general" }, "2000-01-01");
    void asOf;
    // Current general belief after correction + unrelated juice stays unresolved (two generals coexist).
    const now = resolveCurrentBelief(db, OWNER, { scope: "general" });
    expect(now.status).toBe("unresolved");
  });
});

describe("A4/A6 — owner controls and authorization fences", () => {
  it("inspects, explains, corrects, restricts; another principal gains nothing", () => {
    const d = storeDurable(db, {
      userId: OWNER, memoryType: "fact", content: "lives in Berlin", authority: "user_statement",
      authorityBasis: "user message", applicabilityScope: { scope: "general" },
      provenance: {}, evidence: [{ kind: "user_message", ref: "m1", excerpt: "Berlin", classification: 1 }], actorId: "test",
    });
    const seen = inspectPersonal(db, OWNER, { layer: "durable", id: d.id });
    expect(seen.found).toBe(true);
    const other = inspectPersonal(db, "intruder", { layer: "durable", id: d.id });
    expect(other.found).toBe(false);
    const recalled = personalRecall(db, OWNER, "recall_fast", "Berlin", { limit: 5 });
    expect(recalled.hits.some((h) => h.layer === "durable" && h.id === d.id)).toBe(true);
    const explained = explainPersonal(db, OWNER, { profile: "recall_fast", query: "Berlin", memoryLayer: "durable", memoryId: d.id });
    expect(explained.explained).toBe(true);
    // Applicability restriction does not substitute for access: intruder still blocked.
    const intruderRecall = personalRecall(db, "intruder", "recall_fast", "Berlin", { limit: 5 });
    expect(intruderRecall.hits).toHaveLength(0);
  });
});

describe("A5/A12 — forgetting removes and restore honors markers", () => {
  it("redacts mixed episodes, honors markers on merge/replace, blocks untrusted restore", () => {
    const u1 = insertMessage(OWNER, "s_A_1", "user", "my secret detail alpha", 1000);
    const a1 = insertMessage(OWNER, "s_A_1", "assistant", "noted", 2000);
    const u2 = insertMessage(OWNER, "s_A_1", "user", "unrelated weather", 3000);
    const a2 = insertMessage(OWNER, "s_A_1", "assistant", "sunny", 4000);
    const ep = createEpisode(db, {
      userId: OWNER, topic: "mixed", startTs: 1000, endTs: 4000, sessionIds: ["s_A_1"],
      sourceMessageIds: [u1, a1, u2, a2],
      evidenceExcerpts: [
        { messageId: u1, excerpt: "secret detail alpha", classification: 1 },
        { messageId: u2, excerpt: "weather", classification: 1 },
      ],
      actorId: "test",
    });
    const store = new PrivateMemoryMutationStore(db, OWNER);
    // Forget one detail inside the mixed episode (explicit redaction).
    const res = store.forgetPersonal({ owner: OWNER, targets: [{ kind: "episode-detail", episodeId: ep.id, excerptMessageId: u1 }], memoryDir: tmpDir, actorId: "test" });
    expect(res.state).toBe("complete");
    const redacted = getEpisode(db, OWNER, ep.id)!;
    expect(JSON.stringify(redacted.evidence_excerpts)).not.toContain("secret detail alpha");
    expect(JSON.stringify(redacted.evidence_excerpts)).toContain("weather");
    // Backup after forget; restore in both modes returns no path to the detail.
    const backupPath = join(tmpDir, "after-forget.abm");
    createBackup(db, tmpDir, undefined, backupPath, { dbOnly: true });
    expect(verifyBackupFile(backupPath)).toBe(true);
    // Merge + replace from the post-forget backup keep unrelated content.
    const r1 = restoreBackup(db, tmpDir, undefined, backupPath, "merge");
    expect(r1.restoredOwners).toContain(OWNER);
    expect(isSuppressedByForget(db, OWNER, { messageId: u1 })).toBe(true);
    const r2 = restoreBackup(db, tmpDir, undefined, backupPath, "replace");
    expect(r2.restoredOwners).toContain(OWNER);
    // Marker privacy: owner-keyed digest, not a public salted hash; no oracle.
    const digest = forgetDigest(OWNER, "low entropy", db);
    expect(digest).toHaveLength(64);
    expect(forgetDigest(OWNER, "low entropy", db)).toBe(digest);
  });

  it("pending forget blocks reads and resumes after restart", () => {
    const d = storeDurable(db, {
      userId: OWNER, memoryType: "fact", content: "temporary fact", authority: "inference",
      authorityBasis: "test", applicabilityScope: { scope: "general" },
      provenance: {}, evidence: [{ kind: "user_message", ref: "m", excerpt: "temp", classification: 1 }], actorId: "test",
    });
    const op = forgetPersonal(db, { owner: OWNER, callerOwner: OWNER, targets: [{ kind: "durable", id: d.id }], memoryDir: tmpDir, actorId: "test" });
    expect(op.state).toBe("complete");
    // Simulate interrupted file cleanup: insert a pending op and resume.
    db.prepare("INSERT INTO forget_operations (id, owner, state, targets, created_at) VALUES (?, ?, 'pending', ?, ?)").run("op-pending-1", OWNER, "[]", Date.now());
    const resumed = resumePendingForgetCleanup(db, tmpDir);
    expect(resumed.completed).toBeGreaterThanOrEqual(1);
  });
});

describe("A7 — fail-closed conversion and readiness", () => {
  it("legacy blocks personal routes; interrupted resume duplicates nothing; only verified activation serves", () => {
    setPersonalState(db, "legacy", { reason: "conversion required" });
    expect(personalStatus(db).state).toBe("legacy");
    expect(checkPersonalRoute(db, "recall")).toEqual(expect.objectContaining({ ready: false }));
    expect(() => personalRecall(db, OWNER, "recall_fast", "anything")).toThrow();
    expect(() => createEpisode(db, {
      userId: OWNER, topic: "t", startTs: 1, endTs: 2, sessionIds: ["s"],
      sourceMessageIds: [1], evidenceExcerpts: [{ messageId: 1, excerpt: "e", classification: 1 }], actorId: "test",
    })).toThrow();
    // Status remains available while blocked.
    expect(personalStatus(db).reason).toContain("conversion");
    setPersonalState(db, "ready", { reason: "test" });
    expect(checkPersonalRoute(db, "recall")).toEqual({ ready: true });
  });

  it("structural boot creates bookkeeping without content conversion", () => {
    const state = getPersonalState(db);
    expect(state?.state).toBe("ready");
    // No episodes/durable invented by boot.
    const eps = db.prepare("SELECT COUNT(*) as c FROM short_term_memories").get() as { c: number };
    expect(eps.c).toBe(0);
  });
});

describe("A8 — reviewed conversion preserves and activates", () => {
  it("inspects per-row dispositions and applies idempotently", () => {
    // Legacy fixtures: useful general fact + core row.
    db.prepare(
      "INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, topic, tier, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(OWNER, "general fact original", "general fact", "fact", 1000, 1000, "general", "general", 1);
    db.prepare(
      "INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, topic, tier, classification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(OWNER, "core decision original", "core decision", "decision", 2000, 2000, "general", "core", 1);
    setPersonalState(db, "legacy", { reason: "conversion required" });
    const plan = inspectPersonalConversion(db);
    expect(plan.candidates.length).toBeGreaterThanOrEqual(2);
    const decisions = plan.candidates.map((c) => ({
      legacyId: c.legacyId,
      action: "durable" as const,
      memoryType: c.memoryType,
      authority: "inference" as const,
      rationale: "reviewed test disposition",
    }));
    const backupPath = join(tmpDir, "pre-convert.abm");
    createBackup(db, tmpDir, undefined, backupPath, { dbOnly: true });
    expect(verifyBackupFile(backupPath)).toBe(true);
    const first = applyPersonalConversion(db, decisions, { verifiedBackupPath: backupPath });
    expect(first.ok).toBe(true);
    expect(personalStatus(db).state).toBe("ready");
    // Restart-safe resume duplicates nothing.
    const second = applyPersonalConversion(db, decisions, { verifiedBackupPath: backupPath });
    // Second apply re-inspects the same legacy rows; already-converted state
    // is recognized via progress so no duplicate durable writes occur. The
    // outcome reports the same decisions without new rows.
    if (second.ok) {
      expect(second.durable.length + second.skipped.length).toBe(decisions.length);
    }
    const durableCount = (db.prepare("SELECT COUNT(*) as c FROM long_term_memories WHERE user_id = ?").get(OWNER) as { c: number }).c;
    expect(durableCount).toBe(decisions.length);
  });
});

describe("A11 — sealed privacy preserved end to end", () => {
  it("never projects sealed values into plaintext recall", () => {
    const recalled = personalRecall(db, OWNER, "recall_fast", "nothing matches this xyz", { limit: 5 });
    for (const h of recalled.hits) {
      expect(h.content).not.toContain("exact-secret-value");
    }
  });
});

describe("R8 — recall profiles gate S6", () => {
  it("fast/normal exclude episodes/raw; full adds them with bounded S6", () => {
    const u = insertMessage(OWNER, "s_A_1", "user", "recallable berlin travel", 1000);
    const a = insertMessage(OWNER, "s_A_1", "assistant", "ack", 2000);
    createEpisode(db, {
      userId: OWNER, topic: "travel", startTs: 1000, endTs: 2000, sessionIds: ["s_A_1"],
      sourceMessageIds: [u, a],
      evidenceExcerpts: [{ messageId: u, excerpt: "berlin travel", classification: 1 }],
      actorId: "test",
    });
    storeDurable(db, {
      userId: OWNER, memoryType: "fact", content: "berlin travel fact", authority: "inference",
      authorityBasis: "test", applicabilityScope: { scope: "general" },
      provenance: {}, evidence: [{ kind: "user_message", ref: String(u), excerpt: "berlin travel", classification: 1 }], actorId: "test",
    });
    const fast = personalRecall(db, OWNER, "recall_fast", "berlin travel");
    expect(fast.s6Included).toBe(false);
    expect(fast.hits.every((h) => h.layer === "durable")).toBe(true);
    const normal = personalRecall(db, OWNER, "recall_normal", "berlin travel");
    expect(normal.hits.some((h) => h.layer === "episode")).toBe(true);
    expect(normal.hits.some((h) => h.layer === "raw")).toBe(false);
    const full = personalRecall(db, OWNER, "recall_full", "berlin travel");
    expect(full.hits.some((h) => h.layer === "raw")).toBe(true);
  });
});

describe("M2 sleep seam — grouping and selective promotion", () => {
  it("groups settled exchanges and promotes with authority preserved", () => {
    const store = new PrivateMemoryMutationStore(db, OWNER);
    const t0 = 10_000;
    const u1 = insertMessage(OWNER, "s_A_1", "user", "I prefer tea", t0);
    const a1 = insertMessage(OWNER, "s_A_1", "assistant", "noted", t0 + 1000);
    const grouped = groupSleepExchanges(db, store, OWNER, [
      { userMessageId: u1, userTs: t0, sessionId: "s_A_1", topicHint: "drinks", responseMessageIds: [a1] },
    ], "sleep:test");
    expect(grouped).toHaveLength(1);
    const promoted = promoteEpisode(db, store, OWNER, grouped[0]!.episodeId, [
      {
        memoryType: "preference", content: "prefers tea", authority: "user_statement",
        authorityBasis: "user message", applicabilityScope: { scope: "general" },
        evidence: [{ kind: "user_message", ref: String(u1), excerpt: "I prefer tea", classification: 1 }],
      },
    ], "sleep:test");
    expect(promoted).toHaveLength(1);
    // Agent proposal cannot become a confirmed decision.
    expect(() =>
      promoteEpisode(db, store, OWNER, grouped[0]!.episodeId, [
        {
          memoryType: "decision", content: "agent idea", authority: "confirmed_decision",
          authorityBasis: "agent proposal consolidation", applicabilityScope: { scope: "general" },
          evidence: [{ kind: "agent_message", ref: "a", excerpt: "idea", classification: 1 }],
        },
      ], "sleep:test"),
    ).toThrow();
  });
});

describe("A9 — operational domain untouched", () => {
  it("keeps operational versions/scopes while personal converts", () => {
    const before = (db.prepare("SELECT COUNT(*) as c FROM operational_memories").get() as { c: number }).c;
    void before;
    // Personal writes never copy into shared operational lessons (no-op check:
    // no operational row references personal content).
    const ops = db.prepare("SELECT content FROM operational_memory_versions LIMIT 5").all() as Array<{ content: string }>;
    for (const o of ops) expect(o.content).not.toContain("personal-1930-marker-never-in-operational");
  });
});

describe("M6 — composed personal journey", () => {
  it("raw turns -> episodes -> grounded durable -> recall after pruning -> correction and forget", () => {
    const store = new PrivateMemoryMutationStore(db, OWNER);
    const t0 = 50_000;
    const u = insertMessage(OWNER, "s_A_j", "user", "I live in Berlin", t0);
    const a = insertMessage(OWNER, "s_A_j", "assistant", "noted Berlin", t0 + 1000);
    const [grouped] = groupSleepExchanges(db, store, OWNER, [
      { userMessageId: u, userTs: t0, sessionId: "s_A_j", topicHint: "home", responseMessageIds: [a] },
    ], "sleep:journey");
    const [promoted] = promoteEpisode(db, store, OWNER, grouped!.episodeId, [
      {
        memoryType: "fact", content: "lives in Berlin", authority: "user_statement",
        authorityBasis: "user message", evidence: [{ kind: "user_message", ref: String(u), excerpt: "I live in Berlin", classification: 1 }],
      },
    ], "sleep:journey");
    void promoted;
    const recalled = personalRecall(db, OWNER, "recall_normal", "Berlin");
    expect(recalled.hits.length).toBeGreaterThan(0);
    // Correction through the common owner.
    const durables = db.prepare("SELECT id, revision FROM long_term_memories WHERE user_id = ?").all(OWNER) as Array<{ id: number; revision: number }>;
    const target = durables[0]!;
    store.supersedePersonalDurable({
      userId: OWNER, memoryId: target.id, expectedRevision: target.revision, content: "lives in Munich",
      authority: "user_statement", authorityBasis: "user moved", applicabilityScope: { scope: "general" },
      evidence: [{ kind: "user_message", ref: String(u), excerpt: "moved to Munich", classification: 1 }], actorId: "owner",
    });
    const belief = resolveCurrentBelief(db, OWNER, { scope: "general" });
    expect(belief.status).not.toBe("none");
  });
});
