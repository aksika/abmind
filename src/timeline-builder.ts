/**
 * timeline-builder.ts — Group related memories into narrative timelines.
 * Pure TypeScript, no LLM. Renders timelines on the fly from stored English.
 * Reuses buildArc() for emotional trajectory.
 */

import { buildArc, type EmotionArc } from "./emotion-arc.js";
import { renderMemory } from "./memory-renderer.js";
import { localMonth } from "./local-time.js";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TimelineMemory {
  id: number;
  content_en: string;
  topic: string;
  memory_type: string | null;
  emotion_tags: string | null;
  importance_flags: string | null;
  confidence: number | null;
  created_at: number;
  emotion_context: string | null;
}

export interface Timeline {
  topic: string;
  entity: string;
  entries: TimelineMemory[];
  arc: EmotionArc;
  current: TimelineMemory;
}

export interface RenderedTimeline {
  topic: string;
  entity: string;
  rendered: string;
  memoryIds: number[];
}

// ── Entity extraction ───────────────────────────────────────────────────────

/** Extract the primary entity from a memory's content (first @reference or first capitalized proper noun). */
function primaryEntity(content: string): string {
  const atRef = content.match(/@([\w-]+)/);
  if (atRef) return atRef[1]!;
  const proper = content.match(/\b([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)\b/);
  if (proper) return proper[1]!.toLowerCase();
  return "_";
}

// ── Timeline building ───────────────────────────────────────────────────────

/** Group memories by topic + primary entity, build timelines for groups with 2+ entries. */
export function buildTimelines(memories: ReadonlyArray<TimelineMemory>): Timeline[] {
  const groups = new Map<string, TimelineMemory[]>();

  for (const m of memories) {
    const entity = primaryEntity(m.content_en);
    const key = `${m.topic}:${entity}`;
    const group = groups.get(key);
    if (group) group.push(m);
    else groups.set(key, [m]);
  }

  const timelines: Timeline[] = [];
  for (const [key, mems] of groups) {
    if (mems.length < 2) continue;
    const sorted = mems.sort((a, b) => a.created_at - b.created_at);
    const [topic, entity] = key.split(":");
    timelines.push({
      topic: topic!,
      entity: entity!,
      entries: sorted,
      arc: buildArc(sorted.map(m => ({ emotion_tags: m.emotion_tags ?? "", created_at: m.created_at }))),
      current: sorted[sorted.length - 1]!,
    });
  }

  return timelines.sort((a, b) => b.entries.length - a.entries.length);
}

/** Build cross-topic timelines: follow an entity across topic boundaries. */
export function buildCrossTopicTimelines(memories: ReadonlyArray<TimelineMemory>): Timeline[] {
  // Group by entity only (across all topics)
  const entityGroups = new Map<string, TimelineMemory[]>();
  for (const m of memories) {
    const entity = primaryEntity(m.content_en);
    if (entity === "_") continue;
    const group = entityGroups.get(entity);
    if (group) group.push(m);
    else entityGroups.set(entity, [m]);
  }

  const timelines: Timeline[] = [];
  for (const [entity, mems] of entityGroups) {
    // Only build cross-topic if entity spans 2+ topics
    const topics = new Set(mems.map(m => m.topic));
    if (topics.size < 2 || mems.length < 3) continue;
    const sorted = mems.sort((a, b) => a.created_at - b.created_at);
    timelines.push({
      topic: [...topics].join("+"),
      entity,
      entries: sorted,
      arc: buildArc(sorted.map(m => ({ emotion_tags: m.emotion_tags ?? "", created_at: m.created_at }))),
      current: sorted[sorted.length - 1]!,
    });
  }

  return timelines.sort((a, b) => b.entries.length - a.entries.length);
}

/** Render a cross-topic timeline entry with topic prefixes. */
function renderCrossTransition(m: TimelineMemory): string {
  const date = new Date(m.created_at);
  const month = date.toLocaleString("en", { month: "short" });
  const abml = renderMemory({
    content_en: m.content_en, topic: m.topic,
    emotion_tags: m.emotion_tags ?? undefined, importance_flags: m.importance_flags ?? undefined,
    memory_type: m.memory_type ?? undefined, confidence: m.confidence ?? undefined,
    createdAt: m.created_at,
  });
  const body = abml.replace(/^\[[^\]]*\]\s*/, "").replace(/^\([^)]*\)\s*/, "").slice(0, 35).trim();
  return `${m.topic}:${body}(${month})`;
}

/** Render a cross-topic timeline. */
export function renderCrossTopicTimeline(tl: Timeline): RenderedTimeline {
  const transitions = tl.entries.map(renderCrossTransition).join("→");
  const arcStr = tl.arc.tags.length > 0 ? tl.arc.tags.slice(0, 4).join("→") : "—";
  const line1 = `[XTL|${tl.entity}] ${transitions}`;
  const line2 = `  arc: ${arcStr} ${tl.arc.symbol} | topics: ${tl.topic}`;
  return {
    topic: tl.topic,
    entity: tl.entity,
    rendered: `${line1}\n${line2}`,
    memoryIds: tl.entries.map(e => e.id),
  };
}

// ── Timeline rendering ──────────────────────────────────────────────────────

/** Render a single timeline entry as a short transition phrase. */
function renderTransition(m: TimelineMemory): string {
  const date = new Date(m.created_at);
  const month = date.toLocaleString("en", { month: "short" });
  const ctx = m.emotion_context ? `,${m.emotion_context}` : "";
  // Compress to a short phrase: take first 40 chars of compressed content body
  const abml = renderMemory({
    content_en: m.content_en, topic: m.topic,
    emotion_tags: m.emotion_tags ?? undefined, importance_flags: m.importance_flags ?? undefined,
    memory_type: m.memory_type ?? undefined, confidence: m.confidence ?? undefined,
    createdAt: m.created_at,
  });
  // Extract just the body (after the prefix)
  const body = abml.replace(/^\[[^\]]*\]\s*/, "").replace(/^\([^)]*\)\s*/, "").slice(0, 40).trim();
  return `${body}(${month}${ctx})`;
}

/** Render a timeline to the L2 format. */
export function renderTimeline(tl: Timeline): RenderedTimeline {
  const transitions = tl.entries.map(renderTransition).join("→");
  const arcStr = tl.arc.tags.length > 0 ? tl.arc.tags.slice(0, 4).join("→") : "—";
  const line1 = `[TL|${tl.topic}|${tl.entity}] ${transitions}`;
  const line2 = `  arc: ${arcStr} ${tl.arc.symbol} | current: ${renderTransition(tl.current)}`;
  return {
    topic: tl.topic,
    entity: tl.entity,
    rendered: `${line1}\n${line2}`,
    memoryIds: tl.entries.map(e => e.id),
  };
}

/** Render all timelines for a set of memories. Returns rendered timelines + IDs of memories consumed by timelines. */
export function renderTimelines(memories: ReadonlyArray<TimelineMemory>): { timelines: RenderedTimeline[]; crossTopic: RenderedTimeline[]; consumedIds: Set<number> } {
  const tls = buildTimelines(memories);
  const rendered = tls.map(renderTimeline);
  const crossTls = buildCrossTopicTimelines(memories);
  const crossRendered = crossTls.map(renderCrossTopicTimeline);
  const consumedIds = new Set<number>();
  for (const r of [...rendered, ...crossRendered]) for (const id of r.memoryIds) consumedIds.add(id);
  return { timelines: rendered, crossTopic: crossRendered, consumedIds };
}
