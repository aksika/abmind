import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "../src/memory-db.js";
import {
  createBackup,
  exportPrincipalTransfer,
  importPrincipalTransfer,
  restoreBackup,
  verifyPrincipalTransfer,
  verifyPrincipalTransferReceipt,
} from "../src/backup.js";
import { OperationalMemoryStore } from "../src/operational-memory-store.js";
import { ensureInitialized } from "../src/ensure-initialized.js";
import type Database from "better-sqlite3";

describe("backup/restore", () => {
  let tmpDir: string;
  let db: Database.Database;
  let memoryDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-backup-test-"));
    memoryDir = join(tmpDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    db = initializeDatabase(join(memoryDir, "memory.db"));

    // Seed data
    db.prepare(`INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score)
      VALUES ('user1', 'eredeti', 'english content', 'fact', 1000, 1000, 0)`).run();
    db.prepare(`INSERT INTO extracted_memories (user_id, content_original, content_en, memory_type, source_timestamp, created_at, emotion_score)
      VALUES ('user1', 'masodik', 'second memory', 'decision', 2000, 2000, 2)`).run();
    db.prepare("INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES ('alice', 'bob', 'friend_of', 1, 1000, 1000)").run();

    // Seed .md file
    mkdirSync(join(memoryDir, "daily"), { recursive: true });
    writeFileSync(join(memoryDir, "daily", "daily_20260428.md"), "# Daily\nSome content");
  });

  afterEach(() => { db.close(); rmSync(tmpDir, { recursive: true, force: true }); });

  it("backup creates encrypted file", () => {
    const outPath = join(tmpDir, "test.abm");
    const result = createBackup(db, memoryDir, "testpass123", outPath);
    expect(result.memories).toBe(2);
    expect(result.files).toBe(1);
    expect(existsSync(outPath)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(100);
  });

  it("restore --replace recovers all data", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    // Wipe
    db.exec("DELETE FROM extracted_memories");
    db.exec("DELETE FROM entity_graph");
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as any).c).toBe(0);

    // Restore
    const result = restoreBackup(db, memoryDir, "testpass123", outPath, "replace");
    expect(result.restored).toBe(2);
    expect((db.prepare("SELECT COUNT(*) as c FROM extracted_memories").get() as any).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) as c FROM entity_graph").get() as any).c).toBe(1);
  });

  it("restore --merge skips duplicates", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "testpass123", outPath);

    // Restore on top of existing data
    const result = restoreBackup(db, memoryDir, "testpass123", outPath, "merge");
    expect(result.skipped).toBe(2); // both already exist (same IDs)
    expect(result.restored).toBe(0);
  });

  it("wrong passphrase throws", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "correct", outPath);
    expect(() => restoreBackup(db, memoryDir, "wrong", outPath, "merge")).toThrow("Decryption failed");
  });

  it("restores .md files", () => {
    const outPath = join(tmpDir, "test.abm");
    createBackup(db, memoryDir, "pass", outPath);

    // Delete the file
    rmSync(join(memoryDir, "daily", "daily_20260428.md"));
    expect(existsSync(join(memoryDir, "daily", "daily_20260428.md"))).toBe(false);

    restoreBackup(db, memoryDir, "pass", outPath, "replace");
    expect(existsSync(join(memoryDir, "daily", "daily_20260428.md"))).toBe(true);
  });

  it("restores a promoted operational-memory aggregate", () => {
    const store = new OperationalMemoryStore(db);
    const draft = store.createDraft({ lesson: "Use the focused suite", suggestedScopeLevel: "global", confidence: 90 });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const promoted = store.promoteDraft({ draftId: draft.value.id, actorId: "reviewer", mutationReason: "approved" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const outPath = join(tmpDir, "operational.abm");
    createBackup(db, memoryDir, "testpass123", outPath);
    const targetDir = join(tmpDir, "target-memory");
    mkdirSync(targetDir, { recursive: true });
    const target = initializeDatabase(join(targetDir, "memory.db"));
    try {
      restoreBackup(target, targetDir, "testpass123", outPath, "replace");
      expect((target.prepare("SELECT COUNT(*) as c FROM operational_lesson_drafts").get() as any).c).toBe(1);
      expect((target.prepare("SELECT COUNT(*) as c FROM operational_memories").get() as any).c).toBe(1);
      expect((target.prepare("SELECT COUNT(*) as c FROM operational_memory_versions").get() as any).c).toBe(1);
    } finally {
      target.close();
    }
  });

  it("rejects an operational backup with a mismatched content hash", () => {
    const store = new OperationalMemoryStore(db);
    const draft = store.createDraft({ lesson: "Hash-protected lesson", suggestedScopeLevel: "global", confidence: 90 });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const promoted = store.promoteDraft({ draftId: draft.value.id, actorId: "reviewer", mutationReason: "approved" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    db.exec("DELETE FROM operational_lesson_drafts");
    db.prepare("UPDATE operational_memories SET content_hash = ? WHERE id = ?").run("corrupted", promoted.value.id);

    const outPath = join(tmpDir, "corrupt-operational.abm");
    createBackup(db, memoryDir, "testpass123", outPath);
    expect(() => restoreBackup(db, memoryDir, "testpass123", outPath, "replace")).toThrow("Invalid operational backup");
  });
});

describe("principal transfer", () => {
  let tmpDir: string;
  let source: Database.Database;
  let target: Database.Database;
  let sourceDir: string;
  let targetDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-principal-transfer-test-"));
    sourceDir = join(tmpDir, "source");
    targetDir = join(tmpDir, "target");
    source = initializeDatabase(join(sourceDir, "memory.db"));
    target = initializeDatabase(join(targetDir, "memory.db"));
    ensureInitialized(source, sourceDir);
    ensureInitialized(target, targetDir);
  });

  afterEach(() => {
    source.close();
    target.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips the complete principal-owned relational closure losslessly", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp, platform_message_id)
      VALUES (41, 'principal-a', 'session-a', 'user', 'source message', 1000, 501)`).run();
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (42, 'principal-b', 'session-b', 'user', 'must stay behind', 1001)`).run();
    const embedding = Buffer.from(new Float32Array([0.25, -0.5, 1.5]).buffer);
    const signature = Buffer.from([0, 1, 2, 253, 254, 255]);
    source.prepare(`INSERT INTO extracted_memories
      (id, user_id, content_original, content_en, memory_type, source_timestamp,
       created_at, source_message_ids, embedding, signature)
      VALUES (71, 'principal-a', 'original', 'translated', 'fact', 1000,
       1002, '41', ?, ?)`).run(embedding, signature);
    source.prepare(`INSERT INTO extracted_memories
      (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at)
      VALUES (72, 'principal-b', 'other', 'other', 'fact', 1000, 1002)`).run();
    source.prepare(`INSERT INTO entity_graph
      (id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at)
      VALUES (81, 'alpha', 'beta', 'related', 71, 1003, 1004)`).run();
    source.prepare(`INSERT INTO entity_graph
      (id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at)
      VALUES (82, 'other', 'edge', 'related', 72, 1003, 1004)`).run();
    source.prepare(`INSERT INTO extraction_watermarks VALUES ('principal-a', 1005)`).run();
    source.prepare(`INSERT INTO ingested_documents
      (id, user_id, source_type, identifier, chunk_count, ingested_at)
      VALUES (91, 'principal-a', 'file', 'doc-a', 3, 1006)`).run();
    source.prepare(`INSERT INTO context_watermarks
      (chat_id, watermark_message_id, compaction_count, pending_compaction)
      VALUES ('session-a', 41, 2, 1)`).run();
    source.prepare(`INSERT INTO context_watermarks
      (chat_id, watermark_message_id, compaction_count, pending_compaction)
      VALUES ('session-b', 42, 1, 0)`).run();
    source.prepare(`INSERT INTO context_summaries
      (id, chat_id, depth, content, token_estimate, source_message_start,
       source_message_end, classification, archived, created_at)
      VALUES (101, 'session-a', 0, 'summary', 4, 41, 41, 1, 0, 1007)`).run();
    source.prepare(`INSERT INTO context_checkpoints
      (id, chat_id, previous_checkpoint_id, source_message_start, source_message_end,
       first_kept_message_id, content, source_token_count, checkpoint_token_count,
       source_digest, checkpoint_digest, active_request_model, reason, budget_json,
       classification, prompt_version, schema_version, serializer_version, created_at)
      VALUES (111, 'session-a', NULL, 41, 41, 41, 'checkpoint', 8, 4,
       'source-digest', 'checkpoint-digest', 'model', 'budget', '{}', 1, 'v1', 1, 'v1', 1008)`).run();
    source.prepare(`INSERT INTO active_context_checkpoint
      (chat_id, checkpoint_id, generation, updated_at)
      VALUES ('session-a', 111, 3, 1009)`).run();
    source.prepare(`INSERT INTO abmind_service_requests
      (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
      VALUES ('principal-a', 'request-1', 'memory.store', 'payload-hash', 'completed', '{}', 1010, 1011)`).run();
    source.prepare("UPDATE extraction_watermarks SET last_processed_timestamp = ? WHERE user_id = 'principal-a'")
      .run(9007199254740993n);
    const packet = exportPrincipalTransfer(source, "principal-a");
    const result = importPrincipalTransfer(target, packet);

    expect(result.status).toBe("imported");
    expect(result.digest).toBe(packet.manifest.digest);
    expect(result.tableCounts).toEqual(packet.manifest.tableCounts);
    expect((target.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(1);
    expect((target.prepare("SELECT COUNT(*) AS count FROM entity_graph").get() as { count: number }).count).toBe(1);
    expect((target.prepare("SELECT COUNT(*) AS count FROM abmind_service_requests").get() as { count: number }).count).toBe(1);
    expect((target.prepare("SELECT embedding, signature FROM extracted_memories WHERE id = 71").get() as { embedding: Buffer; signature: Buffer })).toEqual({ embedding, signature });
    expect((target.prepare("SELECT checkpoint_id FROM active_context_checkpoint WHERE chat_id = 'session-a'").get() as { checkpoint_id: number }).checkpoint_id).toBe(111);
    expect((target.prepare("SELECT COUNT(*) AS count FROM context_watermarks").get() as { count: number }).count).toBe(1);
    const targetWatermark = target.prepare("SELECT last_processed_timestamp FROM extraction_watermarks WHERE user_id = 'principal-a'");
    targetWatermark.safeIntegers(true);
    expect((targetWatermark.get() as { last_processed_timestamp: bigint }).last_processed_timestamp).toBe(9007199254740993n);
    expect(exportPrincipalTransfer(target, "principal-a").manifest.digest).toBe(packet.manifest.digest);
    expect(verifyPrincipalTransferReceipt(target, packet).digest).toBe(packet.manifest.digest);

    target.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (42, 'principal-a', 'session-a', 'assistant', 'created after import', 1012)`).run();
    expect(() => verifyPrincipalTransfer(target, packet)).toThrow("relational state differs");
    expect(verifyPrincipalTransferReceipt(target, packet).digest).toBe(packet.manifest.digest);

    target.prepare("DELETE FROM _meta WHERE key LIKE 'principal_transfer_receipt:%'").run();
    expect(() => verifyPrincipalTransferReceipt(target, packet)).toThrow("receipt is missing");
  });

  it("transfers store-owned operational state and binary files only for an exclusive principal", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (1, 'principal-a', 'session-a', 'user', 'source', 1000)`).run();
    source.prepare(`INSERT INTO entity_graph
      (id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at)
      VALUES (1, 'store', 'owned', 'related', NULL, 1000, 1000)`).run();
    source.prepare(`INSERT INTO context_watermarks
      (chat_id, watermark_message_id, compaction_count, pending_compaction)
      VALUES ('orphan-session', 0, 0, 0)`).run();
    mkdirSync(join(sourceDir, "core"), { recursive: true });
    writeFileSync(join(sourceDir, "core", "user_profile.md"), Buffer.from([0, 255, 1, 2]));
    const operational = new OperationalMemoryStore(source);
    const draft = operational.createDraft({
      lesson: "Preserve the store-owned operational state",
      suggestedScopeLevel: "global",
      confidence: 95,
    });
    expect(draft.ok).toBe(true);

    const packet = exportPrincipalTransfer(source, "principal-a", {
      scope: "exclusive-store",
      memoryDir: sourceDir,
    });
    importPrincipalTransfer(target, packet, { memoryDir: targetDir });

    expect(readFileSync(join(targetDir, "core", "user_profile.md"))).toEqual(Buffer.from([0, 255, 1, 2]));
    expect((target.prepare("SELECT COUNT(*) AS count FROM operational_lesson_drafts").get() as { count: number }).count).toBe(1);
    expect((target.prepare("SELECT COUNT(*) AS count FROM entity_graph").get() as { count: number }).count).toBe(1);
    expect((target.prepare("SELECT COUNT(*) AS count FROM context_watermarks").get() as { count: number }).count).toBe(1);
    expect(exportPrincipalTransfer(target, "principal-a", {
      scope: "exclusive-store",
      memoryDir: targetDir,
    }).manifest.digest).toBe(packet.manifest.digest);
    expect(verifyPrincipalTransfer(target, packet, { memoryDir: targetDir }).digest).toBe(packet.manifest.digest);
    writeFileSync(join(targetDir, "core", "user_profile.md"), "changed");
    expect(() => verifyPrincipalTransfer(target, packet, { memoryDir: targetDir })).toThrow("file differs");
  });

  it("refuses exclusive-store export when another principal is present", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (1, 'principal-b', 'session-b', 'user', 'foreign', 1000)`).run();
    expect(() => exportPrincipalTransfer(source, "principal-a", {
      scope: "exclusive-store",
      memoryDir: sourceDir,
    })).toThrow("store contains other principals");
  });

  it("rejects tampered packets without partially mutating the destination", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (1, 'principal-a', 'session-a', 'user', 'untampered', 1000)`).run();
    const packet = exportPrincipalTransfer(source, "principal-a");
    const messages = packet.tables.find(table => table.name === "messages");
    expect(messages).toBeDefined();
    messages!.rows[0]![4] = "tampered";

    expect(() => importPrincipalTransfer(target, packet)).toThrow("digest mismatch");
    expect((target.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0);
  });

  it("rejects a non-empty destination instead of remapping identities", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (1, 'principal-a', 'session-a', 'user', 'source', 1000)`).run();
    target.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (99, 'existing', 'session-b', 'user', 'existing', 1000)`).run();

    const packet = exportPrincipalTransfer(source, "principal-a");
    expect(() => importPrincipalTransfer(target, packet)).toThrow("destination is not empty");
    expect((target.prepare("SELECT content FROM messages WHERE id = 99").get() as { content: string }).content).toBe("existing");
  });

  it("rejects dangling checkpoint lineage before mutating the destination", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (1, 'principal-a', 'session-a', 'user', 'source', 1)`).run();
    source.prepare(`INSERT INTO context_checkpoints
      (id, chat_id, previous_checkpoint_id, source_message_start, source_message_end,
       first_kept_message_id, content, source_token_count, checkpoint_token_count,
       source_digest, checkpoint_digest, active_request_model, reason, budget_json,
       classification, prompt_version, schema_version, serializer_version, created_at)
      VALUES (1, 'session-a', 999, 1, 1, 1, 'checkpoint', 1, 1,
       'source', 'checkpoint', 'model', 'budget', '{}', 1, 'v1', 1, 'v1', 1)`).run();
    const packet = exportPrincipalTransfer(source, "principal-a");
    expect(() => importPrincipalTransfer(target, packet)).toThrow("missing parent");
    expect((target.prepare("SELECT COUNT(*) AS count FROM context_checkpoints").get() as { count: number }).count).toBe(0);
  });

  it("rejects symlink traversal and leaves the external file unchanged", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (1, 'principal-a', 'session-a', 'user', 'source', 1000)`).run();
    mkdirSync(join(sourceDir, "core"), { recursive: true });
    writeFileSync(join(sourceDir, "core", "profile.md"), "source-profile");
    const packet = exportPrincipalTransfer(source, "principal-a", {
      scope: "exclusive-store",
      memoryDir: sourceDir,
    });
    const outside = join(tmpDir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "profile.md"), "outside-original");
    rmSync(join(targetDir, "core"), { recursive: true, force: true });
    symlinkSync(outside, join(targetDir, "core"));

    expect(() => importPrincipalTransfer(target, packet, { memoryDir: targetDir })).toThrow(
      /symbolic.?link/,
    );
    expect(readFileSync(join(outside, "profile.md"), "utf8")).toBe("outside-original");
    expect((target.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0);
  });

  it("rejects a schema-version mismatch before import", () => {
    source.prepare(`INSERT INTO messages
      (id, user_id, session_id, role, content, timestamp)
      VALUES (1, 'principal-a', 'session-a', 'user', 'source', 1000)`).run();
    const packet = exportPrincipalTransfer(source, "principal-a");
    target.prepare("UPDATE _meta SET value = '999' WHERE key = 'schema_version'").run();
    expect(() => importPrincipalTransfer(target, packet)).toThrow("schema digest mismatch");
    expect((target.prepare("SELECT COUNT(*) AS count FROM messages").get() as { count: number }).count).toBe(0);
  });
});
