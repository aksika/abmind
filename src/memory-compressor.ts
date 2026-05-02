import { localMonth } from "./local-time.js";
/**
 * memory-compressor.ts — ABM-L compression v2.
 * Converts English memory text + metadata into compact ABM-L format.
 * Pure function, ~1-5ms per call.
 */

import type { ImportanceFlag } from "./importance-flagger.js";

/** Memory type → primary flag character. */
const TYPE_FLAG: Record<string, string> = {
  fact: "F", decision: "D", preference: "P", event: "E",
  lesson: "L", feedback: "K", story: "S",
};

/** Detected importance flag → secondary flag character. */
const DETECTED_FLAG: Record<ImportanceFlag, string> = {
  decision: "D", origin: "O", core_belief: "B", pivot: "V",
  technical: "T", correction: "C", preference: "P", milestone: "M",
};

/**
 * Filler words to strip. Excludes:
 * - Negations (don't, not, never, no, won't, can't, haven't, shouldn't, isn't, aren't, wasn't, weren't)
 * - Pronouns (I, my, me, you, your, we, our, they, their)
 */
const FILLER = /\b(basically|essentially|actually|really|very|just|quite|rather|simply|that|this|these|those|its|also|so|then|well|some|about|there)\b/gi;
const MULTI_SPACE = /\s{2,}/g;

/** Platform/term abbreviations. */
const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bTelegram\b/g, "TG"],
  [/\bDiscord\b/g, "DC"],
  [/\bOpenRouter\b/g, "OR"],
  [/\bauthentication\b/gi, "auth"],
  [/\bconfiguration\b/gi, "config"],
  [/\bdevelopment\b/gi, "dev"],
  [/\bdeveloper experience\b/gi, "DX"],
  [/\bGoogle Drive\b/g, "GDrive"],
];

/** Topic inference from content keywords. */
const TOPIC_HINTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(code|deploy|api|database|server|framework|stack|pipeline|git|npm|typescript|sqlite|fts5|bug|error|crash|architecture|refactor)\b/i, "coding"],
  [/\b(prefer|language|timezone|CET|bilingual|dark.?mode|vim|style|personality|sarcastic|humor)\b/i, "personal"],
  [/\b(cron|schedule|task|backup|report|daily|weekly|heartbeat|deploy\.sh)\b/i, "work"],
  [/\b(price|pricing|cost|budget|subscription|billing|invoice|money)\b/i, "finance"],
  [/\b(health|sleep|exercise|stress|burnout|tired)\b/i, "health"],
  [/\b(project|ship|launch|release|milestone|roadmap)\b/i, "projects"],
];

/** Known entity whitelist — only these get @referenced. */

/** Set known entities from core-tier memories. Called before compression. */
let knownEntities: Map<string, string> = new Map();
export function setKnownEntities(entities: Map<string, string>): void {
  knownEntities = entities;
}

function applyEntities(text: string): string {
  let result = text;
  // Apply known entities (longest first)
  const sorted = [...knownEntities.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [name, ref] of sorted) {
    result = result.replace(new RegExp(`\\b${name}\\b`, "gi"), ref);
  }
  return result;
}

function applyAbbreviations(text: string): string {
  let result = text;
  for (const [pattern, replacement] of ABBREVIATIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function applyRelationships(text: string): string {
  return text
    .replace(/\binstead of\b/gi, ">over")
    .replace(/\breplaces?\b/gi, ">replaces")
    .replace(/\bcauses?\b/gi, ">causes")
    .replace(/\bblocks?\b/gi, ">blocks")
    .replace(/\bleads? to\b/gi, "→")
    .replace(/\bbecomes?\b/gi, "→")
    .replace(/\bbecause\b/gi, "∵");
}

function stripFiller(text: string): string {
  return text.replace(FILLER, "").replace(MULTI_SPACE, " ").trim();
}

function preserveTechnical(text: string): { preserved: Map<string, string>; cleaned: string } {
  const preserved = new Map<string, string>();
  let idx = 0;
  const cleaned = text.replace(/(?:\/[\w./-]+|~\/[\w./-]+|https?:\/\/\S+|`[^`]+`|\b\d+\.\d+\.\d+\b|-\d{4,})/g, (match) => {
    const key = `__TECH${idx++}__`;
    preserved.set(key, match);
    return key;
  });
  return { preserved, cleaned };
}

function restoreTechnical(text: string, preserved: Map<string, string>): string {
  let result = text;
  for (const [key, value] of preserved) {
    result = result.replace(key, value);
  }
  return result;
}

/** Infer topic from content when topic is 'general'. */
function inferTopic(content: string, currentTopic: string): string {
  if (currentTopic !== "general") return currentTopic;
  for (const [pattern, topic] of TOPIC_HINTS) {
    if (pattern.test(content)) return topic;
  }
  return "general";
}

/** Convert numbered/bulleted lists to pipe-separated. */
function pipeifyLists(text: string): string {
  // "1) foo. 2) bar. 3) baz" → "foo | bar | baz"
  return text
    .replace(/\d+\)\s*/g, "")
    .replace(/\s*\.\s*(?=\S)/g, " | ")
    .replace(/\s*;\s*/g, " | ")
    .replace(/\s*,\s*(?=\d{1,2}[:.])/g, " | "); // comma before times: "10:00, 10:15" → "10:00 | 10:15"
}

export interface CompressInput {
  content_en: string;
  topic: string;
  emotion_tags: string;
  importance_flags: string;
  memory_type?: string;
  confidence?: number;
  date?: string;
}

/**
 * Compress a memory into ABM-L format.
 * Primary flag from memory_type. Secondary flags from detection (additive).
 * No truncation — wake-up builder handles length.
 */
export function compress(input: CompressInput): string {
  const { content_en, emotion_tags, importance_flags, confidence, date } = input;

  // Infer topic
  const topic = inferTopic(content_en, input.topic);

  // Build prefix: primary flag from memory_type, secondary from detection
  const primaryFlag = TYPE_FLAG[input.memory_type ?? "fact"] ?? "F";
  const secondaryFlags = importance_flags
    .split(",").filter(Boolean)
    .map(f => DETECTED_FLAG[f.trim() as ImportanceFlag] ?? "")
    .filter(f => f && f !== primaryFlag) // don't duplicate primary
    .join("");
  const flags = primaryFlag + secondaryFlags;

  const emotionShort = emotion_tags.split(",")[0]?.trim().slice(0, 6) || "—";
  const conf = confidence ?? 3;
  const dateStr = date ?? localMonth();
  const prefix = `[${flags}|${topic}|${emotionShort}|${conf}|${dateStr}]`;

  // Compress content
  const { preserved, cleaned } = preserveTechnical(content_en);

  let body = cleaned;
  body = applyEntities(body);
  body = applyAbbreviations(body);
  body = applyRelationships(body);
  body = pipeifyLists(body);
  body = stripFiller(body);
  body = restoreTechnical(body, preserved);

  // Collapse parenthetical reasons
  body = body.replace(/\s*∵\s*(.{3,60}?)(?:\.|$)/g, " ($1)");

  // Clean up
  body = body.replace(MULTI_SPACE, " ").replace(/\s+([.,;:!?])/g, "$1").trim();

  // No truncation — stored ABM-L captures everything

  return `${prefix} ${body}`;
}
