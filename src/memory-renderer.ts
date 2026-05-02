import { getAbmindEnv } from "./env-schema.js";
/**
 * memory-renderer.ts — Unified memory rendering with ABM-L version toggle.
 * v0: legacy positional format (current)
 * v1: slot-based structured format (explicit field names)
 *
 * Optional `role` field enables conversational-turn rendering (#348):
 * when present, emits `[USER|...]` or `[ASSISTANT|...]` prefix before
 * the normal header. Formalized in abm-language.md v1 spec.
 */

import { compress } from "./memory-compressor.js";
import { localMonth } from "./local-time.js";
import { TYPE_EMOJI, TOPIC_EMOJI, EMOTION_EMOJI, confidenceMarker } from "./abm-v2-vocab.js";

export interface RenderMemoryInput {
  content_en: string;
  topic?: string;
  emotion_tags?: string;
  importance_flags?: string;
  memory_type?: string;
  confidence?: number;
  date?: string;
  createdAt?: number;
  /** Optional conversational-turn role. When set, emits [USER|...] or [ASSISTANT|...] prefix. */
  role?: "user" | "assistant" | "USER" | "ASSISTANT";
}

/** Render a memory for injection. Branches by ABML_VERSION. */
export function renderMemory(input: RenderMemoryInput): string {
  const version = getAbmindEnv().abmlVersion;
  if (version === "v2") return renderV2(input);
  if (version === "v1") return renderV1(input);
  if (version === "v0") return renderV0(input);
  return renderPlain(input);
}

// ── plain: full English, universally understood ──────────────────────────────

function renderPlain(input: RenderMemoryInput): string {
  const type = input.memory_type ?? "fact";
  const date = input.date ?? (input.createdAt ? localMonth(new Date(input.createdAt)) : "");
  const topic = input.topic && input.topic !== "general" ? `, ${input.topic}` : "";
  const rolePrefix = input.role && input.role.toLowerCase() !== "assistant" ? `${input.role.toUpperCase()}, ` : "";
  const prefix = date ? `[${rolePrefix}${date}, ${type}${topic}]` : `[${rolePrefix}${type}${topic}]`;
  return `${prefix} ${input.content_en}`;
}

// ── v0: legacy positional format ─────────────────────────────────────────────

function renderV0(input: RenderMemoryInput): string {
  const { content_en } = input;
  const rolePrefix = input.role ? `${input.role.toUpperCase()}:` : "";
  if (content_en.length < getAbmindEnv().abmlMinChars) {
    const type = (input.memory_type ?? "fact").charAt(0).toUpperCase();
    const date = input.date ?? (input.createdAt ? localMonth(new Date(input.createdAt)) : "");
    return date ? `(${rolePrefix}${type}, ${date}) ${content_en}` : content_en;
  }
  // Long content: fall through to the existing compress() pipeline. If role
  // is set, prepend it to the compressed result (compress() doesn't know about roles).
  const compressed = compress({
    content_en,
    topic: input.topic ?? "general",
    emotion_tags: input.emotion_tags ?? "",
    importance_flags: input.importance_flags ?? "",
    memory_type: input.memory_type ?? "fact",
    confidence: input.confidence ?? 3,
    date: input.date ?? (input.createdAt ? localMonth(new Date(input.createdAt)) : undefined),
  });
  return input.role ? `${input.role.toUpperCase()}: ${compressed}` : compressed;
}

// ── v1: slot-based structured format ─────────────────────────────────────────

const TYPE_CODE: Record<string, string> = {
  fact: "F", decision: "D", preference: "P", event: "E",
  lesson: "L", feedback: "FB", story: "S", observation: "O",
};

function renderV1(input: RenderMemoryInput): string {
  const { content_en } = input;
  const type = TYPE_CODE[input.memory_type ?? "fact"] ?? "F";
  const topic = input.topic && input.topic !== "general" ? input.topic : undefined;
  const conf = input.confidence ?? 3;
  const date = input.date ?? (input.createdAt ? localMonth(new Date(input.createdAt)) : undefined);

  // Header: [ROLE?|TYPE|topic|conf|date]
  const headerParts: string[] = [];
  if (input.role) headerParts.push(input.role.toUpperCase());
  headerParts.push(type);
  if (topic) headerParts.push(topic);
  headerParts.push(String(conf));
  if (date) headerParts.push(date);
  const header = `[${headerParts.join("|")}]`;

  // Emotion/importance as inline tags
  const tags: string[] = [];
  if (input.emotion_tags) tags.push(`emo=(${input.emotion_tags})`);
  if (input.importance_flags) tags.push(`imp=(${input.importance_flags})`);
  const tagStr = tags.length > 0 ? ` ${tags.join(" ")}` : "";

  return `${header} ${content_en}${tagStr}`;
}

// ── v2: emoji content layer ──────────────────────────────────────────────────

function renderV2(input: RenderMemoryInput): string {
  const { content_en } = input;
  const typeEmoji = TYPE_EMOJI[input.memory_type ?? "fact"] ?? "📌";
  const topicEmoji = TOPIC_EMOJI[input.topic ?? "general"] ?? "";
  const emotionEmoji = input.emotion_tags
    ? input.emotion_tags.split(",").map(e => EMOTION_EMOJI[e.trim()] ?? "").filter(Boolean).join("") || "—"
    : "—";
  const conf = confidenceMarker(input.confidence ?? 3);
  const date = input.date ?? (input.createdAt ? localMonth(new Date(input.createdAt)) : "");

  // Header: [typeEmoji|topicEmoji|emotionEmoji|conf|date]
  const headerParts: string[] = [];
  if (input.role) headerParts.push(input.role.toUpperCase());
  headerParts.push(typeEmoji);
  if (topicEmoji) headerParts.push(topicEmoji);
  headerParts.push(emotionEmoji);
  headerParts.push(conf);
  if (date) headerParts.push(date);
  const header = `[${headerParts.join("|")}]`;

  // Body: compress content — strip filler, keep entities as @name
  const body = compressV2Body(content_en);
  return `${header} ${body}`;
}

/** Compress body for v2: truncate long content, preserve @entities. */
function compressV2Body(text: string): string {
  if (text.length <= 120) return text;
  // Keep @entities visible even if they'd be cut
  const entities = text.match(/@\w+/g) ?? [];
  let body = text.slice(0, 117) + "...";
  for (const e of entities) {
    if (!body.includes(e)) body = `${e} ${body}`;
  }
  return body;
}
