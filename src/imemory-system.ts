/**
 * IMemoryCore / IMemorySystem / IOperationalMemoryCore — abmind's in-process
 * object-graph API.
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ When to use which                                                          │
 * ├────────────────────────────────────────────────────────────────────────────┤
 * │ IMemoryCore             Public read-oriented API. Search, recall, wake-up  │
 * │                         context, stats, core knowledge. No message writes, │
 * │                         no maintenance. Use when: embedding abmind         │
 * │                         in-process (MCP server host, openclaw plugin,      │
 * │                         kiro-cli steering, standalone CLI) and you only    │
 * │                         need to READ memory + build context.               │
 * │                                                                            │
 * │ IMemorySystem           IMemoryCore + bridge-internal methods:             │
 * │                         recordMessage, emotion updates, sleep              │
 * │                         data access, maintenance (WAL/FTS/dedup/backfill). │
 * │                         Use when: hosting abmind like abtars does — you    │
 * │                         own the full lifecycle and need the                │
 * │                         write path for incoming messages.                  │
 * │                                                                            │
 * │ IOperationalMemoryCore  Operational memory API (scoped recall, draft       │
 * │                         submission/promotion/rejection, version history).  │
 * │                         The `operational` property is null before init,    │
 * │                         when memory is disabled, after close, or after     │
 * │                         failed init. Consumers that need both memory       │
 * │                         and operational domains use                        │
 * │                         `IMemoryCore & IOperationalMemoryCore`.            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Concrete implementation: `MemoryManager` implements IMemoryCore, IMemorySystem,
 * and IOperationalMemoryCore. External consumers declare variables as the
 * narrowest type that fits their need.
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

// ── Operational memory imports (#1372) ─────────────────────────────────────

import type {
  OperationalDraft,
  OperationalMemoryVersion,
  OperationalMemoryProjection,
  OperationalRecallHit,
  Page,
  PageRequest,
  DraftListQuery,
  OperationalRecallQuery,
  SubmitOperationalDraftInput,
  PromoteDraftInput,
  RejectDraftInput,
  ReviseOperationalMemoryInput,
  RetireOperationalMemoryInput,
  OperationalResult,
} from "./operational-memory-types.js";

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
    ingestedDocuments: number; preservedKeywords: number; dbSizeBytes: number;
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
  recordMessage(...args: [MessageRecord]): number | null;
  loadRecentMessages(userId: string, sessionId: string, count: number): MessageRecord[];
  getLastMessageTimestamp(excludeSystem?: boolean, sessionTypeFilter?: string): number;

  // Emotion
  updateEmotionByPlatformId(userId: string | string, platformMessageId: number | string, score: number, tag?: string): boolean;

  // Heartbeat


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

// ── Operational memory core (#1372) ────────────────────────────────────────

export interface IOperationalMemoryCore {
  /** Operational memory API facade, or null before init / after close / on failure. */
  readonly operational: OperationalMemoryApi | null;
}

export interface OperationalMemoryApi {
  submitDraft(input: SubmitOperationalDraftInput): Promise<OperationalResult<OperationalDraft>>;
  listDrafts(query: DraftListQuery): Promise<OperationalResult<Page<OperationalDraft>>>;
  getMemory(memoryId: string): Promise<OperationalResult<OperationalMemoryProjection>>;
  getHistory(memoryId: string, page: PageRequest): Promise<OperationalResult<Page<OperationalMemoryVersion>>>;
  promoteDraft(input: PromoteDraftInput): Promise<OperationalResult<OperationalMemoryProjection>>;
  rejectDraft(input: RejectDraftInput): Promise<OperationalResult<OperationalDraft>>;
  revise(input: ReviseOperationalMemoryInput): Promise<OperationalResult<OperationalMemoryProjection>>;
  retire(input: RetireOperationalMemoryInput): Promise<OperationalResult<OperationalMemoryProjection>>;
  recall(query: OperationalRecallQuery): Promise<OperationalResult<Page<OperationalRecallHit>>>;
}

