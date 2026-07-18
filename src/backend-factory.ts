import { getAbmindEnv } from "./env-schema.js";
/**
 * Backend factory — creates the configured MemoryBackend or AbmindClient.
 * Legacy IPC/MEMORY_IPC probing and SQLite fallback are removed (#1380).
 * Client mode uses LocalTransport; embedded tests use createEmbeddedAbmind.
 */

import type { MemoryBackend } from "./memory-backend.js";
import type { MemoryConfig } from "./memory-config.js";
import { SqliteBackend } from "./sqlite-backend.js";
import type { AbmindClient } from "./abmind-client.js";
import type { AbmindOwnerConfig, EmbeddedCaller } from "./abmind-service-host.js";
import { join } from "node:path";
import { abmindHome } from "./mem-paths.js";

/** Create and initialize a configured MemoryBackend. Only SQLite mode is supported. */
export async function createMemoryBackend(config: MemoryConfig): Promise<MemoryBackend> {
  const backendType = getAbmindEnv().memoryBackend;
  if (backendType !== "sqlite") {
    throw new Error(`Unknown MEMORY_BACKEND: ${backendType}. Supported: sqlite`);
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

/** Create an AbmindClient backed by LocalTransport to the daemon's Unix socket. */
export async function createLocalClient(): Promise<AbmindClient> {
  const { LocalTransport } = await import("./local-transport.js");
  const { AbmindClient: Client } = await import("./abmind-client.js");
  const socketPath = join(abmindHome(), "run", "abmind.sock");
  const transport = new LocalTransport(socketPath);
  const client = new Client(transport);
  await client.negotiate();
  return client;
}
