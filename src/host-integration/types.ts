export interface ExecutionIdentity {
  readonly principalId: string;
  readonly conversationId: string;
  readonly executionId: string;
  readonly parentExecutionId?: string;
  readonly host: string;
  readonly origin: string;
  readonly automaticWriteOwner: string;
}

export interface HostLifecycleOptions {
  readonly writerId: string;
  readonly failOpen?: boolean;
}

export interface AutomaticRecallPolicy {
  limit: number;
  maxChars: number;
  minScore?: number;
  maxClassification?: 0 | 1 | 2;
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
  prompt: string;
  query: {
    translated: readonly string[];
    original?: string;
  };
  policy: AutomaticRecallPolicy;
  /**
   * #1813 — optional fast-path intent. Turn identity comes from the validated
   * ExecutionIdentity (principalId/conversationId/executionId); only the
   * question, language, and already-delivered refs are caller-supplied.
   */
  fastPath?: {
    question: string;
    answerLanguage?: string;
    delivered?: ReadonlyArray<{ readonly id: number; readonly revision: number }>;
    releaseScope?: boolean;
  };
}

export interface PrepareTurnResult {
  context: string;
  hits: readonly RecallHit[];
  diagnostics: readonly HostDiagnostic[];
  /** #1813 — decision envelope when the recall produced one. */
  decision?: import("../recall-engine.js").RecallDecisionV1;
}

export interface RecallHit {
  content: string;
  date: string;
  score: number;
  classification?: number;
  /**
   * #1383 — structured source reference, passed through from the engine when
   * it supplies one. Absent means the hit carries no stable ref; callers must
   * not treat position or content as identity.
   */
  id?: number;
  revision?: number;
}

export interface CompleteTurnInput {
  identity: ExecutionIdentity;
  user?: { content: string; timestamp?: number };
  assistant?: { content: string; timestamp?: number };
}

export type CompleteTurnResult =
  | { status: "recorded"; messageIds: readonly number[] }
  | { status: "skipped"; reason: "not_owner" | "empty" | "rejected" }
  | { status: "failed"; diagnostic: HostDiagnostic };

export interface ExplicitRecallInput {
  identity: ExecutionIdentity;
  query: {
    translated: readonly string[];
    original?: string;
  };
  limit?: number;
  minScore?: number;
  maxClassification?: number;
  /** #1813 — optional fast-path intent; identity as in PrepareTurnInput. */
  fastPath?: {
    question: string;
    answerLanguage?: string;
    delivered?: ReadonlyArray<{ readonly id: number; readonly revision: number }>;
    releaseScope?: boolean;
  };
}

export type RecallOperationResult = PrepareTurnResult;

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
  | { status: "checkpointed"; messageIds: readonly number[]; rejected: number }
  | { status: "skipped"; reason: "not_owner" | "empty" | "all_rejected" }
  | { status: "failed"; diagnostic: HostDiagnostic };
