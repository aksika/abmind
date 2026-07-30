/**
 * SqliteBackend — default MemoryBackend backed by SQLite + FTS5.
 * Wraps MemoryManager and its sub-services.
 */

import type { InstantStoreParams, InstantStoreResult, EditPrivateMemoryInputV1, ReclassifyPrivateMemoryInputV1, AdjustPrivateRelevanceInputV1, MergePrivateMemoriesInputV1, PrivateMutationStatusV1, ForgetResult } from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";
import type { MemoryBackend } from "./memory-backend.js";
import { MemoryManager } from "./memory-manager.js";
export class SqliteBackend implements MemoryBackend {
  private memory: MemoryManager;

  constructor(config: import("./memory-config.js").MemoryConfig) {
    this.memory = new MemoryManager(config);
  }

  async initialize(): Promise<void> {
    await this.memory.initialize({ skipEmbeddingCheck: true });
  }

  close(): void {
    this.memory.close();
  }

  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    return this.memory.editor.instantStore(params);
  }

  async editMemory(params: EditPrivateMemoryInputV1): Promise<PrivateMutationStatusV1> {
    return this.memory.editor.getMutationStore().edit({ userId: params.userId, actorId: "cli", operationKey: `cli-edit-${params.memoryId}-${params.expectedRevision}`, canDeclassifySecret: false, origin: "cli" }, params);
  }

  async reclassifyMemory(params: ReclassifyPrivateMemoryInputV1): Promise<PrivateMutationStatusV1> {
    return this.memory.editor.getMutationStore().reclassify({ userId: params.userId, actorId: "cli", operationKey: `cli-reclassify-${params.memoryId}-${params.expectedRevision}`, canDeclassifySecret: false, origin: "cli" }, params);
  }

  async adjustRelevance(params: AdjustPrivateRelevanceInputV1): Promise<PrivateMutationStatusV1> {
    return this.memory.editor.getMutationStore().adjustRelevance({ userId: params.userId, actorId: "cli", operationKey: `cli-relevance-${params.memoryId}-${params.expectedRevision}`, canDeclassifySecret: false, origin: "cli" }, params);
  }

  async mergeMemories(params: MergePrivateMemoriesInputV1): Promise<PrivateMutationStatusV1> {
    return this.memory.editor.getMutationStore().merge({ userId: params.userId, actorId: "cli", operationKey: `cli-merge-${params.first.memoryId}-${params.second.memoryId}`, canDeclassifySecret: false, origin: "cli" }, params);
  }

  async cascadeDelete(messageIds: number[], userId: string): Promise<ForgetResult> {
    return this.memory.editor.cascadeDelete(messageIds, userId);
  }

  async recall(params: RecallParams): Promise<RecallResult> {
    return this.memory.recallSearch(params);
  }

  rebuildFtsIndexes(): { rebuilt: string[] } {
    return this.memory.rebuildFtsIndexes();
  }
}
