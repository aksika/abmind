import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AbmindService, AbmindRequestLedger } from "./abmind-service.js";
import type { AbmindRequestV1, ServiceCallContext, AbmindMethod } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
import { ensureInitialized } from "./ensure-initialized.js";

function makeContext(overrides?: Partial<ServiceCallContext>): ServiceCallContext {
  return {
    principalId: "test-user",
    role: "local_user",
    grantedDomains: new Set(["system", "private", "operational"]),
    authenticatedBy: "embedded",
    ...overrides,
  };
}

function makeRequest<K extends AbmindMethod>(method: K, payload: unknown, idempotencyKey?: string): AbmindRequestV1<K> {
  return {
    version: ABMIND_PROTOCOL_VERSION,
    requestId: "test-req-1",
    method,
    payload: payload as never,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

class MockManager {
  getConfig() { return { memoryEnabled: true, memoryDir: "/tmp" }; }
  getDatabase() { return null; }
  getMemoryIndex() { return null; }
  editor = {
    instantStore: () => ({ ok: true, id: 1 } as never),
    editMemory: () => ({ ok: true } as never),
    reclassifyMemory: () => {},
    adjustRelevance: () => {},
    mergeMemories: () => ({ merged: true, keptId: 1, deletedId: 2 } as never),
    cascadeDelete: () => ({ deleted: 1 } as never),
  };
  rebuildFtsIndexes() { return { rebuilt: ["main"] }; }
  recallSearch() { return { hits: [] }; }
  recordMessage() { return 42; }
  getRecentConversation() { return []; }
  buildWakeUp() { return ""; }
  readCoreKnowledge() { return ""; }
  getStats() { return null; }
  bumpCitedCount() {}
  bumpRejectedCount() {}
  hasExtractedMemoryForUser() { return true; }
  operational = null;
}

describe("AbmindService", () => {
  describe("system methods", () => {
    it("responds to system.negotiate", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const res = await service.handle(makeRequest("system.negotiate", {}), makeContext());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result).toHaveProperty("version", 1);
        expect(res.result.methods).toContain("system.negotiate");
      }
    });

    it("responds to system.health", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const res = await service.handle(makeRequest("system.health", {}), makeContext());
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.result.status).toBe("healthy");
    });

    it("responds to system.status", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const res = await service.handle(makeRequest("system.status", {}), makeContext());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result.mode).toBe("embedded");
        expect(res.result.instanceId).toBe("test");
        expect(res.result.pid).toBe(process.pid);
      }
    });
  });

  describe("authorization", () => {
    it("rejects unauthorized domain", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext({ grantedDomains: new Set(["system"]) });
      const res = await service.handle(makeRequest("private.recall", { query: "test" }), ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unauthorized");
    });

    it("rejects userId mismatch on private method", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
      const req = makeRequest("private.recall", { query: "test", userId: "user-bob" });
      const res = await service.handle(req, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unauthorized");
    });

    it("allows an explicitly delegated private user", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "host", allowPrivateDelegation: true });
      const req = makeRequest("private.recall", { query: "test", userId: "user-bob" });
      const res = await service.handle(req, ctx);
      if (!res.ok) expect(res.error.code).not.toBe("unauthorized");
    });

    it("requires the registered capability for operator methods", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const withoutCapability = await service.handle(makeRequest("private.rebuildFts", {}), makeContext({ grantedDomains: new Set(["operator"]) }));
      expect(withoutCapability.ok).toBe(false);
      if (!withoutCapability.ok) expect(withoutCapability.error.code).toBe("unauthorized");
      const withCapability = await service.handle(makeRequest("private.rebuildFts", {}), makeContext({
        grantedDomains: new Set(["operator"]), capabilities: new Set(["rebuild_fts"]),
      }));
      if (!withCapability.ok) expect(withCapability.error.code).not.toBe("unauthorized");
    });

    it("allows userId match on private method", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
      const req = makeRequest("private.recall", { query: "test", userId: "user-alice" });
      const res = await service.handle(req, ctx);
      // auth passes; error is "unavailable" because mock has no DB, not "unauthorized"
      if (!res.ok) expect(res.error.code).not.toBe("unauthorized");
    });

    it("rejects private methods without the required userId", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
      const req = makeRequest("private.recall", { query: "test" });
      const res = await service.handle(req, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("validation_error");
    });

    it("rejects non-object and non-JSON payloads at the service boundary", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext();
      const badShape = await service.handle(makeRequest("private.recall", null), ctx);
      expect(badShape.ok).toBe(false);
      if (!badShape.ok) expect(badShape.error.code).toBe("validation_error");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const badJson = await service.handle(makeRequest("system.health", circular), ctx);
      expect(badJson.ok).toBe(false);
      if (!badJson.ok) expect(badJson.error.code).toBe("validation_error");
    });

    it("keeps the incomplete cascade contract unavailable", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
      const req = makeRequest("private.cascadeDelete", { userId: "user-alice", messageIds: [1] }, "idem-1");
      const res = await service.handle(req, ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unavailable");
    });

    it("allows private reads without CAS gating", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
      const req = makeRequest("private.recall", { query: "test", userId: "user-alice" });
      const res = await service.handle(req, ctx);
      if (!res.ok) expect(res.error.code).not.toBe("unauthorized");
    });

    it("returns normalized object for recordMessage with id=42", async () => {
    const ledgerDb = new Database(":memory:");
    ledgerDb.exec(`CREATE TABLE abmind_service_requests (
      principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, idempotency_key)
    )`);
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: ledgerDb,
    });
    const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "test-user" });
    const res = await service.handle(makeRequest("private.recordMessage", {
      userId: "test-user", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
    }, "append-norm-1"), ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toEqual({ id: 42 });
    }
    ledgerDb.close();
  });

  it("returns normalized object for recordMessage with id=null", async () => {
    class NullReturnManager extends MockManager {
      override recordMessage() { return null; }
    }
    const ledgerDb = new Database(":memory:");
    ledgerDb.exec(`CREATE TABLE abmind_service_requests (
      principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, idempotency_key)
    )`);
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new NullReturnManager() as never, operational: null, requestLedgerDb: ledgerDb,
    });
    const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "test-user" });
    const res = await service.handle(makeRequest("private.recordMessage", {
      userId: "test-user", sessionId: "s1", role: "user", content: "filtered", timestamp: 1,
    }, "append-null-1"), ctx);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toEqual({ id: null });
    }
    ledgerDb.close();
  });

  it("replays normalized recordMessage result on idempotent key", async () => {
    const ledgerDb = new Database(":memory:");
    ledgerDb.exec(`CREATE TABLE abmind_service_requests (
      principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, idempotency_key)
    )`);
    let callCount = 0;
    class TrackingManager extends MockManager {
      override recordMessage() { callCount++; return 99; }
    }
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new TrackingManager() as never, operational: null, requestLedgerDb: ledgerDb,
    });
    const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "test-user" });
    const payload = { userId: "test-user", sessionId: "s1", role: "user", content: "replay", timestamp: 1 };

    // First call: should execute and return normalized result
    const res1 = await service.handle(makeRequest("private.recordMessage", payload, "replay-key-1"), ctx);
    expect(res1.ok).toBe(true);
    if (res1.ok) expect(res1.result).toEqual({ id: 99 });
    expect(callCount).toBe(1);

    // Replay: should return the SAME normalized result without calling manager again
    const replayRequest = makeRequest("private.recordMessage", payload, "replay-key-1");
    replayRequest.requestId = "test-req-2";
    const res2 = await service.handle(replayRequest, ctx);
    expect(res2.ok).toBe(true);
    if (res2.ok) expect(res2.result).toEqual({ id: 99 });
    expect(res2.requestId).toBe("test-req-2");
    expect(callCount).toBe(1);

    ledgerDb.close();
  });

  it("allows principal-bound append and feedback while rack CAS remains disabled", async () => {
      const ledgerDb = new Database(":memory:");
      ledgerDb.exec(`CREATE TABLE abmind_service_requests (
        principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
        payload_hash TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (principal_id, idempotency_key)
      )`);
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: ledgerDb,
      });
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "test-user" });
      const append = await service.handle(makeRequest("private.recordMessage", {
        userId: "test-user", sessionId: "s1", role: "user", content: "hello", timestamp: 1,
      }, "append-1"), ctx);
      expect(append.ok).toBe(true);
      const feedback = await service.handle(makeRequest("private.recordFeedback", {
        userId: "test-user", memoryId: 42, feedbackType: "cite",
      }, "feedback-1"), ctx);
      expect(feedback.ok, JSON.stringify(feedback)).toBe(true);
      ledgerDb.close();
    });

    it("system.capabilities reports the active revision contract", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const res = await service.handle(makeRequest("system.capabilities", {}), makeContext());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result.private_write).toBe("true");
        expect(res.result.private_mutation_contract).toBe("revision-v1");
        expect(res.result.private_read).toBe("true");
      }
    });

    it("rejects unsupported method", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const res = await service.handle(makeRequest("nonexistent.method" as never, {}), makeContext());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unsupported_method");
    });

    it("rejects unsupported version", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const req = makeRequest("system.health", {});
      req.version = 99 as never;
      const res = await service.handle(req, makeContext());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unsupported_version");
    });
  });

  describe("errors", () => {
    it("returns unavailable when closed", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      service.close();
      const res = await service.handle(makeRequest("system.health", {}), makeContext());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unavailable");
    });

    it("rejects oversized requestId", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const req = makeRequest("system.health", {});
      req.requestId = "x".repeat(200);
      const res = await service.handle(req, makeContext());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("validation_error");
    });
  });
});

describe("AbmindRequestLedger", () => {
  let tmpDir: string;
  let db: Database.Database;
  let ledger: AbmindRequestLedger;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-ledger-"));
    db = new Database(join(tmpDir, "ledger.db"));
    db.exec(`
      CREATE TABLE IF NOT EXISTS abmind_service_requests (
        principal_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','completed','outcome_unknown')),
        response_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (principal_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_abmind_service_requests_retention ON abmind_service_requests(state, updated_at);
    `);
    ledger = new AbmindRequestLedger(db);
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reserves a new idempotency key", () => {
    const result = ledger.reserve("user1", "key1", "test.method", "hash123");
    expect(result.status).toBe("reserved");
  });

  it("completes and replays a reserved key", () => {
    const result = ledger.reserve("user1", "key2", "test.method", "hash456");
    expect(result.status).toBe("reserved");
    ledger.complete("user1", "key2", '{"ok":true,"result":"done"}');
    const replay = ledger.reserve("user1", "key2", "test.method", "hash456");
    expect(replay.status).toBe("completed");
    if (replay.status === "completed") {
      expect(replay.responseJson).toBe('{"ok":true,"result":"done"}');
    }
  });

  it("returns conflict for different method with same key (completed)", () => {
    ledger.reserve("user1", "key3", "method.a", "hash1");
    ledger.complete("user1", "key3", '"ok"');
    const result = ledger.reserve("user1", "key3", "method.b", "hash2");
    expect(result.status).toBe("conflict");
  });

  it("returns conflict for different method/hash on incomplete row", () => {
    ledger.reserve("user1", "key-inc", "method.a", "hash1");
    const result = ledger.reserve("user1", "key-inc", "method.b", "hash2");
    expect(result.status).toBe("conflict");
  });

  it("returns unknown for incomplete reservation with same method/hash", () => {
    ledger.reserve("user1", "key-unknown", "method.a", "hash1");
    const result = ledger.reserve("user1", "key-unknown", "method.a", "hash1");
    expect(result.status).toBe("unknown");
  });

  it("markStarted targets specific principal/key", () => {
    ledger.reserve("user-a", "k1", "m.a", "h1");
    ledger.reserve("user-b", "k2", "m.b", "h2");
    ledger.markStarted("user-a", "k1");

    const rowA = db.prepare("SELECT state FROM abmind_service_requests WHERE principal_id = ? AND idempotency_key = ?").get("user-a", "k1") as { state: string };
    const rowB = db.prepare("SELECT state FROM abmind_service_requests WHERE principal_id = ? AND idempotency_key = ?").get("user-b", "k2") as { state: string };
    expect(rowA.state).toBe("dispatch_started");
    expect(rowB.state).toBe("reserved");
  });

  it("crash-window: dispatch_started + restart returns outcome_unknown", () => {
    ledger.reserve("crash-user", "crash-key", "m.c", "h3");
    ledger.markStarted("crash-user", "crash-key");

    const result = ledger.reserve("crash-user", "crash-key", "m.c", "h3");
    expect(result.status).toBe("unknown");
  });

  it("completed replay works after markStarted + complete cycle", () => {
    ledger.reserve("replay-user", "rk1", "m.r", "h4");
    ledger.markStarted("replay-user", "rk1");
    ledger.complete("replay-user", "rk1", '"done"');

    const result = ledger.reserve("replay-user", "rk1", "m.r", "h4");
    expect(result.status).toBe("completed");
    if (result.status === "completed") expect(result.responseJson).toBe('"done"');
  });

  it("markUnknown sets outcome_unknown state", () => {
    ledger.reserve("unk-user", "unk-key", "m.u", "h5");
    ledger.markUnknown("unk-user", "unk-key");
    const row = db.prepare("SELECT state FROM abmind_service_requests WHERE principal_id = ? AND idempotency_key = ?").get("unk-user", "unk-key") as { state: string };
    expect(row.state).toBe("outcome_unknown");
  });

  it("cleanup removes old completed entries", () => {
    const oldTime = Date.now() - 40 * 24 * 3600_000;
    db.prepare(`
      INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'completed', '{}', ?, ?)
    `).run("cleanup-user", "old-key", "m", "h", oldTime, oldTime);

    ledger.cleanup();

    const row = db.prepare("SELECT COUNT(*) as c FROM abmind_service_requests WHERE principal_id = ?").get("cleanup-user") as { c: number };
    expect(row.c).toBe(0);
  });
});
