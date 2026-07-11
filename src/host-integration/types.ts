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
}

export interface PrepareTurnResult {
  context: string;
  hits: readonly RecallHit[];
  diagnostics: readonly HostDiagnostic[];
}

export interface RecallHit {
  content: string;
  date: string;
  score: number;
  classification?: number;
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
