/**
 * context-render-primitives.ts — neutral owner for shared rendering
 * primitives (#1883).
 *
 * Pure functions and constants used by both the native projection path
 * (context-projector / context-native-renderer) and the legacy tier
 * renderer. Moved here so the native path no longer imports the legacy
 * engine module for types, constants, or codec helpers. No database,
 * provider, cache, or engine authority lives in this module.
 */

import { renderMemory } from "./memory-renderer.js";
import { typeCodeToFull } from "./turn-classifier.js";
import { localMonth } from "./local-time.js";

/** Characters per token for context token estimation (all tiers). */
export const CHARS_PER_TOKEN = 4;

/** Floor for the tool-pruning recent region (all paths). */
export const TAIL_MIN_MESSAGES = 12;

export type Tier = "tail" | "middle" | "head";

export interface MessageWithHints {
  id: number;
  role: string;
  content: string;
  timestamp: number;
  type_hint?: string | null;
  topic_hint?: string | null;
  emotion_hint?: string | null;
}

/**
 * Determine which tier a message belongs to based on its position from the end.
 * Pure function — deterministic given inputs.
 */
export function determineTier(
  positionFromEnd: number,
  tailSize: number,
  middleSize: number,
): Tier {
  if (positionFromEnd < tailSize) return "tail";
  if (positionFromEnd < tailSize + middleSize) return "middle";
  return "head";
}

/**
 * Render a single conversation turn as ABM-L using the configured codec.
 * Pure function of (message_with_hints, ABML_VERSION).
 *
 * Falls back to defaults when hints are null (historical messages from
 * before the classifier was added).
 */
export function renderMiddleTurn(msg: MessageWithHints): string {
  const typeCode = msg.type_hint ?? null;
  const memoryType = typeCodeToFull(typeCode);
  const topic = msg.topic_hint ?? "general";
  const emotion = msg.emotion_hint ?? "";
  const date = localMonth(new Date(msg.timestamp));

  return renderMemory({
    role: (msg.role === "assistant" || msg.role === "ASSISTANT" ? "assistant" : "user"),
    memory_type: memoryType,
    topic,
    emotion_tags: emotion,
    content_en: msg.content,
    confidence: 3,
    date,
  });
}
