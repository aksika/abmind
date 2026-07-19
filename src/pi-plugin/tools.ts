import { Type } from "typebox";
import type { Static } from "typebox";
import type { ExecutionIdentity } from "../host-integration/types.js";
import { extractEnglishTokens } from "../query-tokenizer.js";
import { defineTool, type ToolDefinition, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiMemoryLifecycle } from "./client-lifecycle.js";

const MemoryTypeEnum = Type.Union([
  Type.Literal("fact"),
  Type.Literal("decision"),
  Type.Literal("preference"),
  Type.Literal("event"),
  Type.Literal("lesson"),
  Type.Literal("feedback"),
  Type.Literal("story"),
  Type.Literal("secret"),
]);

const recallParamsSchema = Type.Object({
  query: Type.String({ minLength: 1, description: "Search query — English terms likely to appear in stored memory" }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50, default: 10, description: "Maximum number of results" })),
  minScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Minimum relevance score threshold" })),
  maxClassification: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, default: 2, description: "Maximum classification level (0=general, 3=personal)" })),
});

type RecallParams = Static<typeof recallParamsSchema>;

const VALID_MEMORY_TYPES = ["fact", "decision", "preference", "event", "lesson", "feedback", "story", "secret"] as const;
type MemoryType = typeof VALID_MEMORY_TYPES[number];

function toMemoryType(raw: string | undefined): MemoryType {
  if (raw && (VALID_MEMORY_TYPES as readonly string[]).includes(raw)) return raw as MemoryType;
  return "fact";
}

const storeParamsSchema = Type.Object({
  content: Type.String({ minLength: 1, description: "Memory content in canonical English" }),
  original: Type.Optional(Type.String({ description: "Original-language text (if translated)" })),
  type: Type.Optional(MemoryTypeEnum),
  topic: Type.Optional(Type.String({ description: "Topic label for categorization" })),
  classification: Type.Optional(Type.Integer({ minimum: 0, maximum: 3, description: "Classification level (0=general, 3=highly personal)" })),
  emotion: Type.Optional(Type.Integer({ minimum: -5, maximum: 5, description: "Emotional valence (-5=negative, 0=neutral, 5=positive)" })),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence in the memory accuracy" })),
});

type StoreParams = Static<typeof storeParamsSchema>;

interface ToolDeps {
  lifecycle: PiMemoryLifecycle;
  getIdentity(): ExecutionIdentity;
}

function unavailableResult(msg: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text" as const, text: msg }],
    details: { available: false },
  };
}

export function createRecallTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: "abmind_recall",
    label: "Abmind Recall",
    description: "Search past memories, decisions, and facts stored by abmind. Returns relevant memory hits with scores.",
    promptSnippet: "When the user asks about past decisions, preferences, or information that might have been stored in memory, use abmind_recall.",
    promptGuidelines: [
      "Use this tool when you need to remember information from past conversations",
      "Formulate queries using key English terms the memory might be indexed under",
      "Results include a relevance score — higher is better",
    ],
    parameters: recallParamsSchema,
    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Recall cancelled." }], details: { cancelled: true } };
      }

      if (!deps.lifecycle.capability("recall")) {
        return unavailableResult("Memory recall is not available.");
      }

      const params = rawParams as unknown as RecallParams;
      const identity = deps.getIdentity();
      const tokens = extractEnglishTokens(params.query ?? "");
      const limit = params.limit ?? 10;
      const maxClassification = params.maxClassification ?? 2;

      try {
        const result = await deps.lifecycle.recall({
          identity,
          query: { translated: tokens.length > 0 ? tokens : [params.query], original: params.query },
          limit,
          minScore: params.minScore,
          maxClassification,
        });

        const lines = result.hits.map(
          h => `- [${h.date}] (score: ${h.score.toFixed(3)}) ${h.content.slice(0, 200)}`,
        );
        const text = lines.length > 0
          ? `Found ${result.hits.length} memory hit(s):\n${lines.join("\n")}`
          : "No matching memories found.";

        return {
          content: [{ type: "text", text }],
          details: { hits: result.hits },
        };
      } catch (err) {
        return unavailableResult(`Recall failed: ${(err as Error).message}`);
      }
    },
  });
}

export function createStoreTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: "abmind_store",
    label: "Abmind Store",
    description: "Store a fact, decision, preference, event, lesson, or feedback in abmind for long-term memory. Content should be in canonical English.",
    promptSnippet: "When the user states a new preference, makes a decision, shares personal information, or expresses something worth remembering, use abmind_store.",
    promptGuidelines: [
      "Store factual information, user preferences, and decisions explicitly",
      "Write content in clear, canonical English for best retrieval later",
      "Use the memory type that best fits: fact, decision, preference, event, lesson, feedback, story, or secret",
    ],
    parameters: storeParamsSchema,
    async execute(
      _toolCallId: string,
      rawParams: Record<string, unknown>,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<unknown>> {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Store cancelled." }], details: { cancelled: true } };
      }

      if (!deps.lifecycle.capability("store")) {
        return unavailableResult("Memory store is not available. private_write capability required.");
      }

      const params = rawParams as unknown as StoreParams;
      const identity = deps.getIdentity();

      try {
        const result = await deps.lifecycle.store({
          identity,
          contentEn: params.content ?? "",
          contentOriginal: params.original ?? params.content ?? "",
          memoryType: toMemoryType(params.type),
          emotionScore: params.emotion ?? 0,
          topic: params.topic ?? "general",
          classification: params.classification ?? 1,
          confidence: params.confidence,
          emotionTags: undefined,
          emotionContext: undefined,
          keyword: undefined,
          sourceMessageIds: undefined,
          trust: undefined,
          integrity: undefined,
          credibility: undefined,
        });

        if (result.stored) {
          return {
            content: [{ type: "text", text: `Memory stored successfully (${result.memoriesCount} memory record(s)).` }],
            details: result,
          };
        }
        return {
          content: [{ type: "text", text: `Store failed: ${result.error ?? "unknown error"}` }],
          details: result,
        };
      } catch (err) {
        return unavailableResult(`Store failed: ${(err as Error).message}`);
      }
    },
  });
}
