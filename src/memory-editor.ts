import type Database from "better-sqlite3";
import type { InstantStoreParams, InstantStoreResult } from "./mem-types.js";
import { logError, logInfo } from "./mem-logger.js";
import { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";

const TAG = "memory-editor";

export class MemoryEditor {
  private readonly mutationStore: PrivateMemoryMutationStore;
  constructor(
    private readonly db: Database.Database,
    ownerSnapshot?: string | null,
  ) {
    this.mutationStore = new PrivateMemoryMutationStore(db, ownerSnapshot);
  }

  getMutationStore(): PrivateMemoryMutationStore {
    return this.mutationStore;
  }

  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    try {
      const validTypes = new Set(["fact", "decision", "preference", "event", "lesson", "feedback", "story", "secret"]);
      if (!validTypes.has(params.memoryType)) return { stored: false, memoriesCount: 0, code: "validation_error", message: "invalid memory_type" };
      const result = await this.mutationStore.appendInstant(
        { userId: params.userId, actorId: params.createdBy ?? "memory-editor", operationKey: `editor-store-${Date.now()}`, canDeclassifySecret: false, origin: "internal" },
        params,
      );
      if (result.stored) logInfo(TAG, `Instant store: persisted memory for chat ${params.userId}`);
      return result;
    } catch (err) {
      logError(TAG, `Instant store failed for chat ${params.userId}`, err);
      return { stored: false, memoriesCount: 0, code: "unavailable", message: err instanceof Error ? err.message : String(err) };
    }
  }
}
