/**
 * mcp-discovery.test.ts — caller-filtered owner discovery (#1384).
 *
 * The negotiation projection must use the same authorization facts dispatch
 * enforces: authorized local connections keep the private domain and the
 * lifecycle methods Hermes requires, while narrow remote grants see only
 * their methods and only the domains those methods live in.
 */
import { describe, it, expect } from "vitest";
import type { ServiceCallContext } from "./abmind-protocol.js";
import { dispatchNegotiate, type ServiceInfo } from "./abmind-ops-dispatch.js";

const INFO: ServiceInfo = {
  mode: "daemon",
  serverInstanceId: "test",
  operationalAvailable: false,
  memoryEnabled: true,
  buildCommit: null,
  releaseId: null,
  startTime: Date.now(),
  requestCount: 0,
};

const LOCAL_CAPS = new Set([
  "rebuild_fts", "doctor_diagnose", "doctor_fix",
  "sleep_start", "sleep_status", "sleep_resume", "sleep_cancel",
  "sleep_events", "sleep_runtime_provider",
]);

function localContext(): ServiceCallContext {
  return {
    principalId: "local-user",
    role: "local_user",
    grantedDomains: new Set(["system", "private", "operational", "operator"]),
    capabilities: LOCAL_CAPS,
    authenticatedBy: "local_peer",
  };
}

describe("dispatchNegotiate caller filtering", () => {
  it("keeps the private domain and lifecycle methods for authorized local connections", () => {
    const caps = dispatchNegotiate(localContext(), INFO);
    expect(caps.domains).toEqual(["system", "private", "operational", "operator"]);
    for (const m of [
      "private.lifecycleRecall", "private.lifecycleStore",
      "private.lifecyclePrepareTurn", "private.lifecycleCompleteTurn",
      "private.lifecycleCheckpoint", "private.lifecycleObserve",
      "private.assembleSessionContext", "private.getRuntimeStatus",
      "private.getCoreKnowledge", "private.modelContext",
    ]) {
      expect(caps.methods).toContain(m);
    }
  });

  it("narrows methods and domains for a narrow remote grant", () => {
    const caps = dispatchNegotiate({
      principalId: "peer-a",
      role: "peer",
      grantedDomains: new Set(["system", "private"] as const),
      allowedMethods: new Set([
        "system.negotiate", "system.health",
        "private.lifecycleRecall", "private.lifecycleStore", "private.modelContext",
        "private.adjustRelevance",
      ] as const),
      capabilities: new Set<string>(),
      authenticatedBy: "signed_peer",
    }, INFO);
    expect(caps.domains).toEqual(["system", "private"]);
    expect(caps.methods).toContain("private.lifecycleRecall");
    expect(caps.methods).toContain("private.modelContext");
    expect(caps.methods).not.toContain("private.assembleSessionContext");
    expect(caps.methods).not.toContain("private.getRuntimeStatus");
    expect(caps.methods).not.toContain("operational.recall");
  });

  it("excludes sealed resolution for signed peers even when granted", () => {
    const caps = dispatchNegotiate({
      principalId: "peer-a",
      role: "peer",
      grantedDomains: new Set(["system", "private"] as const),
      allowedMethods: new Set([
        "system.negotiate", "private.resolveSealedSecret", "private.findSealedSecrets",
      ] as const),
      capabilities: new Set<string>(),
      authenticatedBy: "signed_peer",
    }, INFO);
    expect(caps.methods).not.toContain("private.resolveSealedSecret");
    expect(caps.methods).not.toContain("private.findSealedSecrets");
  });

  it("enforces capability gates in the projection, not just at dispatch", () => {
    const base = {
      principalId: "peer-b",
      role: "peer",
      grantedDomains: new Set(["system", "private", "operational", "operator"] as const),
      allowedMethods: new Set(["system.negotiate", "private.rebuildFts"] as const),
      authenticatedBy: "signed_peer",
    } as const;
    const without = dispatchNegotiate({ ...base, capabilities: new Set<string>() }, INFO);
    expect(without.methods).not.toContain("private.rebuildFts");
    const withCap = dispatchNegotiate({ ...base, capabilities: new Set(["rebuild_fts"]) }, INFO);
    expect(withCap.methods).toContain("private.rebuildFts");
  });
});
