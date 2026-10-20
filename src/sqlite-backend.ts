/**
 * SqliteBackend — default MemoryBackend backed by SQLite + FTS5.
 * Wraps MemoryManager and its sub-services.
 */

import type { InstantStoreParams, InstantStoreResult, CascadeDeletePrivateMessagesInputV1, CascadeDeleteResultV1 } from "./mem-types.js";
import type { OwnedRecallRequest, OwnedRecallPacket } from "./owned-recall-contract.js";
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

  async cascadeDelete(input: CascadeDeletePrivateMessagesInputV1): Promise<CascadeDeleteResultV1> {
    return this.memory.editor.getMutationStore().cascadeDelete(
      { userId: input.userId, actorId: "cli", operationKey: `cli-cascade-${input.messageIds.length}`, canDeclassifySecret: false, origin: "cli" },
      input,
    );
  }

  async recall(request: import("./owned-recall-contract.js").OwnedRecallRequest): Promise<import("./owned-recall-contract.js").OwnedRecallPacket> {
    return this.memory.recall(request);
  }

  rebuildFtsIndexes(): { rebuilt: string[] } {
    return this.memory.rebuildFtsIndexes();
  }
}
