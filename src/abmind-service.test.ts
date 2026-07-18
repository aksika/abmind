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

  it("returns conflict for different method with same key", () => {
    ledger.reserve("user1", "key3", "method.a", "hash1");
    ledger.complete("user1", "key3", '"ok"');
    const result = ledger.reserve("user1", "key3", "method.b", "hash2");
    expect(result.status).toBe("conflict");
  });

  it("returns unknown for incomplete reservation", () => {
    ledger.reserve("user1", "key-unknown", "method.a", "hash1");
    const result = ledger.reserve("user1", "key-unknown", "method.a", "hash1");
    expect(result.status).toBe("unknown");
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
