/**
 * IMemoryCore / IMemorySystem / IHeartbeat — abmind's in-process object-graph API.
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ When to use which                                                          │
 * ├────────────────────────────────────────────────────────────────────────────┤
 * │ IMemoryCore     Public read-oriented API. Search, recall, wake-up context, │
 * │                 stats, core knowledge. No message writes, no maintenance.  │
 * │                 Use when: embedding abmind in-process (MCP server host,    │
 * │                 openclaw plugin, kiro-cli steering, standalone CLI) and    │
 * │                 you only need to READ memory + build context.              │
 * │                                                                            │
 * │ IMemorySystem   IMemoryCore + bridge-internal methods: recordMessage,      │
 * │                 emotion updates, LLM callbacks, heartbeat control, sleep   │
 * │                 data access, maintenance (WAL/FTS/dedup/backfill).         │
 * │                 Use when: hosting abmind like abtars does — you own   │
 * │                 the full lifecycle, inject an LLM/heartbeat, and need the  │
 * │                 write path for incoming messages.                          │
 * │                                                                            │
 * │ IHeartbeat      The host's scheduler. Bridge implements it; abmind only    │
 * │                 knows the contract (registerTask / stop / intervalMs).     │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Concrete implementation: `MemoryManager` implements both IMemoryCore and
 * IMemorySystem. External consumers declare variables as the narrowest type
 * that fits their need — normally IMemoryCore.
 *
 * Relationship to MemoryBackend (see memory-backend.ts):
 *   IMemoryCore/IMemorySystem  = in-process, direct object reference
 *   MemoryBackend              = transport-agnostic, async-only, used by
 *                                CLI tools + Direct-API tool-registry so
 *                                they don't care whether storage is local
 *                                SQLite or an IPC socket to another process.
 *
 * Rule of thumb:
 *   - Running inside the host process? → IMemoryCore (read) or IMemorySystem (full)
 *   - Shelled-out CLI / tool call / IPC boundary? → MemoryBackend
 */

import type { SearchOptions, SearchResult, MessageRecord } from "./mem-types.js";
import type { MemoryConfig } from "./memory-config.js";

/** Public API — what external consumers program against. */
export interface IMemoryCore {
  initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void>;
  close(): void;

  // Search & recall
  search(query: string, opts?: SearchOptions): Promise<SearchResult[]>;
  substringSearch(query: string, opts?: SearchOptions): SearchResult[];
  recallSearch(params: import("./recall-engine.js").RecallParams): Promise<import("./recall-engine.js").RecallResult>;
  bumpRecallCount(ids: number[]): void;

  // Context injection
  buildWakeUp(maxChars?: number): string;
  readCoreKnowledge(): string;
  getSessionBundle(): { soul: string; profile: string; notes: string; memoryTools: string; coreFacts: string };
  getEmotionalArcs(): Array<{ topic: string; arc: string }>;

  // Stats
  getStats(userId?: string): {
    totalMessages: number; extractedMemories: number; extractedByType: Record<string, number>;
    consolidationFiles: { daily: number; weekly: number; quarterly: number };
    ingestedDocuments: number; preservedKeywords: number; heartbeatRunning: boolean; dbSizeBytes: number;
    rejectedByScanner: number;
  } | null;
  getConfig(): MemoryConfig;
}

/** Bridge-internal API — extends IMemoryCore with transport/platform-specific methods. */
export interface IMemorySystem extends IMemoryCore {
  // Lifecycle
  initialize(opts?: { skipEmbeddingCheck?: boolean }): Promise<void>;
  close(): void;

  // Messages
  recordMessage(...args: [MessageRecord]): void;
  loadRecentMessages(userId: string, sessionId: string, count: number): MessageRecord[];
  getLastMessageTimestamp(excludeSystem?: boolean, sessionTypeFilter?: string): number;

  // Emotion
  updateEmotionByPlatformId(userId: string | string, platformMessageId: number, score: number, tag?: string): boolean;

  // Bridge-specific read-only
  getLatestCompaction(userId: string): { timestamp: number; summary: string } | null;
  getCronInfo(): { heartbeatRunning: boolean; intervalMs: number; tasks: string[]; taskStatuses: ReadonlyMap<string, string>; lastSleepAudit: string | null };

  // LLM integration
  setLlmCall(llmCall: (prompt: string, content: string) => Promise<string>): void;
  getLlmCall(): ((prompt: string, content: string) => Promise<string>) | null;

  // Heartbeat
  setHeartbeat(hb: IHeartbeat): void;
  stopHeartbeat(): void;

  // Sleep data access
  getSleepData(): import("./sleep-data-access.js").SleepDataAccess;

  // Dashboard
  getDistinctUserIds(): string[];
  getAllExtractedMemories(): unknown[];

  // Maintenance
  runWalCheckpoint(): boolean;
  rebuildFtsIndexes(): { rebuilt: string[] };
  cleanupOldMessages(opts: { maxCount: number; maxAgeDays: number; garbageHours: number }): { deleted: number };
  backfillEmbeddings(provider: import("./embedding-provider.js").IEmbeddingProvider): Promise<{ embedded: number }>;
  getEmbeddingProvider(): import("./embedding-provider.js").IEmbeddingProvider | null;
  deduplicateMessages(): { removed: number };
  fixMemoryDefaults(): { fixed: number };

  // Recall feedback (#836)
  bumpCitedCount(ids: number[]): void;
  bumpRejectedCount(ids: number[]): void;
}

/** Minimal heartbeat interface — bridge implements this, memory only knows the contract. */
export interface IHeartbeat {
  registerTask(task: { name: string; heavy?: boolean; execute: () => Promise<boolean | void> }): void;
  stop(): void;
  readonly intervalMs: number;
  getTaskNames(): string[];
  getTaskStatuses(): ReadonlyMap<string, string>;
}
