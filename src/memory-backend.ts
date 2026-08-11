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
 * Implementation:
 *   SqliteBackend   in-process (sqlite-backend.ts) — wraps MemoryManager
 *
 * For local-client mode use createLocalClient() from backend-factory.ts.
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

import type {
  InstantStoreParams, InstantStoreResult, EditPrivateMemoryInputV1,
  ReclassifyPrivateMemoryInputV1, AdjustPrivateRelevanceInputV1,
  MergePrivateMemoriesInputV1, PrivateMutationStatusV1,
  CascadeDeletePrivateMessagesInputV1, CascadeDeleteResultV1,
} from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";
import type { AbmindPrivateMemoryApi } from "./abmind-client.js";

/** Merge result from combining two memories. */
/** Abstract memory backend — all CLI tools go through this. */
export interface MemoryBackend {
  initialize(): Promise<void>;
  close(): void;

  // Store
  instantStore(params: InstantStoreParams): Promise<InstantStoreResult>;

  // Edit
  editMemory(params: EditPrivateMemoryInputV1): Promise<PrivateMutationStatusV1>;
  reclassifyMemory(params: ReclassifyPrivateMemoryInputV1): Promise<PrivateMutationStatusV1>;
  adjustRelevance(params: AdjustPrivateRelevanceInputV1): Promise<PrivateMutationStatusV1>;
  mergeMemories(params: MergePrivateMemoriesInputV1): Promise<PrivateMutationStatusV1>;
  cascadeDelete(input: CascadeDeletePrivateMessagesInputV1): Promise<CascadeDeleteResultV1>;

  // Recall
  recall(params: RecallParams): Promise<RecallResult>;

  // Maintenance
  rebuildFtsIndexes(): { rebuilt: string[] } | Promise<{ rebuilt: string[] }>;
}

/** Thin adapter — wraps an AbmindClient's privateMemory namespace as MemoryBackend for migration. */
export class ClientBackendAdapter implements MemoryBackend {
  private client: { privateMemory: AbmindPrivateMemoryApi; close(): Promise<void> };

  constructor(client: { privateMemory: AbmindPrivateMemoryApi; close(): Promise<void> }) {
    this.client = client;
  }

  async initialize(): Promise<void> {}
  close(): void { void this.client.close(); }

  instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    return this.client.privateMemory.instantStore(params);
  }
  editMemory(params: EditPrivateMemoryInputV1): Promise<PrivateMutationStatusV1> {
    return this.client.privateMemory.editMemory(params);
  }
  reclassifyMemory(params: ReclassifyPrivateMemoryInputV1): Promise<PrivateMutationStatusV1> {
    return this.client.privateMemory.reclassifyMemory(params);
  }
  adjustRelevance(params: AdjustPrivateRelevanceInputV1): Promise<PrivateMutationStatusV1> {
    return this.client.privateMemory.adjustRelevance(params);
  }
  mergeMemories(params: MergePrivateMemoriesInputV1): Promise<PrivateMutationStatusV1> {
    return this.client.privateMemory.mergeMemories(params);
  }
  cascadeDelete(input: CascadeDeletePrivateMessagesInputV1): Promise<CascadeDeleteResultV1> {
    return this.client.privateMemory.cascadeDelete(input);
  }
  recall(params: RecallParams): Promise<RecallResult> {
    return this.client.privateMemory.recall(params);
  }
  rebuildFtsIndexes(): Promise<{ rebuilt: string[] }> {
    return this.client.privateMemory.rebuildFtsIndexes();
  }
}
