import { getAbmindEnv } from "./env-schema.js";
/**
 * Backend factory — creates the configured MemoryBackend.
 * Tries IPC socket first (fast), falls back to SQLite (standalone).
 */

import type { MemoryBackend } from "./memory-backend.js";
import type { MemoryConfig } from "./memory-config.js";
import { SqliteBackend } from "./sqlite-backend.js";

/** Create and initialize a MemoryBackend. Tries IPC socket first, falls back to SQLite. */
export async function createMemoryBackend(config: MemoryConfig): Promise<MemoryBackend> {
  const backendType = getAbmindEnv().memoryBackend;
  if (backendType !== "sqlite") {
    throw new Error(`Unknown MEMORY_BACKEND: ${backendType}. Supported: sqlite`);
  }

  // Try IPC first (bridge is running, DB already open)
  if (getAbmindEnv().memoryIpc) {
    try {
      const { IpcBackend } = await import("./memory-ipc-client.js");
      const ipc = new IpcBackend();
      await ipc.initialize();
      return ipc;
    } catch { /* socket not available — fall through to SQLite */ }
  }

  const backend = new SqliteBackend(config);
  await backend.initialize();
  return backend;
}
