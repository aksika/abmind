import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { seedPersonalReadiness, getPersonalState, setPersonalState } from "./personal-schema.js";
import { storeDurable, supersedeDurable } from "./personal-durable.js";
import { createEpisode } from "./personal-episodes.js";
import { groupExchanges } from "./personal-exchanges.js";
import { selectPrunableMessageIds } from "./personal-retention.js";
import { forgetDigest, forgetPersonal } from "./personal-forget.js";
import { resolveBeliefAsOf, resolveCurrentBelief } from "./personal-beliefs.js";
import { applyPersonalConversion } from "./personal-conversion.js";
import { personalRecall } from "./personal-recall.js";
import { inspectPersonal } from "./personal-controls.js";
import { createBackup, restoreBackup } from "./backup.js";
import { rotateSecretsKeyOnOpen } from "./secret-key-rotation.js";
import { _resetKeyCache } from "./crypto.js";
import { getAbmindEnv } from "./env-schema.js";

let db: Database.Database;
let dir: string;
const owner = "review-owner";
function message(content: string, role = "user", user = owner, ts = 1000): number {
  return Number(db.prepare("INSERT INTO messages (user_id,session_id,role,content,timestamp) VALUES (?, 'review_A_main', ?, ?, ?)").run(user, role, content, ts).lastInsertRowid);
}
function memory(content: string, validFrom = "2020-01-01"): { id: number; revision: number } {
  const id = message(content);
  return storeDurable(db, { userId: owner, memoryType: "fact", content, authority: "inference", authorityBasis: "source", validFrom,
    evidence: [{ kind: "user_message", ref: String(id), excerpt: content, classification: 1 }], actorId: "review" });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "personal-review-"));
  db = initializeDatabase(join(dir, "memory.db"));
  ensureInitialized(db, dir);
  setPersonalState(db, "ready");
});
afterEach(() => { vi.useRealTimers(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("personal implementation review regressions", () => {
  it("retains raw input when a watermark exists without preserved episode evidence", () => {
    for (let i = 0; i < 3; i++) { message(`question ${i}`, "user", owner, i * 1000); message(`response ${i}`, "assistant", owner, i * 1000 + 500); }
    db.prepare("INSERT INTO extraction_watermarks VALUES (?, 10000)").run(owner);
    expect(selectPrunableMessageIds(db, owner, { coveredThroughTs: 10000, targetExchanges: 1 }).messageIds).toEqual([]);
  });
  it("retains input without a current coverage claim even if an old watermark and excerpts exist", () => {
    const u = message("first", "user", owner, 1000), a = message("reply", "assistant", owner, 1500);
    message("next", "user", owner, 2000); message("reply next", "assistant", owner, 2500);
    createEpisode(db, { userId: owner, topic: "first", startTs: 1000, endTs: 1500, sessionIds: ["review_A_main"], sourceMessageIds: [u, a],
      evidenceExcerpts: [{ messageId: u, excerpt: "first", classification: 1 }, { messageId: a, excerpt: "reply", classification: 1 }], actorId: "review" });
    db.prepare("INSERT INTO extraction_watermarks VALUES (?, 10000)").run(owner);
    expect(selectPrunableMessageIds(db, owner, { targetExchanges: 1 }).messageIds).toEqual([]);
    expect(selectPrunableMessageIds(db, owner, { coveredThroughTs: 10000, targetExchanges: 1 }).messageIds).toEqual([u, a]);
  });
  it("keeps interleaved sessions in separate exchanges", () => {
    const rows = [
      { id: 1, session_id: "one", role: "user", timestamp: 1 }, { id: 2, session_id: "two", role: "user", timestamp: 2 },
      { id: 3, session_id: "one", role: "assistant", timestamp: 3 }, { id: 4, session_id: "two", role: "assistant", timestamp: 4 },
    ];
    expect(groupExchanges(rows).map(e => [e.userMessageId, e.responseIds])).toEqual([[1, [3]], [2, [4]]]);
  });
  it("does not use public owner/generation metadata as the forget key", () => {
    const publicGuess = createHmac("sha256", Buffer.from(`personal-forget-v1:${owner}:1`)).update("yes").digest("hex");
    expect(forgetDigest(owner, "yes", db)).not.toBe(publicGuess);
  });
  it("removes retained summaries and derived episode evidence before completing a forget", () => {
    const d = memory("private retained detail");
    const raw = db.prepare("SELECT id FROM messages WHERE user_id = ?").get(owner) as { id: number };
    const episode = createEpisode(db, { userId: owner, topic: "detail", startTs: 1000, endTs: 1000, sessionIds: ["review_A_main"],
      sourceMessageIds: [raw.id], evidenceExcerpts: [{ messageId: raw.id, excerpt: "private retained detail", classification: 1 }], actorId: "review" });
    mkdirSync(join(dir, "daily")); writeFileSync(join(dir, "daily", "summary.md"), "private retained detail");
    const result = forgetPersonal(db, { owner, callerOwner: owner, targets: [{ kind: "durable", id: d.id }], memoryDir: dir, actorId: "review" });
    expect(result.state).toBe("complete");
    expect(db.prepare("SELECT content FROM messages WHERE id = ?").get(raw.id)).toBeUndefined();
    expect(JSON.stringify(db.prepare("SELECT evidence_excerpts FROM short_term_memories WHERE id=?").get(episode.id))).not.toContain("private retained detail");
    const summary = (() => { try { return readFileSync(join(dir, "daily", "summary.md"), "utf8"); } catch { return ""; } })();
    expect(summary).not.toContain("private retained detail");
  });
  it("rejects invented user authority based on another principal's message", () => {
    const id = message("I chose the plan", "user", "another-owner");
    expect(() => storeDurable(db, { userId: owner, memoryType: "decision", content: "approved plan", authority: "confirmed_decision", authorityBasis: "user said",
      evidence: [{ kind: "user_confirmation", ref: String(id), excerpt: "I chose the plan", classification: 1 }], actorId: "review" })).toThrow();
  });
  it("rejects plaintext sealed episode evidence and durable writes without a sealed projection", () => {
    const id = message("exact secret value");
    expect(() => createEpisode(db, { userId: owner, topic: "secret", startTs: 1000, endTs: 1000, sessionIds: ["review_A_main"], sourceMessageIds: [id],
      evidenceExcerpts: [{ messageId: id, excerpt: "exact secret value", classification: 3 }], actorId: "review" })).toThrow();
    expect(() => storeDurable(db, { userId: owner, memoryType: "fact", content: "exact secret value", authority: "inference", authorityBasis: "source", classification: 3,
      evidence: [{ kind: "user_message", ref: String(id), excerpt: "exact secret value", classification: 3 }], actorId: "review" })).toThrow();
  });
  it("bounds historical revisions at correction time instead of resurfacing both forever", () => {
    const d = memory("old home");
    vi.useFakeTimers(); vi.setSystemTime(new Date("2021-01-02T12:00:00Z"));
    const id = message("new home");
    supersedeDurable(db, { userId: owner, memoryId: d.id, expectedRevision: d.revision, content: "new home", authority: "inference", authorityBasis: "correction",
      evidence: [{ kind: "user_message", ref: String(id), excerpt: "new home", classification: 1 }], actorId: "review" });
    const before = resolveBeliefAsOf(db, owner, { scope: "general" }, "2020-06-01");
    expect(before.status).toBe("resolved"); if (before.status === "resolved") expect(before.memory.content).toBe("old home");
    const after = resolveBeliefAsOf(db, owner, { scope: "general" }, "2022-01-01");
    expect(after.status).toBe("resolved"); if (after.status === "resolved") expect(after.memory.content).toBe("new home");
  });
  it("applies a general belief to a more specific request when no exception exists", () => {
    memory("prefers tea");
    expect(resolveCurrentBelief(db, owner, { scope: "work" }).status).toBe("resolved");
  });
  it("a work-only correction preserves the general belief", () => {
    const general = memory("prefers tea");
    const source = message("prefers coffee at work");
    const work = supersedeDurable(db, { userId: owner, memoryId: general.id, expectedRevision: 1, content: "prefers coffee at work", applicabilityScope: { scope: "work" },
      authority: "inference", authorityBasis: "scoped correction", evidence: [{ kind: "user_message", ref: String(source), excerpt: "prefers coffee at work", classification: 1 }], actorId: "review" });
    expect(work.id).not.toBe(general.id);
    const resolvedGeneral = resolveCurrentBelief(db, owner, { scope: "general" });
    expect(resolvedGeneral.status).toBe("resolved");
    if (resolvedGeneral.status === "resolved") expect(resolvedGeneral.memory.content).toBe("prefers tea");
    const resolvedWork = resolveCurrentBelief(db, owner, { scope: "work" });
    expect(resolvedWork.status).toBe("resolved");
    if (resolvedWork.status === "resolved") expect(resolvedWork.memory.content).toBe("prefers coffee at work");
  });
  it("does not activate a conversion whose decisions leave knowledge ambiguous", () => {
    db.prepare("INSERT INTO extracted_memories (user_id,content_original,content_en,source_timestamp,created_at) VALUES (?, 'original', 'legacy knowledge', 1, 1)").run(owner);
    const id = (db.prepare("SELECT id FROM extracted_memories").get() as { id: number }).id;
    setPersonalState(db, "legacy");
    const result = applyPersonalConversion(db, [{ legacyId: id, userId: owner, expectedRevision: 1, action: "ambiguous", rationale: "needs owner" }], { verifiedBackup: true });
    expect(result.ok).toBe(false);
    expect(() => personalRecall(db, owner, "recall_fast", "legacy knowledge")).toThrow();
  });
  it("does not treat an artifact-only store or a missing readiness row as fresh", () => {
    db.prepare("DELETE FROM personal_model_state").run();
    seedPersonalReadiness(db, dir); // seeded core files survived
    expect(getPersonalState(db)?.state).toBe("legacy");
    setPersonalState(db, "ready", { actualVersion: 99 });
    expect(() => personalRecall(db, owner, "recall_fast", "anything")).toThrow();
    setPersonalState(db, "ready");
    memory("retained knowledge");
    db.prepare("DELETE FROM personal_model_state").run();
    seedPersonalReadiness(db); // new-model rows also preclude automatic activation
    expect(getPersonalState(db)?.state).toBe("legacy");
  });
  it("rejects stale conversion review and distinguishes legacy ID 1 from 10", () => {
    for (const id of [1, 10]) db.prepare("INSERT INTO extracted_memories (id,user_id,content_original,content_en,source_timestamp,created_at) VALUES (?, ?, 'original', ?, 1, 1)").run(id, owner, "legacy " + id);
    const decisions = [1, 10].map(legacyId => ({ legacyId, userId: owner, expectedRevision: 1, action: "durable" as const, memoryType: "fact", authority: "inference" as const, rationale: "reviewed" }));
    setPersonalState(db, "legacy");
    expect(applyPersonalConversion(db, decisions.map(d => ({ ...d, expectedRevision: 2 })), { verifiedBackup: true }).ok).toBe(false);
    expect(applyPersonalConversion(db, decisions, { verifiedBackup: true }).ok).toBe(true);
    expect(applyPersonalConversion(db, decisions, { verifiedBackup: true }).ok).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM long_term_memories").get() as { n: number }).n).toBe(2);
  });
  it("full recall expands authorized excerpts without exposing the rest of a raw secret message", () => {
    const id = message("Berlin travel. secret-value-do-not-expose");
    storeDurable(db, { userId: owner, memoryType: "fact", content: "Berlin travel", authority: "inference", authorityBasis: "source",
      evidence: [{ kind: "user_message", ref: String(id), excerpt: "Berlin travel", classification: 1 }], actorId: "review" });
    const result = personalRecall(db, owner, "recall_full", "Berlin");
    expect(result.hits.some(h => h.layer === "raw")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("secret-value-do-not-expose");
    db.prepare("INSERT INTO extracted_memories (user_id,content_original,content_en,source_message_ids,classification,source_timestamp,created_at) VALUES (?, 'sealed', 'sealed', ?, 3, 1, 1)").run(owner, JSON.stringify([id]));
    expect(personalRecall(db, owner, "recall_full", "Berlin").hits.some(h => h.layer === "raw")).toBe(false);
    expect(inspectPersonal(db, owner, { layer: "raw", id }).found).toBe(false);
  });
  it("restores neither a forgotten durable nor its revisions or pre-forget summary files", () => {
    const d = memory("old private address");
    const id = message("new private address");
    supersedeDurable(db, { userId: owner, memoryId: d.id, expectedRevision: 1, content: "new private address", authority: "inference", authorityBasis: "corrected",
      evidence: [{ kind: "user_message", ref: String(id), excerpt: "new private address", classification: 1 }], actorId: "review" });
    mkdirSync(join(dir, "daily")); writeFileSync(join(dir, "daily", "before.md"), "new private address");
    const path = join(dir, "before.abm"); createBackup(db, dir, undefined, path);
    const request = { owner, callerOwner: owner, targets: [{ kind: "durable" as const, id: d.id }], memoryDir: dir, actorId: "review" };
    const forgotten = forgetPersonal(db, request);
    expect(forgetPersonal(db, request)).toEqual(forgotten);
    for (const mode of ["merge", "replace"] as const) {
      restoreBackup(db, dir, undefined, path, mode);
      expect(db.prepare("SELECT 1 FROM long_term_memories WHERE id = ?").get(d.id)).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM long_term_revisions WHERE memory_id = ?").get(d.id)).toBeUndefined();
      expect(db.prepare("SELECT 1 FROM messages WHERE user_id = ?").get(owner)).toBeUndefined();
      expect(() => readFileSync(join(dir, "daily", "before.md"))).toThrow();
    }
  });
  it("refuses legacy key rotation before it can invalidate personal forgetting keys", () => {
    const d = memory("forgotten detail");
    expect(forgetPersonal(db, { owner, callerOwner: owner, targets: [{ kind: "durable", id: d.id }], memoryDir: dir, actorId: "review" }).state).toBe("complete");
    const before = db.prepare("SELECT * FROM secret_key_state").all();
    const result = rotateSecretsKeyOnOpen(db, { dbPath: join(dir, "memory.db"), oldMasterKey: Buffer.alloc(32, 1), newMasterKey: Buffer.alloc(32, 2), writeKeyMaterial: true });
    expect(result).toEqual({ ok: false, refused: expect.stringContaining("Personal forgetting/sealed key rotation is not implemented") });
    expect(db.prepare("SELECT * FROM secret_key_state").all()).toEqual(before);
  });
  it("refuses a backup whose forgetting markers belong to a different protected key", () => {
    const d = memory("forgotten detail");
    forgetPersonal(db, { owner, callerOwner: owner, targets: [{ kind: "durable", id: d.id }], memoryDir: dir, actorId: "review" });
    const path = join(dir, "marked.abm"); createBackup(db, dir, "review-backup-passphrase", path, { dbOnly: true });
    const keyFile = getAbmindEnv().keyFile, original = readFileSync(keyFile);
    try {
      writeFileSync(keyFile, Buffer.alloc(32, 4).toString("hex")); _resetKeyCache();
      expect(() => restoreBackup(db, dir, "review-backup-passphrase", path, "replace")).toThrow("trusted personal forgetting key");
      expect(getPersonalState(db)?.state).toBe("interrupted");
    } finally { writeFileSync(keyFile, original); _resetKeyCache(); }
  });
});
