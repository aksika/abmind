import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { AbmindService } from "./abmind-service.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
import { SourceMessageIdsError } from "./source-message-ids.js";
import type { CascadeDeletePrivateMessagesInputV1, EffectivePrivateMutationContext } from "./mem-types.js";

function mutationContext(userId = "alice"): EffectivePrivateMutationContext {
  return {
    userId,
    actorId: "test",
    operationKey: `test-cascade-${userId}`,
    canDeclassifySecret: false,
    origin: "internal",
  };
}

function insertMessage(db: import("better-sqlite3").Database & object, userId: string, content: string, sessionId = "s1"): number {
  const result = db.prepare(
    "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)",
  ).run(userId, sessionId, content, Date.now());
  return Number(result.lastInsertRowid);
}

function insertMemory(
  db: import("better-sqlite3").Database & object,
  userId: string,
  contentEn: string,
  sourceMessageIds: string | null,
  withEmbedding: boolean,
): number {
  const result = db.prepare(`
    INSERT INTO extracted_memories
      (user_id, content_original, content_en, memory_type, source_timestamp, created_at, source_message_ids)
    VALUES (?, ?, ?, 'fact', ?, ?, ?)
  `).run(userId, contentEn, contentEn, Date.now(), Date.now(), sourceMessageIds);
  const id = Number(result.lastInsertRowid);
  if (withEmbedding) {
    db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ?").run(Buffer.from(new Float32Array(4).buffer), id);
  }
  return id;
}

describe("cascadeDelete (#1511)", () => {
  let tempDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cascade-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function db() {
    return getMemoryDb(manager)!;
  }

  function cascade(input: CascadeDeletePrivateMessagesInputV1) {
    return manager.editor.getMutationStore().cascadeDelete(mutationContext(input.userId), input);
  }

  it("deletes exactly the owner messages and every linked memory with exact counts", () => {
    const m1 = insertMessage(db(), "alice", "hello one");
    const m2 = insertMessage(db(), "alice", "hello two");
    insertMessage(db(), "alice", "unlinked message");
    const memLinked = insertMemory(db(), "alice", "linked fact", `${m1},${m2}`, true);
    insertMemory(db(), "alice", "unlinked fact", "999999", true);

    const result = cascade({ userId: "alice", messageIds: [m1, m2] });
    expect(result).toEqual({ messagesRemoved: 2, linkedMemoriesRemoved: 1, embeddingsRemoved: 1 });

    expect(db().prepare("SELECT COUNT(*) AS c FROM messages WHERE user_id = ?").get("alice")!.c).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE user_id = ?").get("alice")!.c).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(memLinked)!.c).toBe(0);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories_fts WHERE rowid = ?").get(memLinked)!.c).toBe(0);
    expect(db().prepare("SELECT COUNT(*) AS c FROM content_en_trigram WHERE rowid = ?").get(memLinked)!.c).toBe(0);
    expect(db().prepare("SELECT COUNT(*) AS c FROM content_original_trigram WHERE rowid = ?").get(memLinked)!.c).toBe(0);
  });

  it("never matches ID 12 against source ID 112", () => {
    const m112 = insertMessage(db(), "alice", "message 112");
    const mem12 = insertMemory(db(), "alice", "memory from 12", "12", true);
    insertMemory(db(), "alice", "memory from 112", `${m112}`, true);

    const result = cascade({ userId: "alice", messageIds: [m112] });
    expect(result.messagesRemoved).toBe(1);
    expect(result.linkedMemoriesRemoved).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(mem12)!.c).toBe(1);
  });

  it("deletes a multi-source memory in full when any source message is forgotten", () => {
    const m5 = insertMessage(db(), "alice", "five");
    const m6 = insertMessage(db(), "alice", "six");
    const mem = insertMemory(db(), "alice", "multi source", `${m5},${m6}`, true);

    const result = cascade({ userId: "alice", messageIds: [m5] });
    expect(result).toEqual({ messagesRemoved: 1, linkedMemoriesRemoved: 1, embeddingsRemoved: 1 });
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(mem)!.c).toBe(0);
  });

  it("ignores foreign and missing IDs while deleting only the effective owner's records", () => {
    const aliceMsg = insertMessage(db(), "alice", "alice message");
    const bobMsg = insertMessage(db(), "bob", "bob message");
    const aliceMem = insertMemory(db(), "alice", "alice fact", `${aliceMsg}`, true);
    const bobMem = insertMemory(db(), "bob", "bob fact", `${bobMsg}`, true);

    const result = cascade({ userId: "alice", messageIds: [aliceMsg, bobMsg, 999999] });
    expect(result).toEqual({ messagesRemoved: 1, linkedMemoriesRemoved: 1, embeddingsRemoved: 1 });

    expect(db().prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").get(bobMsg)!.c).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(bobMem)!.c).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(aliceMem)!.c).toBe(0);
  });

  it("is naturally idempotent: a fresh retry returns zero counts", () => {
    const m1 = insertMessage(db(), "alice", "once");
    const mem = insertMemory(db(), "alice", "once fact", `${m1}`, false);

    const first = cascade({ userId: "alice", messageIds: [m1] });
    expect(first).toEqual({ messagesRemoved: 1, linkedMemoriesRemoved: 1, embeddingsRemoved: 0 });

    const second = cascade({ userId: "alice", messageIds: [m1] });
    expect(second).toEqual({ messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 });

    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(mem)!.c).toBe(0);
  });

  it("counts only embedding-bearing linked rows as embeddingsRemoved", () => {
    const m1 = insertMessage(db(), "alice", "embedded pair");
    const m2 = insertMessage(db(), "alice", "plain pair");
    insertMemory(db(), "alice", "embedded fact", `${m1}`, true);
    insertMemory(db(), "alice", "plain fact", `${m2}`, false);

    const result = cascade({ userId: "alice", messageIds: [m1, m2] });
    expect(result).toEqual({ messagesRemoved: 2, linkedMemoriesRemoved: 2, embeddingsRemoved: 1 });
  });

  it("aborts with no deletion when owner source metadata is malformed", () => {
    const m1 = insertMessage(db(), "alice", "bad links");
    const mem = insertMemory(db(), "alice", "bad fact", `${m1},oops`, true);

    expect(() => cascade({ userId: "alice", messageIds: [m1] })).toThrow(SourceMessageIdsError);
    expect(db().prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").get(m1)!.c).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(mem)!.c).toBe(1);
  });

  it("rolls back memory and message deletes together on a required-effect failure", () => {
    const m1 = insertMessage(db(), "alice", "atomic pair");
    const mem = insertMemory(db(), "alice", "atomic fact", `${m1}`, true);

    db().exec(`
      CREATE TRIGGER abort_cascade_messages BEFORE DELETE ON messages BEGIN
        SELECT RAISE(ABORT, 'forced cascade failure');
      END;
    `);

    expect(() => cascade({ userId: "alice", messageIds: [m1] })).toThrow(/forced cascade failure/);
    db().exec("DROP TRIGGER abort_cascade_messages");

    expect(db().prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").get(m1)!.c).toBe(1);
    expect(db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(mem)!.c).toBe(1);
  });

  it("validates input before opening the transaction", () => {
    insertMessage(db(), "alice", "validation target");
    expect(() => cascade({ userId: "alice", messageIds: [] })).toThrow(/1-512/);
    expect(() => cascade({ userId: "alice", messageIds: [1, 1] })).toThrow(/unique/);
    expect(() => cascade({ userId: "alice", messageIds: [-1, 2] })).toThrow(/positive safe integer/);
    expect(() => cascade({ userId: "alice", messageIds: [1.5] })).toThrow(/positive safe integer/);
    expect(() => manager.editor.getMutationStore().cascadeDelete(mutationContext("alice"), { userId: "bob", messageIds: [1] })).toThrow(/principal mismatch/);
    expect(db().prepare("SELECT COUNT(*) AS c FROM messages").get()!.c).toBe(1);
  });
});

function context(principalId = "alice") {
  return {
    principalId,
    role: "local_user" as const,
    grantedDomains: new Set(["private", "system"]),
    authenticatedBy: "embedded" as const,
  };
}

function request(method: "private.edit" | "private.instantStore", payload: unknown, idempotencyKey: string) {
  return {
    version: ABMIND_PROTOCOL_VERSION,
    requestId: `${method}-${idempotencyKey}`,
    method,
    payload: payload as never,
    idempotencyKey,
  } as never;
}

describe("#1449 private mutation boundary", () => {
  let tempDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "private-mutation-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("commits one owner-bound revision and rejects a stale second edit", async () => {
    const db = getMemoryDb(manager)!;
    const inserted = db.prepare(`
      INSERT INTO extracted_memories
        (user_id, content_original, content_en, memory_type, source_timestamp, created_at)
      VALUES (?, ?, ?, 'fact', ?, ?)
    `).run("alice", "old", "old", Date.now(), Date.now());
    const memoryId = Number(inserted.lastInsertRowid);
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager, operational: null, requestLedgerDb: db,
    });

    const first = await service.handle(request("private.edit", {
      userId: "alice", memoryId, expectedRevision: 1, contentEn: "new",
    }, "first"), context("alice"));
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.result).toMatchObject({ ok: true, ref: { memoryId, semanticRevision: 2 } });
    }

    const stale = await service.handle(request("private.edit", {
      userId: "alice", memoryId, expectedRevision: 1, contentEn: "stale",
    }, "stale"), context("alice"));
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.error.code).toBe("conflict");
      expect(stale.error.current).toEqual({ kind: "private_memory", memoryId, semanticRevision: 2 });
    }

    const row = db.prepare("SELECT content_en, semantic_revision FROM extracted_memories WHERE id = ?").get(memoryId) as { content_en: string; semantic_revision: number };
    expect(row).toEqual({ content_en: "new", semantic_revision: 2 });
  });

  it("does not disclose or mutate a memory owned by another principal", async () => {
    const db = getMemoryDb(manager)!;
    const inserted = db.prepare(`
      INSERT INTO extracted_memories
        (user_id, content_original, content_en, memory_type, source_timestamp, created_at)
      VALUES (?, ?, ?, 'fact', ?, ?)
    `).run("bob", "private", "private", Date.now(), Date.now());
    const memoryId = Number(inserted.lastInsertRowid);
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager, operational: null, requestLedgerDb: db,
    });

    const response = await service.handle(request("private.edit", {
      userId: "alice", memoryId, expectedRevision: 1, contentEn: "attempt",
    }, "foreign"), context("alice"));
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.error.code).toBe("not_found");

    const row = db.prepare("SELECT content_en, semantic_revision FROM extracted_memories WHERE id = ?").get(memoryId) as { content_en: string; semantic_revision: number };
    expect(row).toEqual({ content_en: "private", semantic_revision: 1 });
  });

  it("returns the original ID and revision for an exact append duplicate", async () => {
    const first = await manager.editor.instantStore({
      userId: "alice", contentEn: "same fact", contentOriginal: "same fact", memoryType: "fact", emotionScore: 0,
    });
    const second = await manager.editor.instantStore({
      userId: "alice", contentEn: "same fact", contentOriginal: "same fact", memoryType: "fact", emotionScore: 0,
    });
    expect(first).toMatchObject({ stored: true, memoriesCount: 1, semanticRevision: 1 });
    expect(second).toMatchObject({ stored: true, memoriesCount: 1, memoryId: first.memoryId, semanticRevision: 1 });
    expect(getMemoryDb(manager)!.prepare("SELECT COUNT(*) AS count FROM extracted_memories WHERE user_id = ?").get("alice")).toEqual({ count: 1 });
  });
});
