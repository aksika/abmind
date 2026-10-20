import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { setPersonalState } from "./personal-schema.js";
import { AbmindService } from "./abmind-service.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
import type { CascadeDeletePrivateMessagesInputV1, EffectivePrivateMutationContext } from "./mem-types.js";
import type { DomainName } from "./abmind-protocol.js";

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
    // #1939 2b: the legacy message-driven cascade is retired on every
    // dataset state — ready datasets forget through the personal path,
    // unconverted datasets fail closed with conversion required.
    setPersonalState(getMemoryDb(manager)!, "legacy", { reason: "conversion required: cascade refusal test" });
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

  it("refuses on an unconverted dataset with conversion required and deletes nothing", () => {
    const m1 = insertMessage(db(), "alice", "hello one");
    const m2 = insertMessage(db(), "alice", "hello two");
    insertMessage(db(), "alice", "unlinked message");
    const memLinked = insertMemory(db(), "alice", "linked fact", `${m1},${m2}`, true);

    expect(() => cascade({ userId: "alice", messageIds: [m1, m2] })).toThrow(/conversion required/);

    expect((db().prepare("SELECT COUNT(*) AS c FROM messages WHERE user_id = ?").get("alice") as { c: number }).c).toBe(3);
    expect((db().prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(memLinked) as { c: number }).c).toBe(1);
  });

  it("rejects a different principal without disclosing existence", () => {
    expect(() => manager.editor.getMutationStore().cascadeDelete(mutationContext("alice"), { userId: "bob", messageIds: [1] })).toThrow(/principal mismatch/);
  });

  it("validates input before touching the gate", () => {
    insertMessage(db(), "alice", "validation target");
    expect(() => cascade({ userId: "alice", messageIds: [] })).toThrow(/1-512/);
    expect(() => cascade({ userId: "alice", messageIds: [1, 1] })).toThrow(/unique/);
    expect(() => cascade({ userId: "alice", messageIds: [-1, 2] })).toThrow(/positive safe integer/);
    expect(() => cascade({ userId: "alice", messageIds: [1.5] })).toThrow(/positive safe integer/);
    expect((db().prepare("SELECT COUNT(*) AS c FROM messages").get() as { c: number }).c).toBe(1);
  });
});

function context(principalId = "alice") {
  return {
    principalId,
    role: "local_user" as const,
    grantedDomains: new Set<DomainName>(["private", "system"]),
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
    // #1939 2b: legacy edits refuse on every dataset state (ready: retired,
    // unconverted: conversion required) instead of mutating frozen rows.
    setPersonalState(getMemoryDb(manager)!, "legacy", { reason: "conversion required: edit refusal test" });
    process.env.ABMIND_USER_ID = "alice";
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.ABMIND_USER_ID;
  });

  it("refuses a legacy edit with conversion required and leaves the row untouched", async () => {
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

    const res = await service.handle(request("private.edit", {
      userId: "alice", memoryId, expectedRevision: 1, contentEn: "new",
    }, "first"), context("alice"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("validation_error");
      expect(res.error.message).toContain("conversion required");
    }

    const row = db.prepare("SELECT content_en, semantic_revision FROM extracted_memories WHERE id = ?").get(memoryId) as { content_en: string; semantic_revision: number };
    expect(row).toEqual({ content_en: "old", semantic_revision: 1 });
  });

  it("refuses a foreign-owner edit without reaching the row", async () => {
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
    if (!response.ok) expect(response.error.message).toContain("conversion required");

    const row = db.prepare("SELECT content_en, semantic_revision FROM extracted_memories WHERE id = ?").get(memoryId) as { content_en: string; semantic_revision: number };
    expect(row).toEqual({ content_en: "private", semantic_revision: 1 });
  });

  it("refuses a legacy instantStore append with conversion required", async () => {
    const first = await manager.editor.instantStore({
      userId: "alice", contentEn: "same fact", contentOriginal: "same fact", memoryType: "fact", emotionScore: 0,
    });
    expect(first.stored).toBe(false);
    if (!first.stored) expect(first.message).toContain("conversion required");
    expect(getMemoryDb(manager)!.prepare("SELECT COUNT(*) AS count FROM extracted_memories WHERE user_id = ?").get("alice")).toEqual({ count: 0 });
  });
});

describe("#1658 Master-only instant-store creation gate", () => {
  let tempDir: string;
  let manager: MemoryManager;
  let savedUserId: string | undefined;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "master-only-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
    // #1939 2b: the legacy instant-store path is deleted. The owner gate
    // still runs first; a canonical owner then meets the readiness gate,
    // which refuses the unconverted dataset with conversion required.
    setPersonalState(getMemoryDb(manager)!, "legacy", { reason: "conversion required: store refusal test" });
    savedUserId = process.env.ABMIND_USER_ID;
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
    if (savedUserId === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = savedUserId;
  });

  it("passes the owner gate but refuses the store on an unconverted dataset", async () => {
    process.env.ABMIND_USER_ID = "master-user";
    const result = await manager.editor.instantStore({
      userId: "master-user", contentEn: "master fact", contentOriginal: "master fact", memoryType: "fact", emotionScore: 0,
    });
    expect(result.stored).toBe(false);
    if (!result.stored) {
      expect(result.code).toBe("unavailable");
      expect(result.message).toContain("conversion required");
    }
    const db = getMemoryDb(manager)!;
    expect((db.prepare("SELECT COUNT(*) AS count FROM extracted_memories WHERE user_id = 'master-user'").get() as { count: number }).count).toBe(0);
  });

  it("rejects a foreign owner without writing a row", async () => {
    process.env.ABMIND_USER_ID = "master-user";
    const db = getMemoryDb(manager)!;
    const result = await manager.editor.instantStore({
      userId: "foreign-user", contentEn: "foreign fact", contentOriginal: "foreign fact", memoryType: "fact", emotionScore: 0,
    });
    expect(result.stored).toBe(false);
    if (!result.stored) {
      expect(result.code).toBe("unauthorized");
      expect(result.message).toContain("non_primary_memory_owner");
    }
    expect((db.prepare("SELECT COUNT(*) AS count FROM extracted_memories").get() as { count: number }).count).toBe(0);
  });

  it("rejects a missing identity with a configuration error and no row", async () => {
    delete process.env.ABMIND_USER_ID;
    const db = getMemoryDb(manager)!;
    const result = await manager.editor.instantStore({
      userId: "nobody", contentEn: "orphan fact", contentOriginal: "orphan fact", memoryType: "fact", emotionScore: 0,
    });
    expect(result.stored).toBe(false);
    if (!result.stored) {
      expect(result.code).toBe("unavailable");
      expect(result.message).toContain("primary_identity_missing");
    }
    expect((db.prepare("SELECT COUNT(*) AS count FROM extracted_memories").get() as { count: number }).count).toBe(0);
  });
});
