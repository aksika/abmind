/** A single conversation turn stored in a transcript and indexed for search. */
export type MessageRecord = {
  role: "user" | "assistant" | "compaction";
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  userId: string;
  sessionId: string;
  /** Platform-specific message ID (e.g. Telegram message_id) for reaction tracking */
  platformMessageId?: number | string;
};

/** A search result from the FTS5 index. */
export type SearchResult = {
  record: MessageRecord;
  /** BM25 relevance score */
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

/** Input for the revision-safe private cascade deletion operation (#1511). */
export interface CascadeDeletePrivateMessagesInputV1 {
  userId: string;
  messageIds: number[];
}

/** Result of a revision-safe private cascade deletion operation (#1511). */
export interface CascadeDeleteResultV1 {
  messagesRemoved: number;
  linkedMemoriesRemoved: number;
  embeddingsRemoved: number;
}

/** Parameters for the agent-initiated instant memory store tool. */
export type InstantStoreParams = {
  userId: string;
  contentEn: string;
  contentOriginal: string;
  // #1859: "observation" is a stored row kind (REM synthesis stores them via
  // the same CLI surface); the union now admits what the database holds.
  memoryType: "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story" | "observation" | "secret";
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
  /** Class-3 only (#1660): descriptive label stored in `content_en` — never the value. */
  sealedLabel?: string;
  /** Class-3 only (#1660): non-sensitive retrieval keyword. */
  sealedKeyword?: string;
  /** #1928 C8: raw step-04 proposal graph (entities/relations strings). Validated downstream. */
  graphEntitiesRaw?: string;
  graphRelationsRaw?: string;
};

/** Result of an instant memory store operation. */
export type InstantStoreResult =
  | {
      readonly stored: true;
      readonly memoriesCount: number;
      readonly memoryId: number;
      readonly semanticRevision: number;
      readonly contradicted?: { readonly id: number; readonly content: string; readonly reason: string };
    }
  | {
      readonly stored: false;
      readonly memoriesCount: 0;
      readonly code: "validation_error" | "unauthorized" | "unavailable";
      readonly message: string;
    };

// ── #1449: Semantic revision CAS types ──────────────────────────────────────

export interface PrivateMemoryRefV1 {
  memoryId: number;
  semanticRevision: number;
}

export type PrivateMutationStatusV1 =
  | { ok: true; ref: PrivateMemoryRefV1; deletedId?: number }
  | { ok: false; code: "conflict"; current: PrivateMemoryRefV1 }
  | { ok: false; code: "not_found" }
  | { ok: false; code: "unauthorized" }
  | { ok: false; code: "validation_error"; message: string };

export interface EffectivePrivateMutationContext {
  userId: string;
  actorId: string;
  operationKey: string;
  canDeclassifySecret: boolean;
  origin: "local" | "remote" | "dreamy" | "cli" | "adapter" | "internal";
}

export interface EditPrivateMemoryInputV1 {
  userId: string;
  memoryId: number;
  expectedRevision: number;
  contentEn?: string;
  contentOriginal?: string;
  /** Trusted maintenance operation: remove the preserved original value. */
  clearContentOriginal?: boolean;
  keyword?: string;
  memoryType?: "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story" | "secret";
  emotionScore?: number;
  emotionTags?: string;
  emotionContext?: string;
  confidence?: number;
  trust?: number;
  integrity?: number;
  credibility?: number;
  classification?: number;
  relevanceDelta?: number;
  relevanceScore?: number;
  topic?: string;
  tier?: "core" | "general";
  validTo?: string | null;
  /** Trusted owner-side curation field; not accepted from model tool callers. */
  emotionArc?: string | null;
  /** Class-3 promotion (#1660): descriptive label stored in `content_en`. */
  sealedLabel?: string;
  /** Class-3 promotion (#1660): non-sensitive retrieval keyword. */
  sealedKeyword?: string;
}

export interface ReclassifyPrivateMemoryInputV1 {
  userId: string;
  memoryId: number;
  expectedRevision: number;
  classification: 0 | 1 | 2 | 3;
  /** Class-3 promotion (#1660): descriptive label stored in `content_en`. */
  sealedLabel?: string;
  /** Class-3 promotion (#1660): non-sensitive retrieval keyword. */
  sealedKeyword?: string;
  /** Class-3 declassification (#1660): explicit non-sealed projection — both required. */
  declassifiedContentEn?: string;
  declassifiedContentOriginal?: string;
}

export interface MergePrivateMemoriesInputV1 {
  userId: string;
  first: PrivateMemoryRefV1;
  second: PrivateMemoryRefV1;
}

export const PRIVATE_MUTATION_CONTRACT_V1 = "revision-v1" as const;

export type PrivateMutationSafety =
  | "append-idempotent"
  | "semantic-revision-cas"
  | "owner-delete"
  | "owner-cascade-delete"
  | "atomic-counter"
  | "single-row-state-cas"
  | "unavailable";
