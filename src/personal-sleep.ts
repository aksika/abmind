/**
 * personal-sleep.ts — Dreamy grouping + selective durable promotion seam
 * (#1930 M2).
 *
 * Dreamy's grouping and learning run through the existing host-supplied
 * sleep runtime. Abmind owns deterministic validation, writes, settlement
 * and retention. No generative or judgment model enters here.
 *
 * Grouping preserves conversation, execution and principal boundaries and
 * chronology, including topic switches and later returns. Durable promotion
 * is selective and keeps user statements, confirmed decisions, agent
 * proposals and inferences distinguishable. Sufficient scoped excerpts and
 * metadata are preserved before raw pruning.
 */

import type Database from "better-sqlite3";
import { groupExchangesByTopic } from "./personal-episodes.js";
import type { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";
import { isPersonalReady } from "./personal-schema.js";

export type SleepExchangeDescriptor = {
  userMessageId: number;
  userTs: number;
  sessionId: string;
  topicHint?: string;
  responseMessageIds: number[];
};

function excerptFor(db: Database.Database, messageId: number): { excerpt: string; classification: number } | null {
  try {
    const row = db.prepare("SELECT content FROM messages WHERE id = ?").get(messageId) as
      | { content: string }
      | undefined;
    if (!row) return null;
    // Sealed exact values never enter plaintext excerpts: messages are raw
    // evidence, and class-3 exact values live only in sealed durable rows.
    // Excerpts here are bounded source quotes for grounding, not secrets.
    return { excerpt: row.content.slice(0, 500), classification: 1 };
  } catch {
    return null;
  }
}

/**
 * Group settled exchanges into episodes through the single writer.
 * Idempotent: replay of accepted grouping returns existing episodes.
 */
export function groupSleepExchanges(
  db: Database.Database,
  store: PrivateMemoryMutationStore,
  owner: string,
  exchanges: SleepExchangeDescriptor[],
  actorId: string,
): Array<{ episodeId: number; replayed: boolean }> {
  if (!isPersonalReady(db)) throw new Error("personal learning refused: dataset not ready");
  const groups = groupExchangesByTopic(
    exchanges.map((e) => ({ userMessageId: e.userMessageId, userTs: e.userTs, sessionId: e.sessionId, topicHint: e.topicHint })),
  );
  const results: Array<{ episodeId: number; replayed: boolean }> = [];
  // Link returns to the same topic: track last episode per topic.
  const lastByTopic = new Map<string, number>();
  try {
    const existing = db.prepare("SELECT id, topic FROM short_term_memories WHERE user_id = ? ORDER BY start_ts ASC").all(owner) as Array<{
      id: number;
      topic: string;
    }>;
    for (const e of existing) lastByTopic.set(e.topic, e.id);
  } catch { /* ignore */ }
  for (const g of groups) {
    const sourceIds: number[] = [];
    for (const mid of g.sourceMessageIds) {
      const desc = exchanges.find((e) => e.userMessageId === mid);
      if (desc) sourceIds.push(desc.userMessageId, ...desc.responseMessageIds);
      else sourceIds.push(mid);
    }
    const evidence: Array<{ messageId: number; excerpt: string; classification: number }> = [];
    for (const mid of sourceIds) {
      const ex = excerptFor(db, mid);
      if (ex) evidence.push({ messageId: mid, excerpt: ex.excerpt, classification: ex.classification });
    }
    if (evidence.length === 0) continue;
    // Session ids for the group.
    const sessionIds = [...new Set(exchanges.filter((e) => g.sourceMessageIds.includes(e.userMessageId)).map((e) => e.sessionId))];
    const prev = lastByTopic.get(g.topic) ?? null;
    const created = store.createPersonalEpisode({
      userId: owner,
      topic: g.topic,
      startTs: g.startTs,
      endTs: g.endTs,
      sessionIds,
      sourceMessageIds: sourceIds,
      evidenceExcerpts: evidence,
      prevEpisodeId: prev,
      actorId,
    });
    results.push({ episodeId: created.id, replayed: created.replayed });
    if (!created.replayed) lastByTopic.set(g.topic, created.id);
  }
  return results;
}

export type DurableProposal = {
  memoryType: string;
  content: string;
  authority: "user_statement" | "confirmed_decision" | "agent_proposal" | "inference";
  authorityBasis: string;
  applicabilityScope?: Record<string, unknown>;
  evidence: Array<{ kind: string; ref: string; excerpt: string; classification: number }>;
  classification?: number;
};

/**
 * Selective durable promotion from one episode. Keeps authority classes
 * distinguishable; a discussion never becomes an approved fact, and ordinary
 * proposals are not authority to approve an agent suggestion as a user
 * decision. Zero durable memories is valid when processing explicitly
 * determined none should be learned (caller passes empty proposals with
 * an explicit disposition).
 */
export function promoteEpisode(
  db: Database.Database,
  store: PrivateMemoryMutationStore,
  owner: string,
  episodeId: number,
  proposals: DurableProposal[],
  actorId: string,
  opts?: { explicitNoLearn?: boolean },
): Array<{ durableId: number }> {
  if (!isPersonalReady(db)) throw new Error("personal learning refused: dataset not ready");
  const episode = db.prepare("SELECT id, user_id FROM short_term_memories WHERE id = ? AND user_id = ?").get(episodeId, owner) as
    | { id: number }
    | undefined;
  if (!episode) throw new Error("episode not found or not owned");
  if (proposals.length === 0) {
    if (!opts?.explicitNoLearn) throw new Error("empty promotion requires explicitNoLearn disposition");
    return [];
  }
  const results: Array<{ durableId: number }> = [];
  for (const p of proposals) {
    // Authority guard: agent text, summaries or model claims cannot supply
    // user authority. User classes require user evidence.
    if ((p.authority === "user_statement" || p.authority === "confirmed_decision") && !p.evidence.some((e) => e.kind === "user_message" || e.kind === "user_confirmation")) {
      throw new Error("user authority requires user evidence");
    }
    // Agent proposals never become approved decisions through consolidation.
    if (p.authority === "confirmed_decision" && p.authorityBasis.includes("agent proposal")) {
      throw new Error("agent proposal cannot be promoted to confirmed decision");
    }
    const stored = store.storePersonalDurable({
      userId: owner,
      memoryType: p.memoryType,
      content: p.content,
      authority: p.authority,
      authorityBasis: p.authorityBasis,
      applicabilityScope: p.applicabilityScope,
      provenance: { episodeId, actor: actorId },
      evidence: p.evidence,
      classification: p.classification,
      actorId,
    });
    results.push({ durableId: stored.id });
  }
  return results;
}
