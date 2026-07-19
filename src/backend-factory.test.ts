import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMemoryBackend } from "./backend-factory.js";
import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";

describe("backend factory production boundary", () => {
  it("does not open a local database when the daemon is unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "abmind-factory-"));
    const previousHome = process.env.ABMIND_HOME;
    process.env.ABMIND_HOME = home;
    try {
      await expect(createMemoryBackend({ ...MEMORY_CONFIG_DEFAULTS, memoryDir: join(home, "memory") }))
        .rejects.toThrow(/abmind daemon is not running|Negotiation failed|Could not connect/);
      expect(existsSync(join(home, "memory", "memory.db"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.ABMIND_HOME;
      else process.env.ABMIND_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});
