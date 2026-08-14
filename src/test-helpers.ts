import { MEMORY_CONFIG_DEFAULTS } from "./memory-config.js";
import type { MemoryConfig } from "./memory-config.js";

export function makeMemoryTestConfig(tmpDir: string, overrides: Partial<MemoryConfig> = {}): MemoryConfig {
  return { ...MEMORY_CONFIG_DEFAULTS, memoryDir: tmpDir, ...overrides };
}

/**
 * Pin the canonical primary identity for tests that exercise Master-only
 * creation gates (appendInstant / ingest). The runtime-isolation sandbox has
 * no manifest, so without this every creation call would fail closed with
 * `primary_identity_missing`. Restores the previous env value.
 */
export function setPrimaryTestUser(userId: string): () => void {
  const saved = process.env.ABMIND_USER_ID;
  process.env.ABMIND_USER_ID = userId;
  return () => {
    if (saved === undefined) delete process.env.ABMIND_USER_ID;
    else process.env.ABMIND_USER_ID = saved;
  };
}
