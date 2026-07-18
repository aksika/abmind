import { getAbmindEnv } from "./env-schema.js";
/**
 * Backend factory — creates the configured MemoryBackend.
 * Tries IPC socket first (fast), falls back to SQLite (standalone).
 * New: can also create an AbmindClient via #1379 service protocol.
 */

import type { MemoryBackend } from "./memory-backend.js";
import type { MemoryConfig } from "./memory-config.js";
import { SqliteBackend } from "./sqlite-backend.js";
import type { AbmindClient } from "./abmind-client.js";
import type { AbmindOwnerConfig, EmbeddedCaller } from "./abmind-service-host.js";

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

/** Create an embedded AbmindClient (owner + client in same process). */
export async function createEmbeddedClient(
  config: AbmindOwnerConfig,
  caller: EmbeddedCaller,
): Promise<AbmindClient> {
  const { createEmbeddedAbmind } = await import("./abmind-service-host.js");
  const { client } = await createEmbeddedAbmind(config, caller);
  return client;
}
