/**
 * #1383 — lifecycle RPC tests: the six private.lifecycle* owner methods.
 * Each test proves a contract behavior through the real AbmindService
 * dispatch (validation, principal match, idempotency gate, delegation to
 * HostMemoryLifecycle): it would fail if the method, gate, or delegation
 * were removed or wired to the wrong owner.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AbmindService, AbmindRequestLedger } from "./abmind-service.js";
import type { AbmindRequestV1, ServiceCallContext, AbmindMethod } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
import type { ExecutionIdentity } from "./host-integration/types.js";

const PRINCIPAL = "hermes-user";

function makeContext(overrides?: Partial<ServiceCallContext>): ServiceCallContext {
  return {
    principalId: PRINCIPAL,
    role: "local_user",
    grantedDomains: new Set(["system", "private", "operational"]),
    authenticatedBy: "local_peer",
    ...overrides,
  };
}

function identity(overrides?: Partial<ExecutionIdentity>): ExecutionIdentity {
  return {
    principalId: PRINCIPAL,
    conversationId: "sess-1",
    executionId: "turn-1",
    host: "hermes",
    origin: "agent",
    automaticWriteOwner: PRINCIPAL,
    ...overrides,
  };
}

function makeRequest<K extends AbmindMethod>(method: K, payload: unknown, idempotencyKey?: string): AbmindRequestV1<K> {
  return {
    version: ABMIND_PROTOCOL_VERSION,
    requestId: `test-${method}`,
    method,
    payload: payload as never,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

interface RecordedMessage {
  userId: string;
  sessionId: string;
  role: string;
  content: string;
}

class LifecycleMockManager {
  recorded: RecordedMessage[] = [];
  lastRecallParams: Record<string, unknown> | null = null;
  private nextId = 1;

  buildWakeUp() { return "wake-up-context"; }
  async recallSearch(params: Record<string, unknown>) {
    this.lastRecallParams = params;
    return {
      results: [
        { id: 7, content: "Hermes uses abmind", date: "2026-09-01", source: "test", score: 0.9, semanticRevision: 3 },
        { content: "unidentified fragment", date: "2026-09-02", source: "test", score: 0.5 },
      ],
      stages: {},
      shortCircuitAfter: null,
      extractedIds: [7],
      decision: {
        version: 1, outcome: "continue", sourceIds: [7], sourceRevisions: { 7: 3 },
        selectedRefs: [7], profile: "none", questionSet: "none",
      },
    };
  }
  recordMessage(r: RecordedMessage): number | null {
    this.recorded.push(r);
    return this.nextId++;
  }
  editor = {
    instantStore: () => Promise.resolve({ stored: true, memoriesCount: 1, memoryId: 9, semanticRevision: 1 }),
  };
}

let tmpDir: string;
let db: Database.Database;
let service: AbmindService;
let manager: LifecycleMockManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lifecycle-rpc-"));
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
  `);
  manager = new LifecycleMockManager();
  service = new AbmindService({
    serverInstanceId: "test", mode: "embedded", manager: manager as never, operational: null, requestLedgerDb: db,
  });
});

afterEach(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("private.lifecycle* RPCs", () => {
  it("startSession returns wake-up context for valid identity", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleStartSession", { identity: identity(), maxChars: 1000 }),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toMatchObject({ ok: true, context: "wake-up-context" });
  });

  it("prepareTurn returns context, id/revision refs, and the decision envelope", async () => {
    const res = await service.handle(
      makeRequest("private.lifecyclePrepareTurn", {
        identity: identity(),
        prompt: "what do we use?",
        query: { translated: ["what", "use"] },
        policy: { limit: 5, maxChars: 2000 },
      }),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      const r = res.result as { context: string; hits: Array<{ id?: number; revision?: number }>; decision?: { outcome: string } };
      expect(r.context).toContain("Hermes uses abmind");
      expect(r.hits[0]).toMatchObject({ id: 7, revision: 3 });
      expect(r.hits[1]).not.toHaveProperty("id");
      expect(r.decision).toMatchObject({ outcome: "continue" });
    }
  });

  it("rejects a missing identity object with validation_error", async () => {
    const res = await service.handle(
      makeRequest("private.lifecyclePrepareTurn", {
        query: { translated: ["x"] },
        policy: { limit: 5, maxChars: 2000 },
      }),
      makeContext(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation_error");
  });

  it("rejects a principal mismatch as unauthorized", async () => {
    const res = await service.handle(
      makeRequest("private.lifecyclePrepareTurn", {
        identity: identity({ principalId: "someone-else" }),
        query: { translated: ["x"] },
        policy: { limit: 5, maxChars: 2000 },
      }),
      makeContext(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unauthorized");
  });

  it("completeTurn records user+assistant and returns message ids", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleCompleteTurn", {
        identity: identity(),
        user: { content: "hello" },
        assistant: { content: "hi there" },
      }, "key-complete-1"),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toMatchObject({ status: "recorded" });
    expect(manager.recorded.map(m => [m.role, m.sessionId])).toEqual([
      ["user", "sess-1"],
      ["assistant", "sess-1"],
    ]);
  });

  it("completeTurn skips when the host names a different write owner", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleCompleteTurn", {
        identity: identity({ automaticWriteOwner: "other-writer" }),
        user: { content: "hello" },
        assistant: { content: "hi" },
      }, "key-complete-2"),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toMatchObject({ status: "skipped", reason: "not_owner" });
    expect(manager.recorded).toEqual([]);
  });

  it("completeTurn without an idempotency key fails validation", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleCompleteTurn", {
        identity: identity(),
        user: { content: "hello" },
      }),
      makeContext(),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("validation_error");
  });

  it("checkpoint records evidence under the checkpoint session and acks ids", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleCheckpoint", {
        identity: identity(),
        messages: [
          { role: "user", content: "about to be compressed" },
          { role: "assistant", content: "" },
        ],
      }, "key-checkpoint-1"),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toMatchObject({ status: "checkpointed", rejected: 1 });
      const ids = (res.result as { messageIds: number[] }).messageIds;
      expect(ids).toHaveLength(1);
    }
    expect(manager.recorded.map(m => m.sessionId)).toEqual(["sess-1:precompress"]);
  });

  it("checkpoint with no messages reports skipped, never success", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleCheckpoint", { identity: identity(), messages: [] }, "key-checkpoint-2"),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toMatchObject({ status: "skipped", reason: "empty" });
  });

  it("store with an invalid identity field returns a validation-shaped failure", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleStore", {
        identity: identity({ conversationId: "" }),
        contentEn: "fact",
        contentOriginal: "fact",
        memoryType: "fact",
      }, "key-store-1"),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.result).toMatchObject({ stored: false, code: "validation_error" });
    }
  });

  it("recall forwards releaseScope into the recall fast-path intent", async () => {
    const res = await service.handle(
      makeRequest("private.lifecycleRecall", {
        identity: identity(),
        query: { translated: ["again"] },
        fastPath: { question: "Again?", delivered: [{ id: 7, revision: 3 }], releaseScope: true },
      }),
      makeContext(),
    );
    expect(res.ok).toBe(true);
    const fp = manager.lastRecallParams?.fastPath as { releaseScope?: boolean; turn?: string } | undefined;
    expect(fp?.releaseScope).toBe(true);
    expect(fp?.turn).toBe("turn-1");
  });
});
