/**
 * turn-classifier.ts — Heuristic classifier for conversation turns.
 *
 * Runs at turn write time. Derives type/topic/emotion hints for later
 * middle-tier rendering (#348). Pure function, no LLM, no I/O.
 *
 * Hint values are nullable on the messages row — missing hints mean
 * "classifier hadn't run for this turn" (historical messages, or
 * classifier disabled). Renderer falls back to defaults.
 */

export interface TurnHints {
  typeHint: string | null;
  topicHint: string | null;
  emotionHint: string | null;
}

// Memory-type single-letter codes (matches memory-renderer v1 TYPE_CODE)
const TYPE_FACT = "F";
const TYPE_DECISION = "D";
const TYPE_PREFERENCE = "P";
const TYPE_LESSON = "L";
const TYPE_EVENT = "E";
const TYPE_TECHNICAL = "T";
const TYPE_QUESTION = "Q";
const TYPE_OBSERVATION = "O";

// Topic vocabulary — keep in sync with memory extraction topics
const TOPIC_VOCAB = [
  "coding", "personal", "memory", "security", "relationships",
  "money", "finance", "health", "work", "family", "travel",
  "food", "music", "sports", "politics", "general",
] as const;

// Emotion vocabulary — short codes (6 chars max)
const EMOTION_VOCAB: Record<string, string> = {
  // joy / positive
  happy: "joy", joy: "joy", great: "joy", awesome: "joy", excellent: "joy",
  love: "love", loving: "love",
  // sad / negative
  sad: "sad", unhappy: "sad", depressed: "sad",
  angry: "anger", furious: "anger", rage: "anger", mad: "anger",
  frustrated: "frust", frustrating: "frust", annoyed: "frust", annoying: "frust",
  anxious: "anx", worried: "anx", anxiety: "anx", stressed: "anx",
  afraid: "fear", fear: "fear", scared: "fear", terrified: "fear",
  // cognitive
  confused: "doubt", doubt: "doubt", uncertain: "doubt", unsure: "doubt",
  convinced: "convict", certain: "convict", sure: "convict",
  // personal
  tired: "exhaust", exhausted: "exhaust", drained: "exhaust",
  excited: "joy", thrilled: "joy",
  grief: "grief", mourning: "grief", lost: "grief",
  hope: "hope", hopeful: "hope",
  proud: "pride", proudly: "pride",
};

// Decision markers (verbs/phrases that indicate a choice or commitment)
const DECISION_MARKERS = [
  /\b(decided|decide|chose|choosing|chosen|will go with|going with|let'?s (go|do|use))\b/i,
  /\b(i'?ll|we'?ll) (use|go|do|try|take)\b/i,
  /\b(plan to|gonna|going to)\b/i,
];

// Preference markers
const PREFERENCE_MARKERS = [
  /\bi (prefer|like|love|hate|dislike|enjoy|avoid|always|never|usually|rarely)\b/i,
  /\bmy (favorite|preference)\b/i,
];

// Lesson markers (realization, learning, "issue again")
const LESSON_MARKERS = [
  /\b(learned|realized|turns out|issue again|keep getting|keeps happening|again\b.*broke)\b/i,
  /\b(note to self|remember to|lesson|takeaway)\b/i,
];

// Technical markers (code, file paths, commands)
const TECHNICAL_MARKERS = [
  /```/,                                   // code block
  /\/[\w-]+\/[\w.-]+/,                     // path-like
  /\b[A-Z]{2,}\d*\b.*\b(error|bug|fix|issue)\b/i, // ERROR_CODE bug
  /\b(npm|git|curl|sql|fts5?|api|regex)\b/i,
  /\.\w{2,4}\b.*\b(file|module|script)\b/i,
];

// Event markers (happened, deadline, date)
const EVENT_MARKERS = [
  /\b(happened|scheduled|deadline|tomorrow|yesterday|last week|next week)\b/i,
  /\bon (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
];

// Question interrogatives
const INTERROGATIVES = /\b(what|how|why|when|where|who|which|can you|could you|would you|should i)\b/i;

/**
 * Classify a single conversation turn. Pure function.
 *
 * @param role "user" or "assistant"
 * @param content Raw message text
 * @returns Hints (nullable — returns null when no rule matches)
 */
export function classifyTurn(role: string, content: string): TurnHints {
  const roleLC = role.toLowerCase();
  const text = content;

  return {
    typeHint: classifyType(roleLC, text),
    topicHint: classifyTopic(text),
    emotionHint: classifyEmotion(text),
  };
}

function classifyType(role: string, text: string): string {
  // Question: ends with ? AND has interrogative word (not just rhetorical)
  if (text.trimEnd().endsWith("?") && INTERROGATIVES.test(text)) {
    return TYPE_QUESTION;
  }

  // Lesson / realization — explicit markers are strong signal, check BEFORE technical
  // (e.g. "Note to self: always back up first" is a lesson, not technical)
  for (const re of LESSON_MARKERS) {
    if (re.test(text)) return TYPE_LESSON;
  }

  // Technical: code blocks, commands, paths
  for (const re of TECHNICAL_MARKERS) {
    if (re.test(text)) return TYPE_TECHNICAL;
  }

  // Decision markers
  for (const re of DECISION_MARKERS) {
    if (re.test(text)) return TYPE_DECISION;
  }

  // Preference (user-only; assistant wouldn't normally state user preferences this way)
  if (role === "user") {
    for (const re of PREFERENCE_MARKERS) {
      if (re.test(text)) return TYPE_PREFERENCE;
    }
  }

  // Event
  for (const re of EVENT_MARKERS) {
    if (re.test(text)) return TYPE_EVENT;
  }

  // Defaults: assistant → fact, user → observation
  return role === "assistant" ? TYPE_FACT : TYPE_OBSERVATION;
}

function classifyTopic(text: string): string | null {
  // Simple vocab match — lowercase text, check each known topic keyword
  const lower = text.toLowerCase();

  // Coding indicators (broader than just "coding" word)
  if (/\b(code|bug|fix|api|sql|regex|npm|git|function|variable|typescript|javascript|python|rust|database)\b/.test(lower)) {
    return "coding";
  }
  // Money / finance
  if (/\b(money|salary|price|pricing|cost|budget|expense|invoice|tax|revenue)\b/.test(lower)) {
    return "finance";
  }
  // Health
  if (/\b(health|doctor|sick|illness|medication|exercise|sleep|tired)\b/.test(lower)) {
    return "health";
  }
  // Security
  if (/\b(password|security|auth|encryption|vulnerability|breach|token)\b/.test(lower)) {
    return "security";
  }
  // Personal (family, relationships, feelings)
  if (/\b(family|mom|dad|wife|husband|kid|friend|date|relationship)\b/.test(lower)) {
    return "personal";
  }
  // Memory (meta)
  if (/\b(memory|memories|remember|forget|recall|forgot)\b/.test(lower)) {
    return "memory";
  }
  // Work
  if (/\b(work|meeting|project|deadline|colleague|boss|office)\b/.test(lower)) {
    return "work";
  }

  return null; // renderer will use "general"
}

function classifyEmotion(text: string): string | null {
  const lower = text.toLowerCase();
  // Word-boundary match against vocabulary
  const words = lower.match(/\b\w+\b/g) ?? [];
  for (const word of words) {
    const emo = EMOTION_VOCAB[word];
    if (emo) return emo;
  }
  return null;
}

/** Full type name from single-letter code. Used by renderer. */
export function typeCodeToFull(code: string | null | undefined): string {
  if (!code) return "fact";
  const map: Record<string, string> = {
    F: "fact", D: "decision", P: "preference", E: "event",
    L: "lesson", T: "technical", Q: "question", O: "observation",
  };
  return map[code] ?? "fact";
}

/** Export topic vocabulary for tests / validation. */
export { TOPIC_VOCAB };
