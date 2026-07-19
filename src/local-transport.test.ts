import { describe, it, expect } from "vitest";
import { LocalTransport } from "./local-transport.js";
import { LocalEndpointServer } from "./local-endpoint-server.js";
import { AbmindService } from "./abmind-service.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
import type { ServiceCallContext } from "./abmind-protocol.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createFrameAccumulator, encodeFrame } from "./abmind-frame-codec.js";

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
