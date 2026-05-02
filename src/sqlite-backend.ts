/**
 * SqliteBackend — default MemoryBackend backed by SQLite + FTS5.
 * Wraps MemoryManager and its sub-services.
 */

import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";
import type { MergeResult, MemoryBackend } from "./memory-backend.js";
import { MemoryManager } from "./memory-manager.js";
import { recallSearch } from "./recall-engine.js";
import type { MemoryConfig } from "./memory-config.js";

export class SqliteBackend implements MemoryBackend {
  private memory: MemoryManager;
  private readonly config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this.config = config;
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

  async editMemory(params: EditMemoryParams): Promise<EditMemoryResult> {
    return this.memory.editor.editMemory(params);
  }

  async reclassifyMemory(id: number, level: number, userOverride: boolean): Promise<void> {
    this.memory.editor.reclassifyMemory(id, level, userOverride);
  }

  async adjustRelevance(id: number, delta: number): Promise<void> {
    this.memory.editor.adjustRelevance(id, delta);
  }

  async mergeMemories(idA: number, idB: number): Promise<MergeResult> {
    return this.memory.editor.mergeMemories(idA, idB) as MergeResult;
  }

  async cascadeDelete(messageIds: number[], userId: string): Promise<ForgetResult> {
    return this.memory.editor.cascadeDelete(messageIds, userId);
  }

  async recall(params: RecallParams): Promise<RecallResult> {
    const db = this.memory.getDatabase();
    if (!db) throw new Error("Database not initialized");
    const index = this.memory.getMemoryIndex();
    if (!index) throw new Error("Memory index not initialized");
    return recallSearch(
      { db, index, memoryDir: this.config.memoryDir },
      params,
    );
  }
}
