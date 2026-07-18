import { describe, it, expect } from "vitest";
import { EmbeddedTransport } from "./embedded-transport.js";
import { AbmindService } from "./abmind-service.js";
import type { ServiceCallContext } from "./abmind-protocol.js";
import { ABMIND_PROTOCOL_VERSION } from "./abmind-protocol.js";

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
  principalId: "embedded-user",
  role: "local_user",
  grantedDomains: new Set(["system", "private", "operational"]),
  authenticatedBy: "embedded",
};

describe("EmbeddedTransport", () => {
  it("negotiates capabilities", async () => {
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
    });
    const transport = new EmbeddedTransport(service, context);
    const caps = await transport.negotiate();
    expect(caps.version).toBe(1);
    expect(caps.methods).toContain("system.negotiate");
  });

  it("dispatches a request and returns response", async () => {
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
    });
    const transport = new EmbeddedTransport(service, context);
    const res = await transport.request({
      version: ABMIND_PROTOCOL_VERSION, requestId: "r1", method: "system.health", payload: {},
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.result).toHaveProperty("status");
  });

  it("returns unavailable when closed", async () => {
    const service = new AbmindService({
      serverInstanceId: "test", mode: "embedded", manager: new MockManager() as never, operational: null, requestLedgerDb: null,
    });
    const transport = new EmbeddedTransport(service, context);
    await transport.close();
    const res = await transport.request({
      version: ABMIND_PROTOCOL_VERSION, requestId: "r2", method: "system.health", payload: {},
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("unavailable");
  });
});
