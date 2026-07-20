import { getAbmindEnv } from "./env-schema.js";
/**
 * Backend factory — creates the configured MemoryBackend or AbmindClient.
 * Legacy IPC/MEMORY_IPC probing and SQLite fallback are removed (#1380).
 * Client mode uses LocalTransport; embedded tests use createEmbeddedAbmind.
 */

import { ClientBackendAdapter, type MemoryBackend } from "./memory-backend.js";
import type { MemoryConfig } from "./memory-config.js";
import { SqliteBackend } from "./sqlite-backend.js";
import type { AbmindClient } from "./abmind-client.js";
import type { AbmindOwnerConfig, EmbeddedCaller } from "./abmind-service-host.js";
import { join } from "node:path";
import { abmindHome } from "./mem-paths.js";

/**
 * Create the production client-backed backend. The caller must use the
 * dedicated daemon; this function never opens SQLite in the caller process.
 */
export async function createMemoryBackend(config: MemoryConfig): Promise<MemoryBackend> {
  void config;
  return createClientBackend();
}

/** Explicit embedded backend for tests and code that owns the service. */
export async function createEmbeddedMemoryBackend(config: MemoryConfig): Promise<MemoryBackend> {
  const backendType = getAbmindEnv().memoryBackend;
  if (backendType !== "sqlite") {
    throw new Error(`Unknown MEMORY_BACKEND: ${backendType}. Supported: sqlite`);
  }
  const backend = new SqliteBackend(config);
  await backend.initialize();
  return backend;
}

/** Create a client-backed MemoryBackend after daemon negotiation. */
export async function createClientBackend(): Promise<MemoryBackend> {
  const client = await createLocalClient();
  return new ClientBackendAdapter(client);
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

export type MemoryClient = AbmindClient | import("./memory-manager.js").MemoryManager;

export function isClient(client: MemoryClient): client is AbmindClient {
  return "privateMemory" in client;
}

export function isManager(client: MemoryClient): client is import("./memory-manager.js").MemoryManager {
  return "getDatabase" in client;
}

/** Create an AbmindClient backed by LocalTransport to the daemon's Unix socket. */
export async function createLocalClient(): Promise<AbmindClient> {
  const { LocalTransport } = await import("./local-transport.js");
  const { AbmindClient: Client } = await import("./abmind-client.js");
  const socketPath = join(abmindHome(), "run", "abmind.sock");
  const transport = new LocalTransport(socketPath);
  const client = new Client(transport);
  try {
    await client.negotiate();
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
  return client;
}

/**
 * Get a memory client for use in CLI tools. Tries daemon first; falls back to
 * embedded MemoryManager when the operation has no V1 equivalent (sleep, backup).
 * CLI tools that use V1 methods (recall, store, edit) should use strict mode
 * — fail if daemon unavailable.
 *
 * @param strict When true, throws if daemon is unavailable. When false, falls
 *   back to embedded MemoryManager.
 * @param config Optional MemoryConfig for embedded fallback.
 */
export async function getMemoryClient(strict = true, config?: import("./memory-config.js").MemoryConfig): Promise<MemoryClient> {
  try {
    return await createLocalClient();
  } catch (err) {
    if (strict) {
      throw new Error(`abmind daemon is not running. Start it with: abmind service start\n  (${(err as Error).message})`);
    }
    const { loadMemoryConfig } = await import("./memory-config.js");
    const { MemoryManager } = await import("./memory-manager.js");
    const cfg = config ?? loadMemoryConfig();
    const mm = new MemoryManager(cfg);
    await mm.initialize({ skipEmbeddingCheck: true });
    return mm;
  }
}

export function closeClient(client: MemoryClient): void {
  if (isClient(client)) client.close().catch(() => {});
  else client.close();
}
