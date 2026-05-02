/**
 * OpenClaw agent tools for abmind.
 *
 * Registered via api.registerTool() in openclaw-plugin/index.ts.
 *
 * Type strategy: we type pi-agent-core boundaries as `any` (option b.1 from
 * the #347 plan discussion). Rationale: pi-agent-core isn't a peer dep — we
 * accept runtime-only validation of the AgentTool contract. OpenClaw's tool
 * runner catches shape errors at registration time; integration tests catch
 * them in CI. This keeps abmind's dep graph clean for standalone users.
 *
 * We DO peer-dep @sinclair/typebox because the schema builder is needed at
 * runtime to construct the parameter schema in the shape pi-agent-core
 * expects. Optional peer — not installed for standalone users who don't
 * load this plugin.
 */

import { Type, type Static } from "@sinclair/typebox";
import { getRuntime } from "../runtime-store.js";
import { toChatId } from "./session-mapper.js";
import type { AbmindPluginRuntime } from "./types.js";

// ── Schema ────────────────────────────────────────────────────────────────

const AbmindRecallSchema = Type.Object({
  query: Type.String({
    description:
      "The search query. English keywords work best. For multilingual content, try both the original language and English translation.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Max results to return. Default 10, range 1-50.",
      minimum: 1,
      maximum: 50,
    }),
  ),
  topic: Type.Optional(
    Type.String({
      description: "Optional topic filter (e.g. 'work', 'relationships', 'health').",
    }),
  ),
  emotion: Type.Optional(
    Type.String({
      description:
        "Optional emotion filter — tag (joy, frust, convict) or group (positive, negative, high-energy).",
    }),
  ),
});

type AbmindRecallParams = Static<typeof AbmindRecallSchema>;

// ── Result shape (for JSON rendering) ─────────────────────────────────────

interface RecallHitSummary {
  id?: number;
  content: string;
  date: string;
  source: string;
  score: number;
  memoryType?: string;
  topic?: string;
}

interface AbmindRecallDetails {
  count: number;
  hits: RecallHitSummary[];
}

/**
 * Render a payload as an AgentToolResult. Matches lossless-claw's jsonResult
 * convention: JSON-as-pretty-text in content[0].text, raw object in details.
 */
function jsonResult<T>(payload: T): { content: Array<{ type: "text"; text: string }>; details: T } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ── Tool factory ──────────────────────────────────────────────────────────

/**
 * Create the abmind_recall tool bound to a plugin instance and session.
 *
 * @param pluginId   Matches the id the runtime was registered under in runtime-store
 * @param sessionKey OpenClaw session key (from ctx.sessionKey in the registerTool factory).
 *                   When present, recall is scoped to that session's chatId.
 *                   When absent, recall falls back to the runtime's default user.
 *
 * Return type is `any` intentionally — we don't peer-dep pi-agent-core, so the
 * AgentTool type isn't in scope here. OpenClaw validates the shape at
 * registration time; an integration test catches contract drift.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAbmindRecallTool(pluginId: string, sessionKey: string | undefined): any {
  return {
    name: "abmind_recall",
    label: "Abmind Recall",
    description:
      "Search long-term memory for past conversations, facts, decisions. Use when user references earlier sessions or asks you to remember something. Optional filters: topic, emotion.",
    parameters: AbmindRecallSchema,
    async execute(_toolCallId: string, params: AbmindRecallParams, _signal?: AbortSignal) {
      const runtime = getRuntime<AbmindPluginRuntime>(pluginId);
      const chatId = sessionKey ? toChatId(sessionKey) : undefined;
      const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);

      const result = await runtime.memory.recallSearch({
        translated: [params.query],
        userId: chatId ?? "default",
        limit,
        maxClassification: 2, // hardcoded — tool callers never see SECRET (class 3)
        topic: params.topic,
        emotion: params.emotion,
      });

      const hits: RecallHitSummary[] = result.results.map((h) => ({
        id: h.id,
        content: h.content,
        date: h.date,
        source: h.source,
        score: h.score,
        memoryType: h.memoryType,
        topic: h.topic,
      }));

      return jsonResult<AbmindRecallDetails>({
        count: hits.length,
        hits,
      });
    },
  };
}

// ── Store tool ────────────────────────────────────────────────────────────

const AbmindStoreSchema = Type.Object({
  content: Type.String({ description: "Memory content (English). For credentials, store the exact string." }),
  original: Type.Optional(Type.String({ description: "Original language content (if not English)" })),
  type: Type.String({ description: "Memory type", enum: ["fact", "decision", "preference", "event", "lesson", "feedback", "story"] }),
  topic: Type.Optional(Type.String({ description: "Topic tag (coding, personal, finance, health, work, etc.)" })),
  classification: Type.Optional(Type.Integer({ description: "0=public, 1=internal, 2=confidential, 3=secret (credentials — store IMMEDIATELY with exact string)", minimum: 0, maximum: 3 })),
  emotion: Type.Optional(Type.Integer({ description: "Emotion score -5 to +5 (0=neutral)", minimum: -5, maximum: 5 })),
});

type AbmindStoreParams = Static<typeof AbmindStoreSchema>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAbmindStoreTool(pluginId: string, sessionKey: string | undefined): any {
  return {
    name: "abmind_store",
    label: "Abmind Store",
    description:
      "Store a memory. Use after learning facts, preferences, decisions. API keys/tokens/passwords → classification=3 with exact string, immediately.",
    parameters: AbmindStoreSchema,
    async execute(_toolCallId: string, params: AbmindStoreParams, _signal?: AbortSignal) {
      const runtime = getRuntime<AbmindPluginRuntime>(pluginId);
      const userId = sessionKey ? toChatId(sessionKey) : "default";

      const result = await runtime.memory.editor.instantStore({
        userId,
        contentEn: params.content,
        contentOriginal: params.original ?? params.content,
        memoryType: params.type as "fact" | "decision" | "preference" | "event" | "lesson" | "feedback" | "story",
        topic: params.topic ?? "general",
        classification: params.classification ?? 1,
        emotionScore: params.emotion ?? 0,
      });
      return jsonResult(result);
    },
  };
}
