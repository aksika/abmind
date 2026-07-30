import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { AbmindService } from "./abmind-service.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";

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
    const db = manager.getDatabase()!;
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
    const db = manager.getDatabase()!;
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
    expect(manager.getDatabase()!.prepare("SELECT COUNT(*) AS count FROM extracted_memories WHERE user_id = ?").get("alice")).toEqual({ count: 1 });
  });
});
