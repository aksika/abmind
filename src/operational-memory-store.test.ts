/**
 * operational-memory-store.test.ts — Tests for immutable version lineage,
 * hash-guarded optimistic concurrency, draft lifecycle, and scope
 * validation (#1371).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDatabase } from "./memory-db.js";
import { OperationalMemoryStore } from "./operational-memory-store.js";
import { computeContentHash, normalizeScope } from "./operational-memory-types.js";
import type Database from "better-sqlite3";
import type { CreateDraftInput, PromoteDraftInput, RejectDraftInput, ReviseOperationalMemoryInput, RetireOperationalMemoryInput } from "./operational-memory-types.js";

describe("OperationalMemoryStore", () => {
  let tmpDir: string;
  let db: Database.Database;
  let store: OperationalMemoryStore;

  function draft(id: string): CreateDraftInput {
    return {
      lesson: `Lesson ${id}`,
      problem: `Problem ${id}`,
      recommendation: `Recommendation ${id}`,
      suggestedScopeLevel: "global",
      confidence: 80,
    };
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "op-mem-store-"));
    db = initializeDatabase(join(tmpDir, "memory.db"));
    store = new OperationalMemoryStore(db);
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Schema ─────────────────────────────────────────────────────────────

  it("has operational tables in schema", () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
    const names = tables.map(t => t.name);
    expect(names).toContain("operational_lesson_drafts");
    expect(names).toContain("operational_memories");
    expect(names).toContain("operational_memory_versions");
  });

  // ── createDraft ────────────────────────────────────────────────────────

  it("creates a draft", () => {
    const result = store.createDraft(draft("A"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lesson).toBe("Lesson A");
    expect(result.value.status).toBe("draft");
    expect(result.value.promotedMemoryId).toBeNull();
    expect(result.value.rejectedBy).toBeNull();
  });

  it("creates a draft with platform scope and provenance", () => {
    const result = store.createDraft({
      lesson: "Platform-specific lesson",
      problem: "Platform problem",
      suggestedScopeLevel: "platform",
      suggestedPlatform: "telegram",
      confidence: 90,
      evidence: [{ source: "chat", detail: "observed pattern" }],
      provenance: { source: "user-feedback", version: 1 },
      sourceTaskId: "task-1",
      sourceSessionId: "session-1",
      sourceExecutor: "agent-1",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.suggestedScopeLevel).toBe("platform");
    expect(result.value.suggestedPlatform).toBe("telegram");
    expect(result.value.evidence).toHaveLength(1);
    expect(result.value.provenance).toEqual({ source: "user-feedback", version: 1 });
  });

  it("rejects draft with out-of-range confidence", () => {
    const result = store.createDraft({
      ...draft("invalid-confidence"),
      confidence: 150,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_error");
  });

  it("rejects draft with oversized lesson", () => {
    const result = store.createDraft({
      ...draft("oversized"),
      lesson: "x".repeat(5000),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("validation_error");
  });

  // ── promoteDraft ───────────────────────────────────────────────────────

  it("promotes a draft to a memory with immutable version", () => {
    const created = store.createDraft({ ...draft("promote-A"), suggestedScopeLevel: "host", suggestedHost: "molty" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const draftId = created.value.id;

    const result = store.promoteDraft({
      draftId,
      actorId: "agent-1",
      mutationReason: "First promotion",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const mem = result.value;
    expect(mem.status).toBe("active");
    expect(mem.scopeLevel).toBe("host");
    expect(mem.host).toBe("molty");
    expect(mem.contentHash).toBeTruthy();

    // Draft should now be promoted
    const draftAfter = store.getDraft(draftId);
    expect(draftAfter).not.toBeNull();
    expect(draftAfter!.status).toBe("promoted");
    expect(draftAfter!.promotedMemoryId).toBe(mem.id);

    // Version should exist
    const versions = store.getVersionLineage(mem.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.memoryId).toBe(mem.id);
    expect(versions[0]!.status).toBe("active");
    expect(versions[0]!.previousVersionId).toBeNull();
  });

  it("returns existing draft when promoting an already-promoted draft", () => {
    const created = store.createDraft({ ...draft("already-promoted"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = store.promoteDraft({ draftId: created.value.id, actorId: "agent-1", mutationReason: "first" });
    expect(first.ok).toBe(true);

    const second = store.promoteDraft({ draftId: created.value.id, actorId: "agent-2", mutationReason: "duplicate" });
    expect(second.ok).toBe(true);
    // Should return ok:true with existing draft since it's already promoted
  });

  it("promotes with curation overrides", () => {
    const created = store.createDraft({
      lesson: "Original lesson",
      problem: "Original problem",
      suggestedScopeLevel: "workspace",
      suggestedWorkspace: "abproject",
      confidence: 50,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.promoteDraft({
      draftId: created.value.id,
      actorId: "curator",
      mutationReason: "Curated during promotion",
      curate: {
        lesson: "Curated lesson",
        scopeLevel: "platform",
        platform: "slack",
        confidence: 95,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scopeLevel).toBe("platform");
    expect(result.value.platform).toBe("slack");
    expect(result.value.confidence).toBe(95);

    // Version content should be the curated lesson
    const versions = store.getVersionLineage(result.value.id);
    expect(versions[0]!.content).toBe("Curated lesson");
  });

  it("returns not_found for missing draft", () => {
    const result = store.promoteDraft({
      draftId: "nonexistent-draft-id",
      actorId: "agent",
      mutationReason: "test",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  // ── rejectDraft ────────────────────────────────────────────────────────

  it("rejects a draft", () => {
    const created = store.createDraft({ ...draft("reject-me"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.rejectDraft({
      draftId: created.value.id,
      rejectedBy: "reviewer-1",
      rejectionReason: "Not relevant",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("rejected");
    expect(result.value.rejectedBy).toBe("reviewer-1");
    expect(result.value.rejectionReason).toBe("Not relevant");
  });

  it("rejects a promoted-draft replay with conflict", () => {
    const created = store.createDraft({ ...draft("replay-reject"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promoted = store.promoteDraft({ draftId: created.value.id, actorId: "agent", mutationReason: "go" });
    expect(promoted.ok).toBe(true);

    // Opposite-terminal operation returns conflict
    const rejected = store.rejectDraft({ draftId: created.value.id, rejectedBy: "reviewer", rejectionReason: "late" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("conflict");
  });

  it("returns not_found for rejecting missing draft", () => {
    const result = store.rejectDraft({
      draftId: "nonexistent",
      rejectedBy: "reviewer",
      rejectionReason: "no reason",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  // ── Promote vs reject race (mutual exclusion) ──────────────────────────

  it("promote and reject are mutually exclusive on the same draft", () => {
    const created = store.createDraft({ ...draft("race-test"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const draftId = created.value.id;

    const promoted = store.promoteDraft({ draftId, actorId: "agent", mutationReason: "win" });
    expect(promoted.ok).toBe(true);

    // Opposite-terminal operation returns conflict, not not_found
    const rejected = store.rejectDraft({ draftId, rejectedBy: "reviewer", rejectionReason: "too late" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe("conflict");
    // The promotion won — draft is promoted, not rejected
    const finalDraft = store.getDraft(draftId);
    expect(finalDraft!.status).toBe("promoted");
  });

  // ── revise (CAS) ──────────────────────────────────────────────────────

  it("revises a memory with a new version and content hash", () => {
    const created = store.createDraft({ ...draft("revise-A"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promoted = store.promoteDraft({ draftId: created.value.id, actorId: "agent", mutationReason: "initial" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const mem = promoted.value;
    const revised = store.revise({
      memoryId: mem.id,
      expectedContentHash: mem.contentHash,
      content: "Revised content",
      scopeLevel: "global",
      confidence: 85,
      mutationReason: "Updated guidance",
      actorId: "agent-2",
    });

    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.value.contentHash).not.toBe(mem.contentHash);
    expect(revised.value.confidence).toBe(85);

    // Verify 2 versions in lineage
    const versions = store.getVersionLineage(mem.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.previousVersionId).toBe(versions[1]!.id);
    expect(versions[0]!.content).toBe("Revised content");
    expect(versions[1]!.content).toBe("Lesson revise-A");
  });

  it("returns conflict on stale expectedContentHash", () => {
    const created = store.createDraft({ ...draft("cas-conflict"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promoted = store.promoteDraft({ draftId: created.value.id, actorId: "agent", mutationReason: "initial" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const mem = promoted.value;

    // First revision succeeds
    const first = store.revise({
      memoryId: mem.id,
      expectedContentHash: mem.contentHash,
      content: "First revision",
      scopeLevel: "global",
      confidence: 80,
      mutationReason: "update 1",
      actorId: "agent",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second revision with stale hash from BEFORE first revision
    const second = store.revise({
      memoryId: mem.id,
      expectedContentHash: mem.contentHash, // stale
      content: "Second revision from stale base",
      scopeLevel: "global",
      confidence: 80,
      mutationReason: "update 2",
      actorId: "agent",
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe("conflict");
    expect(second.current).toBeDefined();
    expect(second.current!.versionId).toBeTruthy();
    expect(second.current!.contentHash).toBeTruthy();

    // Only 2 versions should exist (first success + original), not 3
    const versions = store.getVersionLineage(mem.id);
    expect(versions).toHaveLength(2);
  });

  it("rolls back a successor when the CAS changes after version insertion", () => {
    const created = store.createDraft({ ...draft("cas-rollback"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const promoted = store.promoteDraft({ draftId: created.value.id, actorId: "agent", mutationReason: "initial" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    db.exec("CREATE TRIGGER op_test_force_cas_race AFTER INSERT ON operational_memory_versions WHEN NEW.previous_version_id IS NOT NULL BEGIN UPDATE operational_memories SET content_hash=char(114,97,99,101,100) WHERE id=NEW.memory_id; END");
    try {
      const result = store.revise({
        memoryId: promoted.value.id,
        expectedContentHash: promoted.value.contentHash,
        content: "should roll back",
        scopeLevel: "global",
        confidence: 80,
        mutationReason: "race",
        actorId: "agent",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("conflict");
      expect(store.getVersionLineage(promoted.value.id)).toHaveLength(1);
    } finally {
      db.exec("DROP TRIGGER op_test_force_cas_race");
    }
  });

  it("returns not_found for revising missing memory", () => {
    const result = store.revise({
      memoryId: "nonexistent",
      expectedContentHash: "abc",
      content: "test",
      scopeLevel: "global",
      confidence: 50,
      mutationReason: "test",
      actorId: "agent",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("not_found");
  });

  // ── retire (CAS) ──────────────────────────────────────────────────────

  it("retires a memory", () => {
    const created = store.createDraft({ ...draft("retire-me"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promoted = store.promoteDraft({ draftId: created.value.id, actorId: "agent", mutationReason: "initial" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const mem = promoted.value;
    const result = store.retire({
      memoryId: mem.id,
      expectedContentHash: mem.contentHash,
      mutationReason: "No longer relevant",
      actorId: "agent-3",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("retired");

    // A retire version should exist
    const versions = store.getVersionLineage(mem.id);
    expect(versions).toHaveLength(2);
    expect(versions[0]!.status).toBe("retired");
  });

  it("returns conflict on retire with stale hash", () => {
    const created = store.createDraft({ ...draft("retire-stale"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promoted = store.promoteDraft({ draftId: created.value.id, actorId: "agent", mutationReason: "initial" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const mem = promoted.value;

    // Revise first
    store.revise({
      memoryId: mem.id,
      expectedContentHash: mem.contentHash,
      content: "Updated",
      scopeLevel: "global",
      confidence: 80,
      mutationReason: "update",
      actorId: "agent",
    });

    // Retire with stale original hash
    const result = store.retire({
      memoryId: mem.id,
      expectedContentHash: mem.contentHash,
      mutationReason: "retire stale",
      actorId: "agent",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("conflict");
  });

  // ── Read methods ──────────────────────────────────────────────────────

  it("getDrafts returns drafts filtered by status", () => {
    const allDrafts = store.getDrafts();
    expect(allDrafts.length).toBeGreaterThan(0);

    const draftDrafts = store.getDrafts("draft");
    expect(draftDrafts.every(d => d.status === "draft")).toBe(true);

    const promotedDrafts = store.getDrafts("promoted");
    expect(promotedDrafts.every(d => d.status === "promoted")).toBe(true);
  });

  it("getMemoriesByScope returns active memories for a scope", () => {
    const scopeMems = store.getMemoriesByScope("global");
    expect(scopeMems.length).toBeGreaterThan(0);
    expect(scopeMems.every(m => m.scopeLevel === "global" && m.status === "active")).toBe(true);
  });

  it("counts operational drafts and memories", () => {
    expect(store.countDrafts()).toBeGreaterThan(0);
    expect(store.countMemories()).toBeGreaterThan(0);
  });

  // ── Immutable versions guarantee ──────────────────────────────────────

  it("versions are never updated (append-only lineage)", () => {
    const created = store.createDraft({ ...draft("immutable-test"), suggestedScopeLevel: "global" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const promoted = store.promoteDraft({ draftId: created.value.id, actorId: "agent", mutationReason: "initial" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const memId = promoted.value.id;
    const v1 = store.getVersionLineage(memId)[0];
    expect(v1).toBeDefined();
    const originalContent = v1!.content;

    // Revise creates v2; v1 should remain unchanged
    store.revise({
      memoryId: memId,
      expectedContentHash: promoted.value.contentHash,
      content: "V2 content",
      scopeLevel: "global",
      confidence: 80,
      mutationReason: "revision",
      actorId: "agent",
    });

    const versions = store.getVersionLineage(memId);
    expect(versions).toHaveLength(2);
    const v1After = versions.find(v => v.id === v1!.id);
    expect(v1After).toBeDefined();
    expect(v1After!.content).toBe(originalContent);
  });

  // ── Content hash determinism ──────────────────────────────────────────

  it("computeContentHash is deterministic for same inputs", () => {
    const scope = normalizeScope("global");
    const input = {
      content: "test content",
      status: "active" as const,
      scope,
      confidence: 80,
      provenance: { source: "test" },
      evidence: [{ source: "chat", detail: "observation" }],
    };
    const hash1 = computeContentHash(input);
    const hash2 = computeContentHash(input);
    expect(hash1).toBe(hash2);
  });

  it("computeContentHash changes when content changes", () => {
    const scope = normalizeScope("global");
    const input = {
      content: "test content",
      status: "active" as const,
      scope,
      confidence: 80,
      provenance: {},
      evidence: [],
    };
    const hash1 = computeContentHash(input);
    const hash2 = computeContentHash({ ...input, content: "different content" });
    expect(hash1).not.toBe(hash2);
  });

  it("computeContentHash changes when scope changes", () => {
    const base = {
      content: "test",
      status: "active" as const,
      confidence: 80,
      provenance: {},
      evidence: [],
    };
    const h1 = computeContentHash({ ...base, scope: normalizeScope("global") });
    const h2 = computeContentHash({ ...base, scope: normalizeScope("host", "molty") });
    expect(h1).not.toBe(h2);
  });
});
