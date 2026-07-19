import { describe, it, expect } from "vitest";
import { OwnerLeaseError } from "./abmind-owner-lease.js";
import type { MemoryConfig } from "./memory-config.js";
import type { DaemonOptions, DaemonDeps } from "../cli/abmind-daemon.js";

const MEM_CONFIG: MemoryConfig = {
  memoryEnabled: true,
  memoryDir: "/tmp/test-mem-dir",
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

describe("runDaemon", () => {
  it("should be importable and export DaemonOptions type", () => {
    // Type-level test — if this compiles, the types export correctly
    const opts: DaemonOptions = { waitForOwner: true, principalMapping: "self", socketPath: undefined };
    expect(opts.waitForOwner).toBe(true);
  });

  it("DaemonDeps interface can be mocked", async () => {
    let aborted = false;
    const signal = { get aborted() { return aborted; } };
    const deps: DaemonDeps = {
      createSignal: () => signal as AbortSignal,
      delay: async () => { aborted = true; }, // abort on first delay
      onSignal: () => {},
    };
    expect(deps.createSignal().aborted).toBe(false);
    await deps.delay(100);
    expect(aborted).toBe(true);
  });
});
