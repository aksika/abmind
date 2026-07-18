import { describe, it, expect } from "vitest";
import { LocalTransport } from "./local-transport.js";
import { LocalEndpointServer } from "./local-endpoint-server.js";
import { AbmindService } from "./abmind-service.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";
import type { ServiceCallContext } from "./abmind-protocol.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
});
