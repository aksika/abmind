import { describe, it, expect } from "vitest";
import { LocalTransport } from "./local-transport.js";
import { LocalEndpointServer } from "./local-endpoint-server.js";
import { AbmindService } from "./abmind-service.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
import type { ServiceCallContext } from "./abmind-protocol.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createFrameAccumulator, encodeFrame } from "./abmind-frame-codec.js";
import Database from "better-sqlite3";

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
  readCoreKnowledge(): string | Promise<string> { return ""; }
  operational = null;
}

const context: ServiceCallContext = {
  principalId: "test", role: "local_user",
  grantedDomains: new Set(["system", "private", "operational"]),
  authenticatedBy: "local_peer",
};

describe("LocalTransport and EndpointServer integration", () => {
  it("request/response round-trip over Unix socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-xport-"));
    const socketPath = join(dir, "test.sock");
    try {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "daemon",
        manager: new MockManager() as never,
        operational: null, requestLedgerDb: null,
      });
      const server = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
      await server.start();

      const transport = new LocalTransport(socketPath);
      const res = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "r1", method: "system.health", payload: {},
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.result).toHaveProperty("status");

      await transport.close();
      await service.close();
      await server.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("negotiate returns capabilities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-xport2-"));
    const socketPath = join(dir, "test2.sock");
    try {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "daemon",
        manager: new MockManager() as never,
        operational: null, requestLedgerDb: null,
      });
      const server = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
      await server.start();

      const transport = new LocalTransport(socketPath);
      const caps = await transport.negotiate();
      expect(caps.version).toBe(1);
      expect(caps.methods).toContain("system.health");

      await transport.close();
      await server.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);

  it("returns unavailable when no server", async () => {
    const transport = new LocalTransport("/nonexistent/socket");
    const res = await transport.request({
      version: ABMIND_PROTOCOL_VERSION, requestId: "r3", method: "system.health", payload: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unavailable");
  }, 15000);

  it("reconnects after server restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-xport3-"));
    const socketPath = join(dir, "test3.sock");
    try {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "daemon",
        manager: new MockManager() as never,
        operational: null, requestLedgerDb: null,
      });
      const server = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
      await server.start();

      const transport = new LocalTransport(socketPath);
      const res1 = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "r4", method: "system.health", payload: {},
      });
      expect(res1.ok).toBe(true);

      await server.stop();

      const server2 = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
      await server2.start();

      const res2 = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "r5", method: "system.health", payload: {},
      });
      expect(res2.ok).toBe(true);

      await transport.close();
      await server2.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("replays the exact pending envelope after a lost response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-xport-retry-"));
    const socketPath = join(dir, "retry.sock");
    const server = createServer();
    let connectionCount = 0;
    let firstRequest: Record<string, unknown> | null = null;

    server.on("connection", (conn) => {
      const acc = createFrameAccumulator();
      conn.on("data", (chunk) => {
        acc.push(chunk);
        const frame = acc.readFrame();
        if (!frame) return;
        const request = JSON.parse(frame.payload.toString("utf-8")) as Record<string, unknown>;
        connectionCount++;
        if (connectionCount === 1) {
          firstRequest = request;
          conn.destroy();
          return;
        }
        expect(request.requestId).toBe(firstRequest?.requestId);
        expect(request.idempotencyKey).toBe(firstRequest?.idempotencyKey);
        const response = JSON.stringify({ ok: true, requestId: request.requestId, serverInstanceId: "retry", result: { status: "healthy" } });
        conn.end(encodeFrame(Buffer.from(response, "utf-8")));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const transport = new LocalTransport(socketPath);
      const response = await transport.request({
        version: ABMIND_PROTOCOL_VERSION,
        requestId: "retry-request",
        method: "system.health",
        idempotencyKey: "retry-idempotency",
        payload: {},
      });
      expect(response.ok).toBe(true);
      expect(connectionCount).toBe(2);
      await transport.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("handles multiple concurrent requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-xport4-"));
    const socketPath = join(dir, "test4.sock");
    try {
      const service = new AbmindService({
        serverInstanceId: "test", mode: "daemon",
        manager: new MockManager() as never,
        operational: null, requestLedgerDb: null,
      });
      const server = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
      await server.start();

      const transport = new LocalTransport(socketPath);
      const results = await Promise.all([
        transport.request({ version: ABMIND_PROTOCOL_VERSION, requestId: "c1", method: "system.health", payload: {} }),
        transport.request({ version: ABMIND_PROTOCOL_VERSION, requestId: "c2", method: "system.health", payload: {} }),
        transport.request({ version: ABMIND_PROTOCOL_VERSION, requestId: "c3", method: "system.health", payload: {} }),
      ]);
      for (const res of results) expect(res.ok).toBe(true);

      await transport.close();
      await server.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});

describe("#1659 LocalTransport generation safety", () => {
  it("discards a partial frame from a lost connection; the replay parses cleanly on the new generation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-split-"));
    const socketPath = join(dir, "split.sock");
    const server = createServer();
    let connIndex = 0;
    const half = Buffer.from(JSON.stringify({ ok: true, requestId: "split-request", serverInstanceId: "s", result: { status: "healthy" } }), "utf-8");
    const fullFrame = encodeFrame(half);

    server.on("connection", (conn) => {
      const acc = createFrameAccumulator();
      const index = ++connIndex;
      conn.on("data", (chunk) => {
        acc.push(chunk);
        const frame = acc.readFrame();
        if (!frame) return;
        if (index === 1) {
          // Write half a response frame, then drop the connection.
          conn.write(fullFrame.subarray(0, fullFrame.length - 3));
          conn.destroy();
          return;
        }
        if (index === 2) {
          conn.write(fullFrame);
        }
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const transport = new LocalTransport(socketPath);
      const response = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "split-request", method: "system.health", payload: {},
      });
      expect(response.ok).toBe(true);
      if (response.ok) expect(response.result).toEqual({ status: "healthy" });
      await transport.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("never opens overlapping connections across rapid drops", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-overlap-"));
    const socketPath = join(dir, "overlap.sock");
    const server = createServer();
    let connIndex = 0;
    let concurrent = 0;
    let maxConcurrent = 0;

    server.on("connection", (conn) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      conn.on("close", () => concurrent--);
      const acc = createFrameAccumulator();
      const index = ++connIndex;
      conn.on("data", (chunk) => {
        acc.push(chunk);
        const frame = acc.readFrame();
        if (!frame) return;
        if (index === 1 || index === 2) {
          conn.destroy();
          return;
        }
        const response = JSON.stringify({ ok: true, requestId: "overlap-request", serverInstanceId: "s", result: { status: "healthy" } });
        conn.write(encodeFrame(Buffer.from(response, "utf-8")));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const transport = new LocalTransport(socketPath);
      const response = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "overlap-request", method: "system.health", payload: {},
      });
      expect(response.ok).toBe(true);
      expect(connIndex).toBe(3);
      expect(maxConcurrent).toBe(1);
      await transport.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);

  it("ignores late or unmatched response frames without disturbing later requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-late-"));
    const socketPath = join(dir, "late.sock");
    const server = createServer();
    let lateSent = false;

    server.on("connection", (conn) => {
      const acc = createFrameAccumulator();
      conn.on("data", (chunk) => {
        acc.push(chunk);
        const frame = acc.readFrame();
        if (!frame) return;
        const request = JSON.parse(frame.payload.toString("utf-8")) as { requestId: string; method: string };
        const response = JSON.stringify({ ok: true, requestId: request.requestId, serverInstanceId: "s", result: { status: "healthy" } });
        conn.write(encodeFrame(Buffer.from(response, "utf-8")));
        if (!lateSent) {
          lateSent = true;
          // A stray second frame for the same request, and an unknown id.
          const stray = JSON.stringify({ ok: true, requestId: request.requestId, serverInstanceId: "s", result: { status: "stale" } });
          conn.write(encodeFrame(Buffer.from(stray, "utf-8")));
          const unknown = JSON.stringify({ ok: true, requestId: "never-pending", serverInstanceId: "s", result: { status: "ghost" } });
          conn.write(encodeFrame(Buffer.from(unknown, "utf-8")));
        }
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const transport = new LocalTransport(socketPath);
      const first = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "late-1", method: "system.health", payload: {},
      });
      expect(first.ok).toBe(true);
      const second = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "late-2", method: "system.health", payload: {},
      });
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.result).toEqual({ status: "healthy" });
      await transport.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("close() settles in-flight requests exactly once with truthful classification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-close-"));
    const socketPath = join(dir, "close.sock");
    const server = createServer();

    server.on("connection", (conn) => {
      // Never respond: requests stay pending until the transport closes.
      conn.on("data", () => {});
    });

    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const transport = new LocalTransport(socketPath);
      const mutationPromise = transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "close-m", method: "private.recordMessage",
        idempotencyKey: "close-key", payload: { userId: "u", sessionId: "s1", role: "user", content: "x", timestamp: 1 },
      });
      const readPromise = transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "close-r", method: "system.health", payload: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      await transport.close();

      const mutation = await mutationPromise;
      expect(mutation.ok).toBe(false);
      if (!mutation.ok) {
        expect(mutation.error).toMatchObject({ code: "outcome_unknown", retryable: false, action: "reconcile", stage: "response" });
      }
      const read = await readPromise;
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.error).toMatchObject({ code: "unavailable", retryable: true, action: "retry", stage: "response" });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("retains and replays envelopes after a malformed response frame", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gen-malformed-"));
    const socketPath = join(dir, "malformed.sock");
    const server = createServer();
    let connectionCount = 0;
    let replaySeenResolve!: () => void;
    const replaySeen = new Promise<void>((resolve) => { replaySeenResolve = resolve; });

    server.on("connection", (conn) => {
      const acc = createFrameAccumulator();
      const index = ++connectionCount;
      conn.on("error", () => { /* client intentionally destroys after malformed frame */ });
      conn.on("data", (chunk) => {
        acc.push(chunk);
        const frame = acc.readFrame();
        if (!frame) return;
        const request = JSON.parse(frame.payload.toString("utf-8")) as { requestId: string; idempotencyKey?: string };
        if (index === 1) {
          conn.write(encodeFrame(Buffer.from("{malformed", "utf-8")));
          return;
        }
        expect(request.requestId).toBe("malformed-request");
        expect(request.idempotencyKey).toBe("malformed-key");
        replaySeenResolve();
        conn.write(encodeFrame(Buffer.from(JSON.stringify({
          ok: true, requestId: request.requestId, serverInstanceId: "s", result: { stored: true },
        }), "utf-8")));
      });
    });

    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      const transport = new LocalTransport(socketPath);
      const response = await transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "malformed-request", method: "private.recordMessage",
        idempotencyKey: "malformed-key", payload: { userId: "u", sessionId: "s1", role: "user", content: "x", timestamp: 1 },
      });
      expect(response.ok).toBe(false);
      if (!response.ok) expect(response.error).toMatchObject({ code: "outcome_unknown", stage: "response" });
      await expect(replaySeen).resolves.toBeUndefined();
      expect(connectionCount).toBeGreaterThanOrEqual(2);
      await transport.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);
});

describe("#1659 LocalEndpointServer overload and delivery", () => {
  it("rejects the overflowing request with its own request ID and never dispatches it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "endpoint-overload-"));
    const socketPath = join(dir, "overload.sock");
    let dispatched = 0;
    class HangingManager {
      getConfig() { return { memoryEnabled: true, memoryDir: "/tmp" }; }
      editor = {
        instantStore: () => { dispatched++; return new Promise(() => {}); },
      };
      operational = null;
    }
    const ledgerDb = new Database(":memory:");
    ledgerDb.exec(`CREATE TABLE abmind_service_requests (
      principal_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, method TEXT NOT NULL,
      payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','in_flight','completed','outcome_unknown')),
      response_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (principal_id, idempotency_key)
    )`);
    const service = new AbmindService({
      serverInstanceId: "test", mode: "daemon",
      manager: new HangingManager() as never,
      operational: null, requestLedgerDb: ledgerDb,
    });
    const server = new LocalEndpointServer({ socketPath, service, principalMapping: "self" });
    const { CONNECTION_MAX_INFLIGHT } = await import("./abmind-frame-codec.js");
    try {
      await server.start();
      const transport = new LocalTransport(socketPath);

      const requests = Array.from({ length: CONNECTION_MAX_INFLIGHT + 1 }, (_, i) =>
        transport.request({
          version: ABMIND_PROTOCOL_VERSION,
          requestId: `over-${i}`,
          method: "private.instantStore",
          idempotencyKey: `over-key-${i}`,
          payload: { userId: "local-user", contentEn: `m${i}`, contentOriginal: `m${i}`, memoryType: "fact", emotionScore: 0 },
        }),
      );
      const resultsPromise = Promise.all(requests);

      // Let the endpoint read every frame and reject the overflowing request.
      await new Promise((resolve) => setTimeout(resolve, 400));
      // Closing settles the 32 legitimately in-flight (hanging) requests.
      await transport.close();
      const results = await resultsPromise;

      const overload = results.find(r => !r.ok && r.error.code === "unavailable" && r.error.stage === "pre_dispatch");
      expect(overload).toBeDefined();
      if (overload && !overload.ok) {
        expect(overload.requestId).toMatch(/^over-\d+$/);
        expect(overload.error).toMatchObject({ retryable: true, action: "retry" });
      }
      // The other 32 were legitimately in-flight when the transport closed.
      const uncertain = results.filter(r => !r.ok && r.error.code === "outcome_unknown");
      expect(uncertain.length).toBe(CONNECTION_MAX_INFLIGHT);
      expect(dispatched).toBe(CONNECTION_MAX_INFLIGHT);

      await transport.close();
    } finally {
      await server.stop();
      ledgerDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

// ── #1701: endpoint quiesce/final-stop lifecycle ─────────────────────────────

describe("LocalEndpointServer quiesce/final-stop (#1701)", () => {
  const makeServer = (socketPath: string, manager?: unknown) => {
    const service = new AbmindService({
      serverInstanceId: "test", mode: "daemon",
      manager: (manager ?? new MockManager()) as never,
      operational: null, requestLedgerDb: null,
    });
    return { service, server: new LocalEndpointServer({ socketPath, service, principalMapping: "self", allowPrivateDelegation: true }) };
  };

  it("quiesce refuses new connections while an established connection stays usable, and final stop unlinks the socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-ep-quip-"));
    const socketPath = join(dir, "q.sock");
    try {
      const { service, server } = makeServer(socketPath);
      await server.start();

      const established = new LocalTransport(socketPath);
      expect((await established.request({ version: ABMIND_PROTOCOL_VERSION, requestId: "pre", method: "system.health", payload: {} })).ok).toBe(true);

      server.quiesce();

      // A NEW client can no longer connect (listener closed)...
      const newcomer = new LocalTransport(socketPath);
      const refused = await newcomer.request({ version: ABMIND_PROTOCOL_VERSION, requestId: "new", method: "system.health", payload: {} });
      expect(refused.ok).toBe(false);

      // ...but the established connection still receives responses.
      const served = await established.request({ version: ABMIND_PROTOCOL_VERSION, requestId: "post", method: "system.health", payload: {} });
      expect(served.ok).toBe(true);

      // Once admission is closed, frames on kept connections get the
      // existing unavailable response instead of entering dispatch.
      service.close();
      const late = await established.request({ version: ABMIND_PROTOCOL_VERSION, requestId: "late", method: "system.health", payload: {} });
      expect(late.ok).toBe(false);
      if (!late.ok) expect(late.error.code).toBe("unavailable");

      const result = await server.stop(2_000);
      expect(result.drained).toBe(true);
      expect(result.remainingConnections).toBe(0);
      expect(existsSync(socketPath)).toBe(false);

      await established.close();
      await newcomer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("final stop lets an accepted response flush, then closes — drained=true only after delivery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-ep-flush-"));
    const socketPath = join(dir, "f.sock");
    try {
      let release!: (value: string) => void;
      const gate = new Promise<string>((resolve) => { release = resolve; });
      const manager = new MockManager();
      manager.readCoreKnowledge = () => gate;

      const { service, server } = makeServer(socketPath, manager);
      await server.start();
      const transport = new LocalTransport(socketPath);

      const pending = transport.request({
        version: ABMIND_PROTOCOL_VERSION, requestId: "gated", method: "private.getCoreKnowledge", payload: { userId: "test" },
      });
      await waitFor(() => service.inFlight === 1);

      // Quiesce first (no new connections), then let the dispatch complete:
      // the queued response must still be delivered before final close.
      server.quiesce();
      release("core-knowledge");
      const response = await pending;
      expect(response.ok).toBe(true);
      if (response.ok) expect(response.result).toBe("core-knowledge");

      const result = await server.stop(2_000);
      expect(result.drained).toBe(true);
      expect(existsSync(socketPath)).toBe(false);

      await transport.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("final stop consumes only the supplied remaining time and reports undelivered leftovers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "abmind-ep-bound-"));
    const socketPath = join(dir, "b.sock");
    try {
      const { server } = makeServer(socketPath);
      await server.start();

      // A raw connection that never speaks. allowHalfOpen keeps it in the
      // server's connection set after the server's end(): it only dies at
      // destroy time.
      const { createConnection } = await import("node:net");
      const lingering = createConnection({ path: socketPath, allowHalfOpen: true });
      await waitFor(() => !lingering.pending && lingering.readyState === "open");

      server.quiesce();
      const startedAt = Date.now();
      const result = await server.stop(300);
      const elapsed = Date.now() - startedAt;

      // Bounded by the supplied budget — not a fresh five-second window.
      expect(elapsed).toBeLessThan(2_500);
      expect(result.drained).toBe(false);
      expect(result.remainingConnections).toBeGreaterThanOrEqual(1);
      expect(existsSync(socketPath)).toBe(false);

      lingering.destroy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

function waitFor(condition: () => boolean, timeoutMs = 5_000, stepMs = 20): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (condition()) return resolve();
      if (Date.now() > deadline) return reject(new Error("condition not met within timeout"));
      setTimeout(poll, stepMs);
    };
    poll();
  });
}
