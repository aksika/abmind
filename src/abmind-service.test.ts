import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AbmindService, AbmindRequestLedger } from "./abmind-service.js";
import type { AbmindRequestV1, ServiceCallContext, AbmindMethod } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION, canonicalPayloadHash } from "./abmind-protocol.js";
import { ensureInitialized } from "./ensure-initialized.js";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";

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
    instantStore: () => ({ stored: true, memoriesCount: 1, memoryId: 1, semanticRevision: 1 } as never),
    editMemory: () => ({ ok: true } as never),
    reclassifyMemory: () => {},
    adjustRelevance: () => {},
    mergeMemories: () => ({ merged: true, keptId: 1, deletedId: 2 } as never),
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

    it("advertises private.cascadeDelete under the active owner-delete contract", async () => {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
      });
      const res = await service.handle(makeRequest("system.negotiate", {}), makeContext());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result.methods).toContain("private.cascadeDelete");
      }
    });

    it("rejects invalid cascade payloads before ledger reservation", async () => {
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
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
      const invalidPayloads = [
        { userId: "user-alice", messageIds: [] },
        { userId: "user-alice", messageIds: [1, 1] },
        { userId: "user-alice", messageIds: [0] },
        { userId: "user-alice", messageIds: [1.5] },
        { userId: "user-alice", messageIds: "1,2" },
        { userId: "user-alice" },
      ];
      for (const payload of invalidPayloads) {
        const res = await service.handle(makeRequest("private.cascadeDelete", payload, "idem-invalid"), ctx);
        expect(res.ok, JSON.stringify(payload)).toBe(false);
        if (!res.ok) expect(res.error.code).toBe("validation_error");
      }
      const reserved = ledgerDb.prepare("SELECT COUNT(*) AS c FROM abmind_service_requests WHERE idempotency_key = ?").get("idem-invalid") as { c: number };
      expect(reserved.c).toBe(0);
      ledgerDb.close();
    });

    it("rejects cascade input for a different principal without disclosing existence", async () => {
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
      const ctx = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
      const res = await service.handle(makeRequest("private.cascadeDelete", { userId: "user-bob", messageIds: [1] }, "idem-foreign"), ctx);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("unauthorized");
      ledgerDb.close();
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
        state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','in_flight','completed','outcome_unknown')),
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
    expect(ledger.markStarted("user1", "key2")).toBe(true);
    expect(ledger.complete("user1", "key2", '{"ok":true,"result":"done"}')).toBe(true);
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

  it("returns outcome_unknown for a non-live incomplete reservation with same method/hash", () => {
    ledger.reserve("user1", "key-unknown", "method.a", "hash1");
    const result = ledger.reserve("user1", "key-unknown", "method.a", "hash1");
    expect(result.status).toBe("outcome_unknown");
  });

  it("returns in_flight for a live markStarted row", () => {
    ledger.reserve("user1", "key-live", "method.a", "hash1");
    ledger.markStarted("user1", "key-live");
    const result = ledger.reserve("user1", "key-live", "method.a", "hash1");
    expect(result.status).toBe("in_flight");
  });

  it("markStarted targets specific principal/key", () => {
    ledger.reserve("user-a", "k1", "m.a", "h1");
    ledger.reserve("user-b", "k2", "m.b", "h2");
    ledger.markStarted("user-a", "k1");

    const rowA = db.prepare("SELECT state FROM abmind_service_requests WHERE principal_id = ? AND idempotency_key = ?").get("user-a", "k1") as { state: string };
    const rowB = db.prepare("SELECT state FROM abmind_service_requests WHERE principal_id = ? AND idempotency_key = ?").get("user-b", "k2") as { state: string };
    expect(rowA.state).toBe("in_flight");
    expect(rowB.state).toBe("reserved");
  });

  it("crash-window: in_flight + restart returns outcome_unknown", () => {
    ledger.reserve("crash-user", "crash-key", "m.c", "h3");
    ledger.markStarted("crash-user", "crash-key");
    expect(ledger.reserve("crash-user", "crash-key", "m.c", "h3").status).toBe("in_flight");

    // A host restart loses the in-process owner and converts the row.
    ledger.recoverCrashed();
    expect(ledger.reserve("crash-user", "crash-key", "m.c", "h3").status).toBe("outcome_unknown");
  });

  it("recoverCrashed converts in-flight rows to tombstones and never cleans them", () => {
    ledger.reserve("rc-user", "rc-reserved", "m.r", "h1");
    ledger.reserve("rc-user", "rc-started", "m.r", "h2");
    ledger.markStarted("rc-user", "rc-started");
    ledger.reserve("rc-user", "rc-completed", "m.r", "h3");
    ledger.markStarted("rc-user", "rc-completed");
    ledger.complete("rc-user", "rc-completed", '"done"');
    ledger.reserve("rc-user", "rc-unknown", "m.r", "h4");
    ledger.markUnknown("rc-user", "rc-unknown");

    ledger.recoverCrashed();

    const state = (key: string): string =>
      (db.prepare("SELECT state FROM abmind_service_requests WHERE idempotency_key = ?").get(key) as { state: string }).state;
    expect(state("rc-reserved")).toBe("outcome_unknown");
    expect(state("rc-started")).toBe("outcome_unknown");
    expect(state("rc-completed")).toBe("completed");
    expect(state("rc-unknown")).toBe("outcome_unknown");

    ledger.cleanup();
    expect(state("rc-reserved")).toBe("outcome_unknown");
    expect(state("rc-unknown")).toBe("outcome_unknown");
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

  it("never completes a crash-recovered tombstone", () => {
    ledger.reserve("tombstone-user", "tombstone-key", "m.t", "h6");
    expect(ledger.markStarted("tombstone-user", "tombstone-key")).toBe(true);
    ledger.recoverCrashed();

    expect(ledger.complete("tombstone-user", "tombstone-key", '"late"')).toBe(false);
    const row = db.prepare(
      "SELECT state, response_json FROM abmind_service_requests WHERE principal_id = ? AND idempotency_key = ?",
    ).get("tombstone-user", "tombstone-key") as { state: string; response_json: string | null };
    expect(row.state).toBe("outcome_unknown");
    expect(row.response_json).toBeNull();
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

describe("#1659 mutation failure contract", () => {
  let tempDir: string;
  let manager: MemoryManager;
  let ledgerDb: Database.Database;
  let service: AbmindService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "failure-contract-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
    ledgerDb = getMemoryDb(manager)!;
    service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager, operational: null, requestLedgerDb: ledgerDb,
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function ctx(principalId: string): ServiceCallContext {
    return makeContext({ grantedDomains: new Set(["private", "system"]), principalId });
  }

  it("maps validation failures to fix_input/pre_dispatch with a preserved request ID", async () => {
    const res = await service.handle(makeRequest("private.edit", {
      userId: "user-alice", memoryId: 0, expectedRevision: 1,
    }, "idem-valid"), ctx("user-alice"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({ code: "validation_error", retryable: false, action: "fix_input", stage: "pre_dispatch" });
      expect(res.requestId).toBe("test-req-1");
    }
  });

  it("maps idempotency conflicts to stop without dispatch", async () => {
    const payload = { userId: "user-alice", memoryId: 1, expectedRevision: 1, contentEn: "first" };
    const key = "idem-stop-key";
    const first = await service.handle(makeRequest("private.edit", payload, key), ctx("user-alice"));
    expect(first.ok).toBe(false); // memory 1 does not exist → not_found
    const changed = await service.handle(makeRequest("private.edit", { ...payload, contentEn: "changed" }, key), ctx("user-alice"));
    expect(changed.ok).toBe(false);
    if (!changed.ok) {
      expect(changed.error).toMatchObject({ code: "idempotency_conflict", retryable: false, action: "stop" });
    }
  });

  it("returns outcome_unknown/reconcile for a crash-recovered key and never re-executes", async () => {
    const payload = { userId: "user-alice", memoryId: 1, expectedRevision: 1, contentEn: "crash" };
    const key = "crash-recovered-key";
    const payloadHash = canonicalPayloadHash(ABMIND_PROTOCOL_VERSION, "private.edit", payload);
    ledgerDb.prepare(`
      INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
      VALUES ('user-alice', ?, 'private.edit', ?, 'dispatch_started', NULL, ?, ?)
    `).run(key, payloadHash, Date.now(), Date.now());

    const res = await service.handle(makeRequest("private.edit", payload, key), ctx("user-alice"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({ code: "outcome_unknown", retryable: false, action: "reconcile", stage: "response" });
    }
    const row = ledgerDb.prepare("SELECT state FROM abmind_service_requests WHERE idempotency_key = ?").get(key) as { state: string };
    expect(row.state).not.toBe("completed");
    const count = ledgerDb.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("turns a generic post-dispatch exception into a non-reusable outcome_unknown tombstone", async () => {
    class ThrowingManager extends MockManager {
      override editor = {
        ...new MockManager().editor,
        instantStore: () => { throw new Error("post-dispatch explosion"); },
      };
    }
    const ledger = new Database(":memory:");
    ledger.exec(`CREATE TABLE abmind_service_requests (
      principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL, response_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, idempotency_key)
    )`);
    const svc = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new ThrowingManager() as never, operational: null, requestLedgerDb: ledger,
    });
    const ctxCall = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
    const payload = { userId: "user-alice", contentEn: "boom", contentOriginal: "boom", memoryType: "fact" };
    const key = "generic-boom-key";

    const res = await svc.handle(makeRequest("private.instantStore", payload, key), ctxCall);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({ code: "outcome_unknown", retryable: false, action: "reconcile", stage: "response" });
      expect(res.error.message).toContain("post-dispatch explosion");
    }

    const row = ledger.prepare("SELECT state FROM abmind_service_requests WHERE idempotency_key = ?").get(key) as { state: string };
    expect(row.state).toBe("outcome_unknown");

    const replay = await svc.handle(makeRequest("private.instantStore", payload, key), ctxCall);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.error.code).toBe("outcome_unknown");
    ledger.close();
  });

  it("exposes instant-store typed rejections as structured protocol errors", async () => {
    const res = await service.handle(makeRequest("private.instantStore", {
      userId: "system", contentEn: "blocked text", contentOriginal: "blocked text", memoryType: "fact",
    }, "idem-blocked-store"), ctx("system"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({ code: "unauthorized", retryable: false, action: "stop", stage: "pre_dispatch" });
      expect(res.error.message).toContain("blocked");
      expect(res.requestId).toBe("test-req-1");
    }
  });

  it("emits correlated accepted/completed events without logging the raw idempotency key", async () => {
    const lines: string[] = [];
    const originalError = console.error;
    console.error = (line: unknown) => { lines.push(String(line)); };
    try {
      const payload = { userId: "user-alice", sessionId: "s1", role: "user", content: "trace me", timestamp: 1 };
      const secretKey = "trace-super-secret-key-9f3k";
      const res = await service.handle(makeRequest("private.recordMessage", payload, secretKey), ctx("user-alice"));
      expect(res.ok, JSON.stringify(res)).toBe(true);

      const accepted = lines.filter(l => l.includes("[ACCEPTED]") && l.includes("private.recordMessage"));
      const completed = lines.filter(l => l.includes("[COMPLETED]") && l.includes("private.recordMessage") && l.includes("outcome=ok"));
      expect(accepted.length).toBe(1);
      expect(completed.length).toBe(1);
      for (const l of [...accepted, ...completed]) {
        expect(l).not.toContain(secretKey);
      }
    } finally {
      console.error = originalError;
    }
  });
});

describe("#1659 live in-flight replay", () => {
  let tempDir: string;
  let manager: MemoryManager;
  let ledgerDb: Database.Database;
  let service: AbmindService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "in-flight-replay-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
    ledgerDb = getMemoryDb(manager)!;
    service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager, operational: null, requestLedgerDb: ledgerDb,
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function ctx(principalId: string): ServiceCallContext {
    return makeContext({ grantedDomains: new Set(["private", "system"]), principalId });
  }

  it("two concurrent matching requests execute exactly one mutation and both receive the committed outcome", async () => {
    let storeCalls = 0;
    let releaseStore!: (value: unknown) => void;
    class DelayedManager extends MockManager {
      override editor = {
        ...new MockManager().editor,
        instantStore: () => {
          storeCalls++;
          return new Promise((resolve) => { releaseStore = resolve; });
        },
      };
    }
    const ledger = new Database(":memory:");
    ledger.exec(`CREATE TABLE abmind_service_requests (
      principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','in_flight','completed','outcome_unknown')),
      response_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, idempotency_key)
    )`);
    const svc = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new DelayedManager() as never, operational: null, requestLedgerDb: ledger,
    });
    const ctxCall = makeContext({ grantedDomains: new Set(["private"]), principalId: "user-alice" });
    const payload = { userId: "user-alice", contentEn: "concurrent", contentOriginal: "concurrent", memoryType: "fact" };
    const key = "live-replay-key";

    const firstReq = makeRequest("private.instantStore", payload, key);
    firstReq.requestId = "live-req-a";
    const secondReq = makeRequest("private.instantStore", payload, key);
    secondReq.requestId = "live-req-b";

    const firstPromise = svc.handle(firstReq, ctxCall);
    const secondPromise = svc.handle(secondReq, ctxCall);

    const committed = { ok: true, requestId: "live-req-a", serverInstanceId: "test", result: { stored: true, memoriesCount: 1, memoryId: 77, semanticRevision: 1 } };
    releaseStore(committed.result);

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(storeCalls).toBe(1);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.requestId).toBe("live-req-a");
      expect(second.requestId).toBe("live-req-b");
      expect(first.result).toEqual(second.result);
    }
    const row = ledger.prepare("SELECT state, response_json FROM abmind_service_requests WHERE idempotency_key = ?").get(key) as { state: string; response_json: string };
    expect(row.state).toBe("completed");
    expect(JSON.parse(row.response_json).requestId).toBe("live-req-a");
    ledger.close();
  });

  it("fails closed when the ledger claims in_flight work without a process owner", async () => {
    const key = "orphaned-in-flight";
    const payload = { userId: "user-alice", contentEn: "orphan", contentOriginal: "orphan", memoryType: "fact" };
    const payloadHash = canonicalPayloadHash(ABMIND_PROTOCOL_VERSION, "private.instantStore", payload);
    ledgerDb.prepare(`
      INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
      VALUES ('user-alice', ?, 'private.instantStore', ?, 'in_flight', NULL, ?, ?)
    `).run(key, payloadHash, Date.now(), Date.now());

    const res = await service.handle(makeRequest("private.instantStore", payload, key), ctx("user-alice"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatchObject({ code: "outcome_unknown", retryable: false, action: "reconcile", stage: "response" });
    }
    const count = ledgerDb.prepare("SELECT COUNT(*) AS c FROM extracted_memories").get() as { c: number };
    expect(count.c).toBe(0);
  });

  it("a different payload under a live in-flight key is still a conflict", async () => {
    const key = "live-conflict-key";
    const payload = { userId: "user-alice", contentEn: "original", contentOriginal: "original", memoryType: "fact" };
    const payloadHash = canonicalPayloadHash(ABMIND_PROTOCOL_VERSION, "private.instantStore", payload);
    ledgerDb.prepare(`
      INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
      VALUES ('user-alice', ?, 'private.instantStore', ?, 'in_flight', NULL, ?, ?)
    `).run(key, payloadHash, Date.now(), Date.now());

    const changed = { userId: "user-alice", contentEn: "changed payload", contentOriginal: "changed", memoryType: "fact" };
    const res = await service.handle(makeRequest("private.instantStore", changed, key), ctx("user-alice"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("idempotency_conflict");
  });
});

describe("#1511 cascade service journey", () => {
  let tempDir: string;
  let manager: MemoryManager;
  let ledgerDb: Database.Database;
  let service: AbmindService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "cascade-service-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
    ledgerDb = getMemoryDb(manager)!;
    service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager, operational: null, requestLedgerDb: ledgerDb,
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function ctx(principalId: string): ServiceCallContext {
    return makeContext({ grantedDomains: new Set(["private", "system"]), principalId });
  }

  function insertMessage(userId: string, content: string): number {
    const result = ledgerDb.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, 's1', 'user', ?, ?)",
    ).run(userId, content, Date.now());
    return Number(result.lastInsertRowid);
  }

  function insertMemory(userId: string, contentEn: string, sourceMessageIds: string): number {
    const result = ledgerDb.prepare(`
      INSERT INTO extracted_memories
        (user_id, content_original, content_en, memory_type, source_timestamp, created_at, source_message_ids)
      VALUES (?, ?, ?, 'fact', ?, ?, ?)
    `).run(userId, contentEn, contentEn, Date.now(), Date.now(), sourceMessageIds);
    return Number(result.lastInsertRowid);
  }

  it("cascades through the service and replays exact-key results, conflicts on changed payload, and retries fresh with zeros", async () => {
    const ownMsg = insertMessage("user-alice", "own message");
    const otherMsg = insertMessage("user-bob", "bob message");
    const ownMem = insertMemory("user-alice", "own fact", String(ownMsg));
    const bobMem = insertMemory("user-bob", "bob fact", String(otherMsg));

    const key = "cascade-key-1";
    const payload = { userId: "user-alice", messageIds: [ownMsg, otherMsg] };

    const first = await service.handle(makeRequest("private.cascadeDelete", payload, key), ctx("user-alice"));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (first.ok) {
      expect(first.result).toEqual({ messagesRemoved: 1, linkedMemoriesRemoved: 1, embeddingsRemoved: 0 });
    }

    expect(ledgerDb.prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").get(ownMsg)!.c).toBe(0);
    expect(ledgerDb.prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").get(otherMsg)!.c).toBe(1);
    expect(ledgerDb.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(ownMem)!.c).toBe(0);
    expect(ledgerDb.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(bobMem)!.c).toBe(1);

    const replay = await service.handle(makeRequest("private.cascadeDelete", payload, key), ctx("user-alice"));
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.result).toEqual({ messagesRemoved: 1, linkedMemoriesRemoved: 1, embeddingsRemoved: 0 });
    }

    const changed = await service.handle(
      makeRequest("private.cascadeDelete", { userId: "user-alice", messageIds: [ownMsg] }, key),
      ctx("user-alice"),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("idempotency_conflict");

    const freshKey = await service.handle(makeRequest("private.cascadeDelete", payload, "cascade-key-2"), ctx("user-alice"));
    expect(freshKey.ok).toBe(true);
    if (freshKey.ok) {
      expect(freshKey.result).toEqual({ messagesRemoved: 0, linkedMemoriesRemoved: 0, embeddingsRemoved: 0 });
    }
  });

  it("propagates store failures as non-success responses, never zero results", async () => {
    const ownMsg = insertMessage("user-alice", "broken link message");
    const memId = insertMemory("user-alice", "broken fact", `${ownMsg},garbage`);

    const res = await service.handle(
      makeRequest("private.cascadeDelete", { userId: "user-alice", messageIds: [ownMsg] }, "cascade-broken"),
      ctx("user-alice"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).not.toBe("validation_error");

    expect(ledgerDb.prepare("SELECT COUNT(*) AS c FROM messages WHERE id = ?").get(ownMsg)!.c).toBe(1);
    expect(ledgerDb.prepare("SELECT COUNT(*) AS c FROM extracted_memories WHERE id = ?").get(memId)!.c).toBe(1);
  });
});

describe("#1527 context projection service journey", () => {
  let tempDir: string;
  let manager: MemoryManager;
  let ledgerDb: Database.Database;
  let service: AbmindService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "projection-service-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
    ledgerDb = getMemoryDb(manager)!;
    service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager, operational: null, requestLedgerDb: ledgerDb,
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function ctx(principalId: string): ServiceCallContext {
    return makeContext({ grantedDomains: new Set(["private", "system"]), principalId });
  }

  function insertMessage(userId: string, sessionId: string, role: string, content: string): number {
    const result = ledgerDb.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, sessionId, role, content, Date.now());
    return Number(result.lastInsertRowid);
  }

  it("projects only prior turns for the owner with a strict exclusive cursor", async () => {
    insertMessage("user-alice", "s1", "user", "first user turn");
    insertMessage("user-alice", "s1", "assistant", "first assistant turn");
    const current = insertMessage("user-alice", "s1", "user", "second user turn");

    const res = await service.handle(makeRequest("private.projectConversationContext", {
      userId: "user-alice", sessionId: "s1", beforeMessageId: current, maxContext: 100_000,
    }), ctx("user-alice"));

    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (res.ok) {
      expect(res.result.messages.map(m => m.content)).toEqual(["first user turn", "first assistant turn"]);
      expect(res.result.messages.some(m => m.content === "second user turn")).toBe(false);
      expect(res.result.sourceMessageCount).toBe(2);
      expect(res.result.version).toBe(1);
    }
  });

  it("denies cursor/session mismatch and mixed-owner sessions as unauthorized", async () => {
    insertMessage("user-alice", "s1", "user", "alice turn");
    const foreignCursor = insertMessage("user-bob", "s1", "user", "bob turn");

    const wrongCursor = await service.handle(makeRequest("private.projectConversationContext", {
      userId: "user-alice", sessionId: "s1", beforeMessageId: foreignCursor, maxContext: 100_000,
    }), ctx("user-alice"));
    expect(wrongCursor.ok).toBe(false);
    if (!wrongCursor.ok) expect(wrongCursor.error.code).toBe("unauthorized");

    const ownCursor = insertMessage("user-alice", "s1", "user", "alice current");
    const wrongSession = await service.handle(makeRequest("private.projectConversationContext", {
      userId: "user-alice", sessionId: "s2", beforeMessageId: ownCursor, maxContext: 100_000,
    }), ctx("user-alice"));
    expect(wrongSession.ok).toBe(false);
    if (!wrongSession.ok) expect(wrongSession.error.code).toBe("unauthorized");

    // Mixed-owner session: the cursor matches the caller, but another user's
    // row in the same session must fail closed with no content.
    const mixedOwner = await service.handle(makeRequest("private.projectConversationContext", {
      userId: "user-alice", sessionId: "s1", beforeMessageId: ownCursor, maxContext: 100_000,
    }), ctx("user-alice"));
    expect(mixedOwner.ok).toBe(false);
    if (!mixedOwner.ok) expect(mixedOwner.error.code).toBe("unauthorized");
  });

  it("rejects a non-user cursor row as validation_error", async () => {
    insertMessage("user-alice", "s1", "user", "history");
    const assistantRow = insertMessage("user-alice", "s1", "assistant", "assistant row");

    const res = await service.handle(makeRequest("private.projectConversationContext", {
      userId: "user-alice", sessionId: "s1", beforeMessageId: assistantRow, maxContext: 100_000,
    }), ctx("user-alice"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation_error");
  });

  it("rejects malformed projection payloads with validation_error", async () => {
    const base = { userId: "user-alice", sessionId: "s1", beforeMessageId: 5, maxContext: 100_000 };

    for (const bad of [
      { ...base, beforeMessageId: -1 },
      { ...base, beforeMessageId: 1.5 },
      { ...base, beforeMessageId: "5" },
      { ...base, maxContext: 255 },
      { ...base, maxContext: 10_000_001 },
      { ...base, extra: "field" },
      { ...base, sessionId: "" },
      { ...base, sessionId: "s".repeat(129) },
    ]) {
      const res = await service.handle(makeRequest("private.projectConversationContext", bad), ctx("user-alice"));
      expect(res.ok, JSON.stringify(res)).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("validation_error");
    }
  });

  it("rejects a request for another principal before projection (resolveUserId)", async () => {
    const res = await service.handle(makeRequest("private.projectConversationContext", {
      userId: "user-bob", sessionId: "s1", beforeMessageId: 1, maxContext: 100_000,
    }), ctx("user-alice"));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unauthorized");
  });

  it("advertises the projection method through negotiation", async () => {
    const res = await service.handle(makeRequest("system.negotiate", {}), ctx("user-alice"));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result.methods).toContain("private.projectConversationContext");
  });
});

describe("#1406 compaction service journey", () => {
  let tempDir: string;
  let manager: MemoryManager;
  let ledgerDb: Database.Database;
  let service: AbmindService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "compaction-service-"));
    manager = new MemoryManager(makeMemoryTestConfig(tempDir));
    await manager.initialize({ skipEmbeddingCheck: true });
    ledgerDb = getMemoryDb(manager)!;
    service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager, operational: null, requestLedgerDb: ledgerDb,
    });
  });

  afterEach(() => {
    manager.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function ctx(principalId: string): ServiceCallContext {
    return makeContext({ grantedDomains: new Set(["private", "system"]), principalId });
  }

  function insertMessage(userId: string, sessionId: string, role: string, content: string): number {
    const result = ledgerDb.prepare(
      "INSERT INTO messages (user_id, session_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)",
    ).run(userId, sessionId, role, content, Date.now());
    return Number(result.lastInsertRowid);
  }

  function seedOwnerTurns(): { cursor: number } {
    for (let t = 1; t <= 3; t++) {
      insertMessage("user-alice", "s1", "user", `turn ${t} user`);
      insertMessage("user-alice", "s1", "assistant", `turn ${t} assistant`);
    }
    const cursor = insertMessage("user-alice", "s1", "user", "current turn");
    return { cursor };
  }

  function preparePayload(userId: string, cursor: number): Record<string, unknown> {
    return {
      userId, sessionId: "s1", beforeMessageId: cursor,
      maxHistoryTokens: 0, minRecentTokens: 0, reason: "manual",
    };
  }

  async function prepareReady(key: string): Promise<Record<string, unknown>> {
    const { cursor } = seedOwnerTurns();
    const res = await service.handle(makeRequest("private.prepareConversationCompaction", preparePayload("user-alice", cursor)), ctx("user-alice"));
    expect(res.ok, JSON.stringify(res)).toBe(true);
    if (!res.ok) throw new Error("prepare failed");
    const out = res.result as { status: string; candidate?: Record<string, unknown> };
    expect(out.status).toBe("ready");
    if (out.status !== "ready") throw new Error("not ready");
    void key;
    return out.candidate!;
  }

  function commitPayload(candidate: Record<string, unknown>, userId = "user-alice"): Record<string, unknown> {
    const { serializedTurns: _s, priorCheckpoint: _p, summaryTokenBudget: _b, ...proof } = candidate;
    const summary = "bounded summary of the compacted prefix";
    return {
      userId,
      sessionId: "s1",
      candidate: proof,
      summary,
      summaryTokenCount: Math.ceil(summary.length / 4),
      summarizer: { provider: "test-provider", model: "test-model" },
      activeRequestModel: "test-model",
      reason: "manual",
    };
  }

  it("prepares, commits atomically, and replays exact-key results; concurrent candidates resolve by CAS", async () => {
    const candidate = await prepareReady("unused");

    const commitKey = "idem-compact-1";
    const first = await service.handle(makeRequest("private.commitConversationCompaction", commitPayload(candidate), commitKey), ctx("user-alice"));
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) return;
    expect(first.result).toMatchObject({ status: "committed", generation: 1 });

    const ptr = ledgerDb.prepare("SELECT generation, checkpoint_id FROM active_context_checkpoint WHERE chat_id = 's1'").get() as { generation: number; checkpoint_id: number };
    expect(ptr.generation).toBe(1);
    expect(ptr.checkpoint_id).toBe(first.result.checkpointId);

    // Exact duplicate (same key + payload) replays the original commit.
    const replay = await service.handle(makeRequest("private.commitConversationCompaction", commitPayload(candidate), commitKey), ctx("user-alice"));
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.result).toMatchObject({ status: "committed", checkpointId: first.result.checkpointId });

    // Changed payload under the same key is an idempotency conflict.
    const changed = await service.handle(
      makeRequest("private.commitConversationCompaction",
        { ...commitPayload(candidate), summary: "a different summary for the same key" }, commitKey),
      ctx("user-alice"),
    );
    expect(changed.ok).toBe(false);
    if (!changed.ok) expect(changed.error.code).toBe("idempotency_conflict");

    // A stale candidate (same generation 0, after the commit) is stale — no write.
    const stale = await service.handle(
      makeRequest("private.commitConversationCompaction", commitPayload(candidate), "idem-compact-2"),
      ctx("user-alice"),
    );
    expect(stale.ok).toBe(true);
    if (stale.ok) expect(stale.result).toEqual({ status: "stale" });

    const count = ledgerDb.prepare("SELECT COUNT(*) AS c FROM context_checkpoints WHERE chat_id = 's1'").get() as { c: number };
    expect(count.c).toBe(1);
  });

  it("prepares are owner-scoped: another principal sees nothing_to_compact; commit by another principal is rejected", async () => {
    // Seed turns first, then a foreign prepare must look empty.
    for (let t = 1; t <= 3; t++) {
      insertMessage("user-alice", "s1", "user", `turn ${t} user`);
      insertMessage("user-alice", "s1", "assistant", `turn ${t} assistant`);
    }
    const foreign = await service.handle(
      makeRequest("private.prepareConversationCompaction", preparePayload("user-bob", 1_000_000)), ctx("user-bob"),
    );
    expect(foreign.ok).toBe(true);
    if (foreign.ok) expect(foreign.result).toEqual({ status: "nothing_to_compact" });

    // Owner prepares, then a foreign commit is rejected without any write.
    const owner = await service.handle(
      makeRequest("private.prepareConversationCompaction", preparePayload("user-alice", 1_000_000)), ctx("user-alice"),
    );
    expect(owner.ok).toBe(true);
    if (!owner.ok || owner.result.status !== "ready") return;

    const commitRes = await service.handle(
      makeRequest("private.commitConversationCompaction", commitPayload(owner.result.candidate, "user-bob"), "idem-foreign-commit"),
      ctx("user-bob"),
    );
    expect(commitRes.ok).toBe(true);
    if (commitRes.ok) expect(commitRes.result).toEqual({ status: "rejected" });
    expect(ledgerDb.prepare("SELECT 1 FROM active_context_checkpoint WHERE chat_id = 's1'").get()).toBeUndefined();
  });

  it("busy: a second prepare for the same session while one candidate is outstanding", async () => {
    for (let t = 1; t <= 3; t++) {
      insertMessage("user-alice", "s1", "user", `turn ${t} user`);
      insertMessage("user-alice", "s1", "assistant", `turn ${t} assistant`);
    }
    const first = await service.handle(makeRequest("private.prepareConversationCompaction", preparePayload("user-alice", 1_000_000)), ctx("user-alice"));
    expect(first.ok).toBe(true);
    expect(first.result).toMatchObject({ status: "ready" });
    const second = await service.handle(makeRequest("private.prepareConversationCompaction", preparePayload("user-alice", 1_000_000)), ctx("user-alice"));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.result).toMatchObject({ status: "busy" });
    // After commit the busy slot is released.
    if (first.ok && first.result.status === "ready") {
      const out = await service.handle(
        makeRequest("private.commitConversationCompaction", commitPayload(first.result.candidate), "idem-busy"),
        ctx("user-alice"),
      );
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.result).toMatchObject({ status: "committed" });
    }
    const after = await service.handle(makeRequest("private.prepareConversationCompaction", preparePayload("user-alice", 1_000_000)), ctx("user-alice"));
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.result).toMatchObject({ status: "nothing_to_compact" });
  });

  it("rejects malformed prepare/commit payloads with validation_error", async () => {
    const base = preparePayload("user-alice", 1_000_000);
    for (const bad of [
      { ...base, maxHistoryTokens: -1 },
      { ...base, minRecentTokens: 1.5 },
      { ...base, reason: "auto" },
      { ...base, beforeMessageId: "5" },
      { ...base, extra: true },
      { ...base, sessionId: "" },
    ]) {
      const res = await service.handle(makeRequest("private.prepareConversationCompaction", bad), ctx("user-alice"));
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("validation_error");
    }

    const { cursor } = seedOwnerTurns();
    const ready = await service.handle(makeRequest("private.prepareConversationCompaction", preparePayload("user-alice", cursor)), ctx("user-alice"));
    expect(ready.ok).toBe(true);
    if (!ready.ok || ready.result.status !== "ready") return;
    const good = commitPayload(ready.result.candidate);
    for (const bad of [
      { ...good, summary: "  " },
      { ...good, summaryTokenCount: -2 },
      { ...good, reason: "auto" },
      { ...good, summarizer: { provider: 7 } },
      { ...good, candidate: { ...good.candidate, version: 2 } },
      { ...good, candidate: { ...good.candidate, sourceDigest: "" } },
      { ...good, extra: true },
    ]) {
      const res = await service.handle(makeRequest("private.commitConversationCompaction", bad, "idem-bad-1"), ctx("user-alice"));
      expect(res.ok, JSON.stringify(bad)).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("validation_error");
    }
  });

  it("exposes the compaction methods through negotiate capabilities", async () => {
    const res = await service.handle(makeRequest("system.negotiate", {}), ctx("user-alice"));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result.methods).toContain("private.prepareConversationCompaction");
      expect(res.result.methods).toContain("private.commitConversationCompaction");
    }
  });
});
