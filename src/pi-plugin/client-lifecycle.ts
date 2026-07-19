import type { AbmindClient } from "../abmind-client.js";
import type { ExecutionIdentity } from "../host-integration/types.js";
import { validateIdentity, canAutoWrite, buildProvenance } from "../host-integration/identity.js";
import { renderRecallContext } from "../host-integration/render.js";
import { isOperationAvailable, type PiMemoryCapabilities, type PiClientConnection } from "./client-connection.js";

const CAPTURE_KEY_PREFIX = "pi-capture";

function captureIdempotencyKey(executionId: string, generation: number, role: string): string {
  return `${CAPTURE_KEY_PREFIX}:${executionId}:${generation}:${role}`;
}

export interface PiMemoryLifecycle {
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  prepareTurn(input: PrepareTurnInput): Promise<PrepareTurnResult>;
  completeTurn(input: PiCompleteTurnInput): Promise<CompleteTurnResult>;
  recall(input: ExplicitRecallInput): Promise<RecallOperationResult>;
  store(input: ExplicitStoreInput): Promise<import("../mem-types.js").InstantStoreResult>;
  capability(operation: "wakeUp" | "recall" | "capture" | "store"): boolean;
  close(): Promise<void>;
}

export interface StartSessionInput {
  identity: ExecutionIdentity;
  maxChars: number;
}

export type StartSessionResult =
  | { ok: true; context: string }
  | { ok: false; context: "" };

export interface PrepareTurnInput {
  identity: ExecutionIdentity;
  prompt: string;
  query: { translated: readonly string[]; original?: string };
  policy: { limit: number; maxChars: number; minScore?: number; maxClassification?: 0 | 1 | 2 };
}

export interface PrepareTurnResult {
  context: string;
  hits: readonly { content: string; date: string; score: number }[];
}

export interface PiCompleteTurnInput {
  identity: ExecutionIdentity;
  user?: { content: string; timestamp?: number };
  assistant?: { content: string; timestamp?: number };
  captureGeneration: number;
  userTimestamp: number;
  assistantTimestamp: number;
}

export type CompleteTurnResult =
  | { status: "recorded"; messageIds: readonly number[] }
  | { status: "skipped"; reason: "not_owner" | "empty" | "rejected" }
  | { status: "failed"; diagnostic: { operation: string; code: string; message: string } };

export interface ExplicitRecallInput {
  identity: ExecutionIdentity;
  query: { translated: readonly string[]; original?: string };
  limit?: number;
  minScore?: number;
  maxClassification?: number;
}

export type RecallOperationResult = PrepareTurnResult;

export interface ExplicitStoreInput {
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
}

function clampPolicy(policy: PrepareTurnInput["policy"]): Required<PrepareTurnInput["policy"]> {
  return {
    limit: Math.max(1, Math.min(50, Math.floor(policy.limit ?? 5))),
    maxChars: Math.max(1, Math.floor(policy.maxChars ?? 8_000)),
    minScore: policy.minScore !== undefined ? Math.max(0, Math.min(1, policy.minScore)) : 0,
    maxClassification: policy.maxClassification !== undefined
      ? (Math.min(2, Math.max(0, Math.floor(policy.maxClassification))) as 0 | 1 | 2)
      : 2,
  };
}

function readCapabilities(connection: PiClientConnection): PiMemoryCapabilities | null {
  const st = connection.state;
  if (st.kind === "ready") return st.clientCapabilities;
  return null;
}

export function createClientLifecycle(
  connection: PiClientConnection,
  writerId: string,
): PiMemoryLifecycle {
  async function getClient(): Promise<AbmindClient> {
    const result = await connection.ensureReady();
    if (!result.ok) throw new Error(`unavailable:${result.code}`);
    return result.client;
  }

  const lifecycle: PiMemoryLifecycle = {
    capability(operation) {
      const caps = readCapabilities(connection);
      if (!caps) return false;
      return isOperationAvailable(operation, caps);
    },

    async startSession(input) {
      try {
        const { diagnostics: diag } = validateIdentity(input.identity);
        if (diag.length > 0) return { ok: false, context: "" };

        const caps = readCapabilities(connection);
        if (!caps || !isOperationAvailable("wakeUp", caps)) {
          return { ok: false, context: "" };
        }

        const client = await getClient();
        const result = await client.privateMemory.assembleSessionContext({
          userId: input.identity.principalId,
          maxChars: Math.max(1, Math.floor(input.maxChars)),
        });
        return { ok: true, context: result.wakeUp ?? "" };
      } catch {
        return { ok: false, context: "" };
      }
    },

    async prepareTurn(input) {
      try {
        const { diagnostics: diag } = validateIdentity(input.identity);
        if (diag.length > 0) return { context: "", hits: [] };

        const caps = readCapabilities(connection);
        if (!caps || !isOperationAvailable("recall", caps)) {
          return { context: "", hits: [] };
        }

        const policy = clampPolicy(input.policy);
        const client = await getClient();
        const result = await client.privateMemory.recall({
          translated: [...input.query.translated],
          original: input.query.original,
          userId: input.identity.principalId,
          limit: policy.limit,
          maxClassification: policy.maxClassification,
        });

        const hits = result.results
          .filter(h => h.score >= policy.minScore)
          .map(h => ({ content: h.content, date: h.date, score: h.score }));

        const context = renderRecallContext(hits, policy.maxChars);
        return { context, hits };
      } catch {
        return { context: "", hits: [] };
      }
    },

    async completeTurn(input) {
      try {
        const { identity, diagnostics: diag } = validateIdentity(input.identity);
        if (diag.length > 0) {
          return { status: "failed", diagnostic: diag[0]! };
        }

        const caps = readCapabilities(connection);
        if (!caps || !isOperationAvailable("capture", caps)) {
          return { status: "skipped", reason: "rejected" };
        }

        if (!canAutoWrite(identity, writerId)) {
          return { status: "skipped", reason: "not_owner" };
        }

        if (!input.user?.content?.trim() && !input.assistant?.content?.trim()) {
          return { status: "skipped", reason: "empty" };
        }

        const client = await getClient();
        const messageIds: number[] = [];

        if (input.user?.content?.trim()) {
          const userKey = captureIdempotencyKey(identity.executionId, input.captureGeneration, "user");
          const id = await client.privateMemory.recordMessage({
            userId: identity.principalId,
            sessionId: identity.conversationId,
            role: "user",
            content: input.user.content,
            timestamp: input.userTimestamp,
          }, userKey);
          if (id !== null) messageIds.push(id.id!);
        }

        if (input.assistant?.content?.trim()) {
          const assistantKey = captureIdempotencyKey(identity.executionId, input.captureGeneration, "assistant");
          const id = await client.privateMemory.recordMessage({
            userId: identity.principalId,
            sessionId: identity.conversationId,
            role: "assistant",
            content: input.assistant.content,
            timestamp: input.assistantTimestamp,
          }, assistantKey);
          if (id !== null) messageIds.push(id.id!);
        }

        if (messageIds.length === 0) {
          return { status: "skipped", reason: "rejected" };
        }
        return { status: "recorded", messageIds };
      } catch {
        return { status: "skipped", reason: "rejected" };
      }
    },

    async recall(input) {
      try {
        const { diagnostics: diag } = validateIdentity(input.identity);
        if (diag.length > 0) return { context: "", hits: [] };

        const caps = readCapabilities(connection);
        if (!caps || !isOperationAvailable("recall", caps)) {
          return { context: "", hits: [] };
        }

        const limit = input.limit !== undefined ? Math.max(1, Math.min(50, Math.floor(input.limit))) : 5;
        const maxClassification = input.maxClassification !== undefined
          ? Math.max(0, Math.min(3, Math.floor(input.maxClassification)))
          : undefined;

        const client = await getClient();
        const result = await client.privateMemory.recall({
          translated: [...input.query.translated],
          original: input.query.original,
          userId: input.identity.principalId,
          limit,
          maxClassification,
        });

        const hits = result.results
          .filter(h => input.minScore === undefined || h.score >= input.minScore)
          .map(h => ({ content: h.content, date: h.date, score: h.score }));

        const context = renderRecallContext(hits, 10000);
        return { context, hits };
      } catch {
        return { context: "", hits: [] };
      }
    },

    async store(input) {
      const caps = readCapabilities(connection);
      if (!caps || !isOperationAvailable("store", caps)) {
        return { stored: false, memoriesCount: 0, error: "private_write_unavailable" };
      }

      const client = await getClient();
      return client.privateMemory.instantStore({
        userId: input.identity.principalId,
        contentEn: input.contentEn,
        contentOriginal: input.contentOriginal,
        memoryType: input.memoryType,
        emotionScore: input.emotionScore,
        emotionTags: input.emotionTags,
        emotionContext: input.emotionContext,
        keyword: input.keyword,
        confidence: input.confidence,
        sourceMessageIds: input.sourceMessageIds,
        classification: input.classification,
        trust: input.trust,
        integrity: input.integrity,
        credibility: input.credibility,
        topic: input.topic,
        createdBy: buildProvenance(input.identity, writerId, "store"),
      });
    },

    async close() {
      await connection.close();
    },
  };

  return lifecycle;
}
