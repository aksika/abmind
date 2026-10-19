export interface ExecutionIdentity {
  readonly principalId: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly parentExecutionId?: string;
  /** Session generation bound by the host; bumped on switch/rewind/reset so
   * turn-number reuse across generations cannot collide. Defaults to 0. */
  readonly generation?: number;
  readonly host: string;
  readonly origin: string;
  readonly automaticWriteOwner: string;
}

/** Origins for which automatic conversation capture is disabled owner-side.
 * Deliberate explicit stores carry their own authority and are unaffected. */
export const NON_PRIMARY_ORIGINS: ReadonlySet<string> = new Set([
  "subagent",
  "cron",
  "flush",
  "maintenance",
]);

export interface HostLifecycleOptions {
  readonly writerId: string;
  readonly failOpen?: boolean;
}

export interface StartSessionInput {
  identity: ExecutionIdentity;
  maxChars: number;
}

export type StartSessionResult =
  | { ok: true; context: string; diagnostics: readonly HostDiagnostic[] }
  | { ok: false; context: ""; diagnostics: readonly HostDiagnostic[] };

export interface PrepareTurnInput {
  identity: ExecutionIdentity;
  /** The verbatim current turn. Fast recall plans from this text directly;
   * no host translation, keywords, or semantic policy objects are accepted. */
  prompt: string;
  /** Verified completed-turn snapshots for contextual recall. Identity must
   * bind to the current turn; anything else plans raw-only. */
  context?: readonly import("../ambient-planner.js").AmbientContextOption[];
  /** Host capacity for this turn. The host reserves its own wrapper
   * overhead before requesting; abmind never expands work for capacity. */
  capacity?: {
    maxItems?: number;
    maxOutputBytes?: number;
    deadlineMs?: number;
  };
}

export interface PrepareTurnResult {
  /** The owner packet: ordered items, owner-rendered text, stage coverage,
   * effective limits, omission reasons, and optional continuation. Hosts
   * deliver `packet.text` and must not re-render, clip, or reselect. */
  packet: import("../owned-recall-contract.js").OwnedRecallPacket;
  diagnostics: readonly HostDiagnostic[];
}

export interface TurnAuthor {
  readonly id?: string;
  readonly name?: string;
}

export interface CompleteTurnInput {
  identity: ExecutionIdentity;
  /** Execution this turn belongs to; defaults to identity.executionId.
   * Late arrivals keep their own execution — never rebound to the latest. */
  executionId?: string;
  /** Who wrote the user side; echoed back, never inferred. */
  author?: TurnAuthor;
  user?: { content: string; timestamp?: number };
  assistant?: { content: string; timestamp?: number };
}

export type CompleteTurnResult =
  | {
      status: "recorded";
      messageIds: readonly number[];
      /** Messages already checkpointed for this execution and skipped. */
      reconciled: number;
      executionId: string;
      author?: TurnAuthor;
    }
  | { status: "skipped"; reason: "not_owner" | "empty" | "rejected" }
  | { status: "failed"; diagnostic: HostDiagnostic };

export type ExplicitStoreInput = {
  identity: ExecutionIdentity;
  contentEn: string;
  contentOriginal: string;
  memoryType: "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story" | "secret";
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
};

export interface HostDiagnostic {
  operation: string;
  code: string;
  message: string;
}

/**
 * #1383 — pre-compress checkpoint input. Evidence messages are uncommitted
 * transcript content about to be discarded by the host. They are recorded
 * under a checkpoint-marked session for later extraction — never as
 * completed conversational turns.
 */
export interface CheckpointInput {
  identity: ExecutionIdentity;
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
    timestamp?: number;
  }>;
}

export type CheckpointResult =
  | { status: "checkpointed"; messageIds: readonly number[]; rejected: number; executionId: string }
  | { status: "skipped"; reason: "not_owner" | "empty" | "all_rejected" | "already_captured" }
  | { status: "failed"; diagnostic: HostDiagnostic };
