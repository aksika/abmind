import { describe, it, expect } from "vitest";
import { AbmindClient } from "./abmind-client.js";
import type { AbmindTransport, AbmindCapabilitiesV1, AbmindMethod, AbmindRequestV1, AbmindResponseV1 } from "./abmind-protocol.js";

class MockTransport implements AbmindTransport {
  private responses: Map<string, unknown> = new Map();
  private negotiateResult: AbmindCapabilitiesV1 = {
    version: 1, methods: ["system.negotiate", "system.health", "private.recall", "operational.submitDraft"], domains: ["system", "private", "operational"], features: {},
  };

  setResponse(method: string, result: unknown): void {
    this.responses.set(method, result);
  }

  setNegotiateResult(caps: AbmindCapabilitiesV1): void {
    this.negotiateResult = caps;
  }

  async negotiate(): Promise<AbmindCapabilitiesV1> {
    return this.negotiateResult;
  }

  async request<K extends AbmindMethod>(req: AbmindRequestV1<K>): Promise<AbmindResponseV1<K>> {
    const result = this.responses.get(req.method);
    if (result === undefined) {
      return { ok: false, requestId: req.requestId, error: { code: "unavailable", message: `No mock for ${req.method}` } } as AbmindResponseV1<K>;
    }
    return { ok: true, requestId: req.requestId, serverInstanceId: "mock", result: result as never } as AbmindResponseV1<K>;
  }

  async close(): Promise<void> {}
}

describe("AbmindClient", () => {
  it("creates client with transport", () => {
    const transport = new MockTransport();
    const client = new AbmindClient(transport);
    expect(client.system).toBeDefined();
    expect(client.privateMemory).toBeDefined();
    expect(client.operational).toBeDefined();
  });

  it("negotiate returns capabilities", async () => {
    const transport = new MockTransport();
    const client = new AbmindClient(transport);
    const caps = await client.negotiate();
    expect(caps.version).toBe(1);
    expect(caps.methods).toContain("system.negotiate");
    expect(client.capabilities).toBe(caps);
  });

  it("system.health returns health status", async () => {
    const transport = new MockTransport();
    transport.setResponse("system.health", { status: "healthy", uptimeMs: 100, memoryEnabled: true });
    const client = new AbmindClient(transport);
    const health = await client.system.health();
    expect(health.status).toBe("healthy");
  });

  it("system.status returns status", async () => {
    const transport = new MockTransport();
    transport.setResponse("system.status", { version: "1", mode: "embedded", instanceId: "i", pid: 1234, memoryDir: "/tmp", databaseSizeBytes: 0, operationalDbSizeBytes: 0, uptimeMs: 0, requestCount: 0 });
    const client = new AbmindClient(transport);
    const status = await client.system.status();
    expect(status.mode).toBe("embedded");
  });

  it("system.capabilities returns feature map", async () => {
    const transport = new MockTransport();
    transport.setResponse("system.capabilities", { private: "true" });
    const client = new AbmindClient(transport);
    const caps = await client.system.capabilities();
    expect(caps.private).toBe("true");
  });

  it("privateMemory.instantStore returns result", async () => {
    const transport = new MockTransport();
    transport.setResponse("private.instantStore", { ok: true, id: 42 });
    const client = new AbmindClient(transport);
    const result = await client.privateMemory.instantStore({ content: "test", keywords: [], memoryType: "episodic", userId: "u1", importance: 3, platform: "cli", source: "test" });
    expect(result).toEqual({ ok: true, id: 42 });
  });

  it("privateMemory.editMemory returns result", async () => {
    const transport = new MockTransport();
    transport.setResponse("private.edit", { ok: true });
    const client = new AbmindClient(transport);
    const result = await client.privateMemory.editMemory({ memoryId: 1, contentEn: "edited" });
    expect(result).toEqual({ ok: true });
  });

  it("privateMemory.reclassifyMemory resolves", async () => {
    const transport = new MockTransport();
    transport.setResponse("private.reclassify", null);
    const client = new AbmindClient(transport);
    await client.privateMemory.reclassifyMemory(1, 3, true);
  });

  it("privateMemory.recall returns recall result", async () => {
    const transport = new MockTransport();
    transport.setResponse("private.recall", { hits: [] });
    const client = new AbmindClient(transport);
    const result = await client.privateMemory.recall({ query: "test" });
    expect(result.hits).toEqual([]);
  });

  it("privateMemory.rebuildFts returns result", async () => {
    const transport = new MockTransport();
    transport.setResponse("private.rebuildFts", { rebuilt: ["main"] });
    const client = new AbmindClient(transport);
    const result = await client.privateMemory.rebuildFtsIndexes();
    expect(result.rebuilt).toEqual(["main"]);
  });

  it("operational.submitDraft returns operational result", async () => {
    const transport = new MockTransport();
    transport.setResponse("operational.submitDraft", { ok: true, value: { id: "d1", status: "draft", lesson: "test", suggestedScopeLevel: "global", confidence: 80, evidence: [], provenance: {}, createdAt: 1, updatedAt: 1, problem: null, recommendation: null, suggestedPlatform: null, suggestedHost: null, suggestedWorkspace: null, suggestedRepository: null, suggestedTaskEnvironment: null, sourceTaskId: null, sourceSessionId: null, sourceExecutor: null, sourceHost: null, promotedMemoryId: null, rejectedBy: null, rejectedAt: null, rejectionReason: null } });
    const client = new AbmindClient(transport);
    const result = await client.operational.submitDraft({ lesson: "test", scopeLevel: "global", confidence: 80 });
    expect(result.ok).toBe(true);
  });

  it("rejects error responses", async () => {
    const transport = new MockTransport();
    transport.setResponse("private.recall", undefined); // no mock set = unavailable
    const client = new AbmindClient(transport);
    await expect(client.privateMemory.recall({ query: "test" })).rejects.toThrow();
  });

  it("close closes the transport", async () => {
    let closed = false;
    const transport = new (class implements AbmindTransport {
      async negotiate() { return { version: 1, methods: [], domains: [], features: {} }; }
      async request() { return { ok: false, requestId: "", error: { code: "unavailable" as never, message: "closed" } }; }
      async close() { closed = true; }
    })();
    const client = new AbmindClient(transport);
    await client.close();
    expect(closed).toBe(true);
  });
});
