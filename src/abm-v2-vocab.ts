/**
 * abm-v2-vocab.ts — Canonical emoji vocabulary for ABM-L v2.
 * Seeded from convergent encodings in the emoji-compression study (2026-04-29).
 * Only emoji with ≥8/10 model agreement are canonical. Others fall back to text.
 */

// ── Memory type → emoji ─────────────────────────────────────────────────────

export const TYPE_EMOJI: Record<string, string> = {
  fact: "📌",
  decision: "🎯",
  preference: "❤️",
  event: "📅",
  lesson: "📚",
  feedback: "💬",
  story: "📖",
  observation: "💭",
  pivot: "🔀",
  milestone: "🏆",
  correction: "✏️",
};

// ── Topic → emoji ───────────────────────────────────────────────────────────

export const TOPIC_EMOJI: Record<string, string> = {
  coding: "💻",
  personal: "🏠",
  memory: "🧠",
  security: "🔒",
  relationships: "👥",
  finance: "💰",
  health: "🏥",
  work: "💼",
  tools: "🔧",
  projects: "📦",
  people: "👤",
};

// ── Emotion short codes → emoji ─────────────────────────────────────────────

export const EMOTION_EMOJI: Record<string, string> = {
  joy: "😊",
  pride: "🦁",
  frust: "😤",
  sad: "😢",
  anxious: "😰",
  convict: "🔥",
  love: "❤️",
  boredom: "🥱",
  curiosity: "🔍",
  surprise: "😲",
  anger: "😡",
  fear: "😨",
  disgust: "🤢",
  trust: "🤝",
  anticipation: "⏳",
  gratitude: "🙏",
  nostalgia: "🕰️",
  relief: "😮‍💨",
  excitement: "🎉",
  confusion: "😕",
  determination: "💪",
  amusement: "😄",
  empathy: "🫂",
  loneliness: "🌑",
  hope: "🌅",
};

// ── Confidence → visual marker ──────────────────────────────────────────────

export function confidenceMarker(confidence: number): string {
  return String(confidence);
}
