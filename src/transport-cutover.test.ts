/**
 * transport-cutover.test.ts — Full MCP/transport cutover before live migration (#1930).
 *
 * Every personal-data transport funnels through two choke points:
 * - reads: the owned recall core (owned-v1 profiles over built projections)
 *   and the readiness-gated hydration/session paths;
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
import { buildWakeUp } from "./wake-up-builder.js";
import { OWNED_RECALL_CONTRACT } from "./owned-recall-contract.js";
import type { MemoryManager } from "./memory-manager.js";
import type { OwnedRecallPacket } from "./owned-recall-contract.js";

/** #1928 M4 — maintained reads route the owned core over built projections. */
async function recallReq(profile: "recall_fast" | "recall_normal" | "recall_full", query: string, owner = OWNER): Promise<OwnedRecallPacket> {
  const { ownedRecall } = await import("./owned-recall.js");
  const manager = {
    db,
    config: { memoryDir: tmpDir },
    getOwnerSnapshot: () => owner,
    getEmbeddingProvider: () => null,
  } as unknown as MemoryManager;
  return ownedRecall(manager, {
    contract: OWNED_RECALL_CONTRACT,
    profile,
    identity: { principal: owner },
    ...(profile === "recall_fast" ? { rawTurn: query } : { query: { text: query } }),
  });
}
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
    // #1939 stage 3: the legacy table is dropped — assert structurally.
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'extracted_memories'").get()).toBeUndefined();
    // Recallable through the owned fast path with source-safe refs attached.
    const { buildRecallProjection } = await import("./recall-projection-build.js");
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const recalled = await recallReq("recall_fast", "the gate code is 4821");
    expect(recalled.items.some((i) => i.ref.kind === "db" && i.ref.layer === "durable" && i.ref.recordId === result.memoryId)).toBe(true);
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

  it("refuses foreign source messages without storing", async () => {
    const store = readyStore();
    const foreign = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "borrowed", contentOriginal: "borrowed",
      memoryType: "fact", emotionScore: 0, sourceMessageIds: "999999", actorId: "cutover-test",
    } as never);
    expect(foreign.stored).toBe(false);
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c).toBe(0);
  });

  it("#1930 class-3 decision: sealed stores encrypt the value and redact it from raw sources", async () => {
    const store = readyStore();
    const u1 = message("my backup code is hunter2-ring, keep it safe");
    const u2 = message("unrelated dinner plans");
    const sealed = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "", contentOriginal: "hunter2-ring",
      memoryType: "secret", emotionScore: 0, classification: 3, sealedLabel: "backup code", actorId: "cutover-test",
    } as never);
    expect(sealed.stored).toBe(true);
    if (!sealed.stored) return;
    const row = db.prepare(
      "SELECT content, content_original, classification, encrypted, sealed_format_version, signature, embedding FROM long_term_memories WHERE id = ?",
    ).get(sealed.memoryId) as {
      content: string; content_original: string; classification: number; encrypted: number;
      sealed_format_version: number; signature: Buffer | null; embedding: Buffer | null;
    };
    // Label in plaintext, value only as ciphertext, sealed format markers.
    expect(row.content).toBe("backup code");
    expect(row.content_original).not.toContain("hunter2-ring");
    expect(row.classification).toBe(3);
    expect(row.encrypted).toBe(1);
    expect(row.sealed_format_version).toBe(1);
    expect(row.signature).toBeNull();
    expect(row.embedding).toBeNull();
    // The containing raw message is forgotten; unrelated messages survive.
    expect(db.prepare("SELECT 1 FROM messages WHERE id = ?").get(u1)).toBeUndefined();
    expect(db.prepare("SELECT 1 FROM messages WHERE id = ?").get(u2)).toBeDefined();
    // No serving document: recall never sees the sealed row or its value.
    const { buildRecallProjection } = await import("./recall-projection-build.js");
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const docs = db.prepare("SELECT COUNT(*) AS c FROM recall_documents WHERE record_id = ?").get(sealed.memoryId) as { c: number };
    expect(docs.c).toBe(0);
    const fast = await recallReq("recall_fast", "hunter2-ring backup code");
    expect(fast.items.flatMap((i) => [i.excerpt, i.excerptProvenance ?? ""]).join(" ")).not.toContain("hunter2-ring");
    // The sealed path retrieves it by label + revision; wrong owner fails indistinguishably.
    const { findSealedSecrets, resolveSealedSecret } = await import("./sealed-secret-service.js");
    const found = findSealedSecrets(db, { userId: OWNER, query: "backup code" });
    expect(found.some((r) => r.memoryId === sealed.memoryId && r.label === "backup code")).toBe(true);
    const resolved = resolveSealedSecret(db, { userId: OWNER, memoryId: sealed.memoryId, expectedRevision: 1 });
    expect(resolved).toEqual({ ok: true, value: "hunter2-ring", semanticRevision: 1 });
    expect(resolveSealedSecret(db, { userId: "intruder", memoryId: sealed.memoryId, expectedRevision: 1 })).toEqual({
      ok: false, code: "sealed_resolution_failed",
    });
    // Label/value separation is enforced: the value can never be the label.
    const leaked = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "", contentOriginal: "hunter2-ring",
      memoryType: "secret", emotionScore: 0, classification: 3, sealedLabel: "hunter2-ring", actorId: "cutover-test",
    } as never);
    expect(leaked.stored).toBe(false);
  });

  it("#1930 class-3 decision: an episode excerpt is redacted when its raw message was already pruned", async () => {
    const store = readyStore();
    // Retention pruned the raw row but the episode excerpt survives, which is
    // the surface recall_normal/full serves. Nothing else can reach it.
    const u = message("my backup code is hunter2-ring, keep it safe");
    db.prepare(
      `INSERT INTO short_term_memories
         (user_id, topic, start_ts, end_ts, session_ids, source_message_ids, evidence_excerpts,
          grouping_hash, classification, created_at, updated_at)
       VALUES (?, 'general', 1000, 2000, '["cut_A_main"]', ?, ?, 'group-hash-sealed', 1, 1000, 1000)`,
    ).run(
      OWNER,
      JSON.stringify([u]),
      JSON.stringify([
        { messageId: u, excerpt: "my backup code is hunter2-ring, keep it safe", classification: 1, role: "user" },
        { messageId: 9999, excerpt: "unrelated kept excerpt", classification: 1, role: "assistant" },
      ]),
    );
    db.prepare("DELETE FROM messages WHERE id = ?").run(u);
    const sealed = await store.appendInstant(CTX(), {
      userId: OWNER, contentEn: "", contentOriginal: "hunter2-ring",
      memoryType: "secret", emotionScore: 0, classification: 3, sealedLabel: "backup code", actorId: "cutover-test",
    } as never);
    expect(sealed.stored).toBe(true);
    const episode = db.prepare("SELECT evidence_excerpts FROM short_term_memories WHERE grouping_hash = 'group-hash-sealed'").get() as
      | { evidence_excerpts: string } | undefined;
    expect(episode).toBeDefined();
    if (!episode) return;
    const excerpts = JSON.parse(episode.evidence_excerpts) as Array<{ messageId: number; excerpt: string }>;
    expect(JSON.stringify(excerpts)).not.toContain("hunter2-ring");
    // Unrelated content in the same episode stays available.
    expect(excerpts.some((e) => e.excerpt === "unrelated kept excerpt")).toBe(true);
  });
});

describe("legacy mutation retirement (retired edit surface, daemon edits)", () => {
  it("refuses edit/merge/cascade on ready datasets instead of writing invisible rows", async () => {
    const store = readyStore();
    // #1939 stage 3: no legacy row can exist (table dropped) — refusal is
    // before any row access; the id below is arbitrary.
    const id = 4242;
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
    expect(db.prepare("SELECT 1 FROM messages WHERE id = ?").get(u)).toBeDefined();
    expect((db.prepare("SELECT COUNT(*) as c FROM long_term_memories").get() as { c: number }).c).toBe(0);
  });
});

describe("sleep legacy steps retire on ready datasets", () => {
  it("#1937: the sleep reader boundary is durable-only — legacy rows are invisible", () => {
    const sleep = new SleepDataAccess(db, OWNER);
    // #1939 stage 3: the legacy table is dropped, so arbitrary ids resolve
    // to nothing. The legacy mutation surface is deleted, not declined.
    expect((sleep as unknown as Record<string, unknown>)["invalidateMemory"]).toBeUndefined();
    // No legacy rows can surface as sleep evidence or REM samples.
    expect(sleep.getContradictionEvidence(OWNER, 0)).toEqual([]);
    expect(sleep.getRemSample(OWNER, 10)).toEqual([]);
    expect(sleep.getEvidencePair(OWNER, [4242])).toEqual([]);
  });
});

describe("read-path cutover (hooks, daemon recall, wake-up, heuristics)", () => {
  it("serves wake-up flashback from durable knowledge, never retired rows", () => {
    // #1939 stage 3: retired-model rows cannot exist (table dropped) — the
    // flashback serves durable knowledge only.
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
    // #1928 M4: the owned path serves built projections only.
    const { buildRecallProjection } = await import("./recall-projection-build.js");
    expect(buildRecallProjection(db, OWNER, { verifiedBackup: true }).ok).toBe(true);
    const ambient = await recallReq("recall_fast", "entirely ordinary");
    expect(ambient.status).toBe("skipped");
    expect(ambient.items).toHaveLength(0);
    const explicit = await recallReq("recall_normal", "entirely ordinary note");
    expect(explicit.status).not.toBe("skipped");
    expect(explicit.items.length).toBeGreaterThan(0);
  });
});
