/**
 * personal-reown.test.ts — single-master Tier 2/3 enforcement (#1930 M5
 * follow-up, #1931 disposition). Non-primary episodes/durables move to the
 * manifest primary or the apply refuses; exact replay is a no-op.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { setPersonalState } from "./personal-schema.js";
import { encrypt, decrypt } from "./crypto.js";
import { inspectReown, applyPersonalReown, type ReownDecision } from "./personal-reown.js";
import { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";
import { PrimaryIdentityError } from "./user-utils.js";
import type Database from "better-sqlite3";

let tmpDir: string;
let db: Database.Database;
const OWNER = "owner-1930";
const OTHER = "other-owner-1930";
const PRIOR_ENV = process.env["ABMIND_USER_ID"];

function seedDurable(userId: string, content: string, extra?: { classification?: number; sealed?: boolean; provenance?: string }): number {
  const sealed = extra?.sealed ?? false;
  const payload = sealed ? encrypt(content) : content;
  const r = db.prepare(
    "INSERT INTO long_term_memories (user_id, memory_type, content, content_original, authority, applicability_scope, provenance, evidence, classification, encrypted, sealed_format_version, semantic_revision, created_at, updated_at) VALUES (?, 'fact', ?, ?, 'inference', '{\"scope\":\"general\"}', ?, '[]', ?, ?, ?, 1, 1, 1)",
  ).run(userId, sealed ? "sealed label" : content, payload,
    extra?.provenance ?? JSON.stringify({ legacyId: 100 + Math.floor(Math.random() * 1000) }),
    extra?.classification ?? 1, sealed ? 1 : 0, sealed ? 1 : 0);
  return Number(r.lastInsertRowid);
}

function seedEpisode(userId: string): number {
  const r = db.prepare(
    "INSERT INTO short_term_memories (user_id, topic, start_ts, end_ts, session_ids, source_message_ids, grouping_hash, evidence_excerpts, created_at, updated_at) VALUES (?, 'topic', 1, 2, '[]', '[]', ?, '[]', 1, 1)",
  ).run(userId, `hash-${userId}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  return Number(r.lastInsertRowid);
}

function decisionsFor(plan: ReturnType<typeof inspectReown>, rationale: string): ReownDecision[] {
  return plan.candidates.map((c) => ({
    kind: c.kind, id: c.id, sourceOwner: c.sourceOwner, expectedRevision: c.revision, rationale,
  }));
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "personal-reown-"));
  db = initializeDatabase(join(tmpDir, "memory.db"));
  ensureInitialized(db, tmpDir);
  setPersonalState(db, "ready", { reason: "test ready" });
  process.env["ABMIND_USER_ID"] = OWNER;
});

afterEach(() => {
  if (PRIOR_ENV === undefined) delete process.env["ABMIND_USER_ID"];
  else process.env["ABMIND_USER_ID"] = PRIOR_ENV;
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("re-own inspect", () => {
  it("lists only non-primary rows without content or sealed values", () => {
    const mine = seedDurable(OWNER, "mine");
    const foreign = seedDurable(OTHER, "foreign fact");
    const plan = inspectReown(db, OWNER);
    expect(plan.primaryOwner).toBe(OWNER);
    expect(plan.candidates.map((c) => c.id)).toEqual([foreign]);
    expect(JSON.stringify(plan)).not.toContain("foreign fact");
    expect(plan.candidates[0]?.sourceOwner).toBe(OTHER);
    expect(mine).toBeGreaterThan(0);
  });

  it("requires a manifest-resolved canonical owner", () => {
    seedDurable(OTHER, "foreign fact");
    expect(() => inspectReown(db, "")).toThrow();
    expect(applyPersonalReown(db, [], { verifiedBackup: true }).ok).toBe(false);
  });
});

describe("re-own apply", () => {
  it("moves durables and episodes, preserves sealed bytes, keeps counts", () => {
    const foreign = seedDurable(OTHER, "foreign fact", { provenance: JSON.stringify({ legacyId: 496 }) });
    const sealed = seedDurable(OTHER, "exact secret", { sealed: true, classification: 3 });
    const sealedBefore = db.prepare("SELECT content_original, evidence FROM long_term_memories WHERE id = ?").get(sealed) as { content_original: string; evidence: string };
    const episode = seedEpisode(OTHER);
    const mine = seedDurable(OWNER, "mine");
    const plan = inspectReown(db, OWNER);
    expect(plan.candidates.length).toBe(3);
    const result = applyPersonalReown(db, decisionsFor(plan, "single-master doctrine"), { verifiedBackup: true, primaryOwner: OWNER });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.reowned.length).toBe(3);
    for (const id of [foreign, sealed, mine]) {
      const row = db.prepare("SELECT user_id FROM long_term_memories WHERE id = ?").get(id) as { user_id: string };
      expect(row.user_id).toBe(OWNER);
    }
    const sealedAfter = db.prepare("SELECT content_original, evidence, classification, encrypted, sealed_format_version FROM long_term_memories WHERE id = ?").get(sealed) as typeof sealedBefore & { classification: number; encrypted: number; sealed_format_version: number };
    expect(sealedAfter.content_original).toBe(sealedBefore.content_original);
    expect(sealedAfter.evidence).toBe(sealedBefore.evidence);
    expect(sealedAfter.classification).toBe(3);
    expect(sealedAfter.encrypted).toBe(1);
    expect(sealedAfter.sealed_format_version).toBe(1);
    expect(decrypt(sealedAfter.content_original)).toBe("exact secret");
    const prov = JSON.parse((db.prepare("SELECT provenance FROM long_term_memories WHERE id = ?").get(foreign) as { provenance: string }).provenance) as { legacyId: number; reownedFrom: { owner: string } };
    expect(prov.legacyId).toBe(496);
    expect(prov.reownedFrom.owner).toBe(OTHER);
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c).toBe(3);
    const epOwner = (db.prepare("SELECT user_id FROM short_term_memories WHERE id = ?").get(episode) as { user_id: string }).user_id;
    expect(epOwner).toBe(OWNER);
  });

  it("replays exactly without changes", () => {
    const foreign = seedDurable(OTHER, "foreign fact");
    const episode = seedEpisode(OTHER);
    const plan = inspectReown(db, OWNER);
    const decisions = decisionsFor(plan, "single-master doctrine");
    const first = applyPersonalReown(db, decisions, { verifiedBackup: true, primaryOwner: OWNER });
    expect(first.ok).toBe(true);
    const replay = applyPersonalReown(db, decisions, { verifiedBackup: true, primaryOwner: OWNER });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.reowned).toHaveLength(0);
      expect(replay.skipped.map((s) => s.id).sort((a, b) => a - b)).toEqual([foreign, episode].sort((a, b) => a - b));
    }
  });

  it("refuses a replay whose row no longer matches the transition", () => {
    const foreign = seedDurable(OTHER, "foreign fact");
    const plan = inspectReown(db, OWNER);
    const decisions = decisionsFor(plan, "single-master doctrine");
    expect(applyPersonalReown(db, decisions, { verifiedBackup: true, primaryOwner: OWNER }).ok).toBe(true);
    // The row is primary-owned but its recorded transition no longer matches
    // the decision (different claimed source), so replay must refuse.
    const tampered = decisions.map((d) => d.id === foreign ? { ...d, sourceOwner: "someone-else" } : d);
    expect(applyPersonalReown(db, tampered, { verifiedBackup: true, primaryOwner: OWNER }).ok).toBe(false);
  });

  it("refuses stale, conflicting and partial sets without writing", () => {
    const a = seedDurable(OTHER, "fact a");
    seedDurable(OTHER, "fact b");
    const plan = inspectReown(db, OWNER);
    const stale = decisionsFor(plan, "r").map((d) => d.id === a ? { ...d, expectedRevision: d.expectedRevision + 1 } : d);
    expect(applyPersonalReown(db, stale, { verifiedBackup: true, primaryOwner: OWNER }).ok).toBe(false);
    const partial = decisionsFor(plan, "r").slice(0, 1);
    expect(applyPersonalReown(db, partial, { verifiedBackup: true, primaryOwner: OWNER }).ok).toBe(false);
    const foreign = decisionsFor(plan, "r").map((d) => d.id === a ? { ...d, sourceOwner: "intruder" } : d);
    expect(applyPersonalReown(db, foreign, { verifiedBackup: true, primaryOwner: OWNER }).ok).toBe(false);
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories WHERE user_id = ?").get(OWNER) as { c: number }).c).toBe(0);
  });

  it("refuses rows with history, supersession or forgetting dependencies", () => {
    const withHistory = seedDurable(OTHER, "has history");
    db.prepare("INSERT INTO long_term_revisions (memory_id, user_id, revision, content, authority, applicability_scope, provenance, evidence, classification, created_at) VALUES (?, ?, 1, 'c', 'inference', '{}', '{}', '[]', 1, 1)").run(withHistory, OTHER);
    const linked = seedDurable(OTHER, "linked");
    db.prepare("UPDATE long_term_memories SET superseded_by_id = ? WHERE id = ?").run(999999, linked);
    const marked = seedDurable(OTHER, "marked");
    db.prepare("INSERT INTO forget_markers (owner, record_kind, record_id, lineage, digest, key_generation, created_at) VALUES (?, 'durable', ?, '[]', 'digest', 1, 1)").run(OTHER, marked);
    const plan = inspectReown(db, OWNER);
    expect(plan.candidates.length).toBe(3);
    expect(applyPersonalReown(db, decisionsFor(plan, "r"), { verifiedBackup: true, primaryOwner: OWNER }).ok).toBe(false);
    db.prepare("DELETE FROM long_term_revisions").run();
    db.prepare("UPDATE long_term_memories SET superseded_by_id = NULL WHERE id = ?").run(linked);
    db.prepare("DELETE FROM forget_markers").run();
    const clean = applyPersonalReown(db, decisionsFor(inspectReown(db, OWNER), "r"), { verifiedBackup: true, primaryOwner: OWNER });
    expect(clean.ok).toBe(true);
  });

  it("refuses while forgetting is pending", () => {
    seedDurable(OTHER, "foreign fact");
    db.prepare("INSERT INTO forget_operations (id, owner, state, targets, created_at) VALUES ('op1', ?, 'pending', '[]', 1)").run(OTHER);
    const plan = inspectReown(db, OWNER);
    expect(applyPersonalReown(db, decisionsFor(plan, "r"), { verifiedBackup: true, primaryOwner: OWNER }).ok).toBe(false);
  });
});

describe("single-writer primary enforcement", () => {
  it("refuses foreign episode/durable/supersede/forget at the boundary", () => {
    const store = new PrivateMemoryMutationStore(db);
    expect(() => store.createPersonalEpisode({
      userId: OTHER, topic: "t", startTs: 1, endTs: 2, sessionIds: [], sourceMessageIds: [],
      evidenceExcerpts: [], actorId: "test",
    })).toThrow(PrimaryIdentityError);
    expect(() => store.storePersonalDurable({
      userId: OTHER, memoryType: "fact", content: "x", authority: "inference", authorityBasis: "b",
      evidence: [], actorId: "test",
    })).toThrow(PrimaryIdentityError);
    expect(() => store.forgetPersonal({ owner: OTHER, targets: [], memoryDir: tmpDir, actorId: "test" })).toThrow(PrimaryIdentityError);
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) as c FROM short_term_memories").get() as { c: number }).c).toBe(0);
  });
});
