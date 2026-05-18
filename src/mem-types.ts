/** A single conversation turn stored in a transcript and indexed for search. */
export type MessageRecord = {
  role: "user" | "assistant" | "compaction";
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  userId: string;
  sessionId: string;
  /** Platform-specific message ID (e.g. Telegram message_id) for reaction tracking */
  platformMessageId?: number;
};

/** Hierarchical memory consolidation tier. Quarterly added for new 3-tier compaction; monthly/yearly kept for backward compat. */
export type MemoryTier = "daily" | "weekly" | "quarterly" | "monthly" | "yearly";


/** A search result from the FTS5 index. */
export type SearchResult = {
  record: MessageRecord;
  /** BM25 relevance score */
  score: number;
};

/** A search result from the vector index. */
export type VectorSearchResult = {
  messageId: number;
  /** Cosine similarity score */
  score: number;
};

/** Options for filtering search results. */
export type SearchOptions = {
  userId?: string;
  startTime?: number;
  endTime?: number;
  limit?: number;
  topic?: string;
  tier?: "core" | "general";
  includeExpired?: boolean;
};

/** Assembled LLM context with per-tier token usage breakdown. */

/** Result of a forget/cascade-delete operation (Phase 2). */
export type ForgetResult = {
  messagesRemoved: number;
  embeddingsRemoved: number;
  transcriptEntriesRemoved: number;
};

/** A structured memory extracted from conversation transcripts by the MemoryExtractor. */
export type ExtractedMemory = {
  id?: number;
  user_id: string;
  content_original: string;
  content_en: string;
  memory_type: "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story" | "observation";
  created_at: number;
  preserve_original: boolean;
  preserved_keyword?: string;
  emotion_score: number;
  entities?: string[];
  topic?: string;
  tier?: "core" | "general";
  valid_from?: string;
  valid_to?: string | null;
};

/** Parameters for the agent-initiated memory search tool. */
export type MemorySearchParams = {
  keywords: string[];
  original_keyword?: string;
  time_range?: { start: number; end: number };
};

/** A single result from the memory search tool. */
export type MemorySearchResult = {
  id?: number;
  content: string;
  content_original?: string;
  memory_type?: string;
  created_at: number;
  source_message_ids?: string;
  tier: "extracted" | "daily" | "weekly" | "quarterly";
  score: number;
  trust?: number;
  integrity?: number;
  credibility?: number;
  classification?: number;
};

/** Heartbeat task definition. */
export type HeartbeatTask = {
  name: string;
  heavy?: boolean;
  execute: () => Promise<boolean | void>;
};

/** Parameters for the agent-initiated instant memory store tool. */
export type InstantStoreParams = {
  userId: string;
  contentEn: string;
  contentOriginal: string;
  memoryType: "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story";
  emotionScore: number;
  emotionTags?: string;
  emotionContext?: string;
  keyword?: string;
  confidence?: number;
  sourceMessageIds?: string;
  classification?: number;
  trust?: number;
  integrity?: number;
  credibility?: number;
  topic?: string;
  createdBy?: string;
};

/** Result of an instant memory store operation. */
export type InstantStoreResult = {
  stored: boolean;
  memoriesCount: number;
  error?: string;
};

/** Parameters for the memory edit tool. */
export type EditMemoryParams = {
  /** Lookup by memory ID (direct). */
  memoryId?: number;
  /** Lookup by platform message ID (finds linked memories). Requires userId. */
  messageId?: number;
  userId?: string;
  /** Editable fields — only provided fields are updated. */
  contentEn?: string;
  contentOriginal?: string;
  keyword?: string;
  memoryType?: "fact" | "decision" | "preference" | "event";
  emotionScore?: number;
  emotionTags?: string;
  emotionContext?: string;
  confidence?: number;
  trust?: number;
  integrity?: number;
  credibility?: number;
  classification?: number;
  /** Relevance: absolute number or string "+N"/"-N" for relative delta. */
  relevanceScore?: number | string;
  /** Caller for audit trail. */
  caller?: string;
  /** Declassify SECRET requires this. */
  userOverride?: boolean;
  /** Preview changes without committing. */
  dryRun?: boolean;
  /** ABM v1: topic assignment. */
  topic?: string;
  /** ABM v1: tier promotion/demotion. */
  tier?: "core" | "general";
  /** ABM v1: temporal invalidation (ISO date or empty string to clear). */
  validTo?: string | null;
};

/** Result of a memory edit operation. */
export type EditMemoryResult = {
  ok: boolean;
  memoriesUpdated?: number;
  ids?: number[];
  fieldsUpdated?: string[];
  error?: string;
};

