/**
 * MemoryBackend — transport-agnostic memory API for CLI tools + tool-registry.
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ When to use                                                                │
 * ├────────────────────────────────────────────────────────────────────────────┤
 * │ Consumers that may run in-process OR talk to a separate abmind process     │
 * │ over an IPC socket. The interface hides the transport — the caller just    │
 * │ awaits a Promise and doesn't care whether storage is local SQLite or       │
 * │ remote-over-socket.                                                        │
 * │                                                                            │
 * │ Use when:                                                                  │
 * │   - CLI tools (abmind store/edit/merge/recall — they use createMemoryBackend)  │
 * │   - Direct-API tool-registry (abtars's memory_store / memory_recall / │
 * │     memory_edit tools register a MemoryBackend once at boot)               │
 * │   - MCP server adapter                                                     │
 * │   - Ecosystem plugins (openclaw, future hosts) that don't own the process  │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Implementations:
 *   SqliteBackend   in-process (sqlite-backend.ts) — wraps MemoryManager
 *   IpcBackend      over Unix socket (memory-ipc-client.ts) — talks to a
 *                   long-running abmind process via memory-ipc-server.ts
 *
 * Factory: `createMemoryBackend(config)` in backend-factory.ts picks the
 * right one (tries IPC socket first, falls back to SQLite).
 *
 * Relationship to IMemoryCore/IMemorySystem (see imemory-system.ts):
 *   IMemoryCore/IMemorySystem  = in-process, direct object reference,
 *                                includes read + context-building methods
 *   MemoryBackend              = transport-agnostic, async-only, focused on
 *                                the write + recall paths callers need from
 *                                outside the host's process
 *
 * Rule of thumb:
 *   - Running inside the host process? → IMemoryCore (read) or IMemorySystem (full)
 *   - Shelled-out CLI / tool call / IPC boundary? → MemoryBackend
 *
 * All methods are async — even local SQLite calls return Promises — so swap
 * of transport is source-compatible.
 */

import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";

/** Merge result from combining two memories. */
export type MergeResult = { merged: true; keptId: number; deletedId: number } | { merged: false; error: string };

/** Abstract memory backend — all CLI tools go through this. */
export interface MemoryBackend {
  initialize(): Promise<void>;
  close(): void;

  // Store
  instantStore(params: InstantStoreParams): Promise<InstantStoreResult>;

  // Edit
  editMemory(params: EditMemoryParams): Promise<EditMemoryResult>;
  reclassifyMemory(id: number, level: number, userOverride: boolean): Promise<void>;
  adjustRelevance(id: number, delta: number): Promise<void>;
  mergeMemories(idA: number, idB: number): Promise<MergeResult>;
  cascadeDelete(messageIds: number[], userId: string): Promise<ForgetResult>;

  // Recall
  recall(params: RecallParams): Promise<RecallResult>;
}
