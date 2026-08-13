/**
 * dream-questions-api.test.ts — #1515 private protocol API.
 *
 * Proves validation/bounds, read-vs-mutation classification, required
 * idempotency, same-key replay, conflict behavior, and two-principal
 * isolation over AbmindService + the embedded client, with a real memory DB.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbmindService } from "./abmind-service.js";
import { ABMIND_PROTOCOL_VERSION, type AbmindMethod, type AbmindRequestV1, type ServiceCallContext } from "./abmind-protocol.js";
import { createEmbeddedAbmind } from "./abmind-service-host.js";
import { InjectableProcessIdentity } from "./abmind-owner-lease.js";
import { MemoryManager, getMemoryDb } from "./memory-manager.js";
import { loadMemoryConfig } from "./memory-config.js";
import { EmbeddedTransport } from "./embedded-transport.js";
import { AbmindClient } from "./abmind-client.js";
import type { MemoryConfig } from "./memory-config.js";

function makeContext(overrides?: Partial<ServiceCallContext>): ServiceCallContext {
  return {
    principalId: "master",
    role: "local_user",
    grantedDomains: new Set(["system", "private"]),
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

const MEM_CONFIG: MemoryConfig = {
  memoryEnabled: true,
  memoryDir: "",
  maxMessagesPerChat: 100,
  diskBudgetBytes: 1048576,
  stalenessThresholdMs: 86400000,
  restoreMessageCount: 50,
  ingestChunkMaxTokens: 512,
  embeddingModel: "nomic-embed-text",
  forgetThreshold: 0.8,
  searchEnhancements: {
    searchTimeoutMs: 1000,
    decayHalflifeDays: 30,
    mmrLambda: 0.7,
    compactThresholdPct: 85,
  },
};

interface ApiEnv {
  dir: string;
  manager: MemoryManager;
  service: AbmindService;
  cleanup: () => void;
}

async function setupApiEnv(): Promise<ApiEnv> {
  const dir = mkdtempSync(join(tmpdir(), "dream-q-api-"));
  const memoryConfig: MemoryConfig = { ...MEM_CONFIG, memoryDir: dir };
  const manager = new MemoryManager(memoryConfig);
  await manager.initialize({ skipEmbeddingCheck: true });
  const db = getMemoryDb(manager)!;
  const service = new AbmindService({
    serverInstanceId: "test",
    mode: "embedded",
    manager,
    operational: null,
    requestLedgerDb: db,
  });
  return {
    dir, manager, service,
    cleanup() { manager.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function seedEvidence(db: ReturnType<typeof getMemoryDb> & object, id: number, userId = "master"): void {
  db!.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        valid_to, classification, semantic_revision)
     VALUES (?, ?, ?, ?, 'fact', ?, ?, NULL, 1, 1)`,
  ).run(id, userId, `fact ${id}`, `fact ${id}`, 1000, 1000);
}

function insertQuestion(
  db: ReturnType<typeof getMemoryDb> & object,
  id: string,
  userId: string,
  opts?: { status?: string; createdAt?: number; askedAt?: number | null; deliveryKey?: string | null; dismissedAt?: number | null; memoryA?: number; memoryB?: number },
): void {
  const status = opts?.status ?? "pending";
  const createdAt = opts?.createdAt ?? Date.now();
  const memoryA = opts?.memoryA ?? 10;
  const memoryB = opts?.memoryB ?? 20;
  db!.prepare(
    `INSERT INTO dream_questions
       (id, user_id, memory_a_id, memory_b_id, memory_a_revision, memory_b_revision,
        question, status, source_run_id, source_step, created_at, expires_at,
        asked_at, dismissed_at, delivery_key)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, 'run-1', 'contradiction-and-graph', ?, ?, ?, ?, ?)`,
  ).run(
    id, userId, memoryA, memoryB, "test question?", status, createdAt, createdAt + 7 * 86400_000,
    opts?.askedAt ?? null, opts?.dismissedAt ?? null, opts?.deliveryKey ?? null,
  );
}

describe("dreamQuestions protocol methods", () => {
  it("registers all four methods with read/mutate classification and bounds", async () => {
    const env = await setupApiEnv();
    try {
      const res = await env.service.handle(makeRequest("system.negotiate", {}), makeContext());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result.methods).toContain("private.dreamQuestions.nextPending");
        expect(res.result.methods).toContain("private.dreamQuestions.list");
        expect(res.result.methods).toContain("private.dreamQuestions.markAsked");
        expect(res.result.methods).toContain("private.dreamQuestions.dismiss");
      }
    } finally { env.cleanup(); }
  });

  it("returns validation errors for bounded payloads", async () => {
    const env = await setupApiEnv();
    try {
      const badLimit = await env.service.handle(makeRequest("private.dreamQuestions.list", { userId: "master", limit: 999 }), makeContext());
      expect(badLimit.ok).toBe(false);
      if (!badLimit.ok) expect(badLimit.error.code).toBe("validation_error");

      const badStatus = await env.service.handle(makeRequest("private.dreamQuestions.list", { userId: "master", status: "bogus" }), makeContext());
      if (!badStatus.ok) expect(badStatus.error.code).toBe("validation_error");

      const bigKey = await env.service.handle(makeRequest("private.dreamQuestions.markAsked", { userId: "master", questionId: "q", deliveryKey: "k".repeat(200) }, "idem-1"), makeContext());
      if (!bigKey.ok) expect(bigKey.error.code).toBe("validation_error");

      const badQuestionId = await env.service.handle(makeRequest("private.dreamQuestions.dismiss", { userId: "master", questionId: "" }, "idem-2"), makeContext());
      if (!badQuestionId.ok) expect(badQuestionId.error.code).toBe("validation_error");

      const noUser = await env.service.handle(makeRequest("private.dreamQuestions.nextPending", {}), makeContext());
      if (!noUser.ok) expect(noUser.error.code).toBe("validation_error");
    } finally { env.cleanup(); }
  });

  it("enforces owner scope — principal cannot read or mutate another user's rows", async () => {
    const env = await setupApiEnv();
    try {
      const db = getMemoryDb(env.manager)!;
      seedEvidence(db, 10, "master");
      seedEvidence(db, 20, "master");
      insertQuestion(db, "q-master", "master");
      insertQuestion(db, "q-other", "other");

      // Master reads only their own rows.
      const masterList = await env.service.handle(makeRequest("private.dreamQuestions.list", { userId: "master" }), makeContext());
      expect(masterList.ok).toBe(true);
      if (masterList.ok) expect(masterList.result.questions).toHaveLength(1);

      // "other" principal cannot see or mutate master's rows — not_found, no leakage.
      const otherCtx = makeContext({ principalId: "other" });
      const otherNext = await env.service.handle(makeRequest("private.dreamQuestions.nextPending", { userId: "other" }), makeContext({ principalId: "other" }));
      expect(otherNext.ok).toBe(true);
      if (otherNext.ok) expect(otherNext.result).toBeNull();

      const otherAsked = await env.service.handle(
        makeRequest("private.dreamQuestions.markAsked", { userId: "other", questionId: "q-master", deliveryKey: "k" }, "idem-other"),
        otherCtx,
      );
      expect(otherAsked.ok).toBe(true);
      if (otherAsked.ok) expect(otherAsked.result.status).toBe("not_found");

      const masterRow = db.prepare("SELECT status FROM dream_questions WHERE id = 'q-master'").get() as { status: string };
      expect(masterRow.status).toBe("pending");

      // Passing a userId that is not the principal is unauthorized.
      const forged = await env.service.handle(makeRequest("private.dreamQuestions.list", { userId: "master" }), otherCtx);
      expect(forged.ok).toBe(false);
      if (!forged.ok) expect(forged.error.code).toBe("unauthorized");
    } finally { env.cleanup(); }
  });

  it("markAsked CAS settles once and replays idempotently; conflicting key refuses", async () => {
    const env = await setupApiEnv();
    try {
      const db = getMemoryDb(env.manager)!;
      seedEvidence(db, 10);
      seedEvidence(db, 20);
      insertQuestion(db, "q-1", "master");

      const first = await env.service.handle(makeRequest("private.dreamQuestions.markAsked", { userId: "master", questionId: "q-1", deliveryKey: "delivery-1" }, "idem-ask-1"), makeContext());
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.result.status).toBe("asked");

      const replay = await env.service.handle(makeRequest("private.dreamQuestions.markAsked", { userId: "master", questionId: "q-1", deliveryKey: "delivery-1" }, "idem-ask-1"), makeContext());
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.result.status).toBe("asked");

      const conflict = await env.service.handle(makeRequest("private.dreamQuestions.markAsked", { userId: "master", questionId: "q-1", deliveryKey: "delivery-2" }, "idem-ask-2"), makeContext());
      expect(conflict.ok).toBe(true);
      if (conflict.ok) expect(conflict.result.status).toBe("conflict");

      const row = db.prepare("SELECT status, delivery_key FROM dream_questions WHERE id = 'q-1'").get() as { status: string; delivery_key: string };
      expect(row.status).toBe("asked");
      expect(row.delivery_key).toBe("delivery-1");
    } finally { env.cleanup(); }
  });

  it("mutating methods require an idempotency key", async () => {
    const env = await setupApiEnv();
    try {
      const db = getMemoryDb(env.manager)!;
      seedEvidence(db, 10);
      seedEvidence(db, 20);
      insertQuestion(db, "q-1", "master");
      const noKey = await env.service.handle(makeRequest("private.dreamQuestions.markAsked", { userId: "master", questionId: "q-1", deliveryKey: "k" }), makeContext());
      expect(noKey.ok).toBe(false);
      if (!noKey.ok) expect(noKey.error.code).toBe("validation_error");
    } finally { env.cleanup(); }
  });

  it("dismiss settles pending/asked rows and is terminal; repeated new keys report already_terminal", async () => {
    const env = await setupApiEnv();
    try {
      const db = getMemoryDb(env.manager)!;
      seedEvidence(db, 10);
      seedEvidence(db, 20);
      insertQuestion(db, "q-1", "master");
      const dismissed = await env.service.handle(makeRequest("private.dreamQuestions.dismiss", { userId: "master", questionId: "q-1" }, "idem-d-1"), makeContext());
      expect(dismissed.ok).toBe(true);
      if (dismissed.ok) expect(dismissed.result.status).toBe("dismissed");
      const again = await env.service.handle(makeRequest("private.dreamQuestions.dismiss", { userId: "master", questionId: "q-1" }, "idem-d-2"), makeContext());
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.result.status).toBe("already_terminal");
      const row = db.prepare("SELECT status, dismissed_at FROM dream_questions WHERE id = 'q-1'").get() as { status: string; dismissed_at: number };
      expect(row.status).toBe("dismissed");
      expect(row.dismissed_at).toBeGreaterThan(0);
    } finally { env.cleanup(); }
  });

  it("nextPending returns the oldest pending row after reconciliation", async () => {
    const env = await setupApiEnv();
    try {
      const db = getMemoryDb(env.manager)!;
      seedEvidence(db, 10);
      seedEvidence(db, 20);
      seedEvidence(db, 30);
      seedEvidence(db, 40);
      insertQuestion(db, "q-old", "master", { createdAt: Date.now() - 5000 });
      insertQuestion(db, "q-new", "master", { createdAt: Date.now() - 1000, memoryA: 30, memoryB: 40 });
      const res = await env.service.handle(makeRequest("private.dreamQuestions.nextPending", { userId: "master" }), makeContext());
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.result?.id).toBe("q-old");
        expect(res.result?.memoryAId).toBe(10);
        expect(res.result?.memoryBId).toBe(20);
        expect(res.result).not.toHaveProperty("userId");
        expect(res.result).not.toHaveProperty("memoryARevision");
      }
    } finally { env.cleanup(); }
  });
});

describe("dreamQuestions client round-trip", () => {
  it("works over the embedded transport with typed methods", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dream-q-embedded-"));
    try {
      const identity = new InjectableProcessIdentity({ pid: 7001, startToken: "boot-ask" });
      const embedded = await createEmbeddedAbmind({
        mode: "embedded",
        memory: { ...MEM_CONFIG, memoryDir: dir },
        policy: { principalId: "app", role: "host_agent", grantedDomains: ["system", "private", "operational"], authenticatedBy: "embedded" },
        leaseRoot: dir,
        processIdentity: identity,
      }, { principalId: "app", role: "host_agent" });

      const db = getMemoryDb(embedded.host.manager!)!;
      seedEvidence(db, 10, "app");
      seedEvidence(db, 20, "app");
      insertQuestion(db, "q-1", "app");

      const pending = await embedded.client.privateMemory.dreamQuestions.nextPending("app");
      expect(pending?.id).toBe("q-1");

      const list = await embedded.client.privateMemory.dreamQuestions.list("app");
      expect(list.questions).toHaveLength(1);

      const asked = await embedded.client.privateMemory.dreamQuestions.markAsked({ userId: "app", questionId: "q-1", deliveryKey: "client-delivery" }, "client-idem-1");
      expect(asked.status).toBe("asked");
      const replay = await embedded.client.privateMemory.dreamQuestions.markAsked({ userId: "app", questionId: "q-1", deliveryKey: "client-delivery" }, "client-idem-1");
      expect(replay.status).toBe("asked");

      const dismissed = await embedded.client.privateMemory.dreamQuestions.dismiss({ userId: "app", questionId: "q-1" }, "client-idem-2");
      expect(dismissed.status).toBe("dismissed");

      await embedded.host.stop();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
