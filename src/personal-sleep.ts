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
import { createHash } from "node:crypto";
import { groupExchangesByTopic } from "./personal-episodes.js";
import type { PrivateMemoryMutationStore } from "./private-memory-mutation-store.js";
import { isPersonalReady, getPersonalState } from "./personal-schema.js";
import { classifyTurn } from "./turn-classifier.js";
import { writeReceipts } from "./sleep/receipts.js";
import { CONSUMED_SESSION_SQL } from "./sleep/coverage.js";

export type SleepExchangeDescriptor = {
  userMessageId: number;
  userTs: number;
  sessionId: string;
  topicHint?: string;
  responseMessageIds: number[];
};

function excerptFor(db: Database.Database, owner: string, messageId: number): { excerpt: string; classification: number } | null {
  try {
    const row = db.prepare("SELECT content FROM messages WHERE id = ? AND user_id = ?").get(messageId, owner) as
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
      const ex = excerptFor(db, owner, mid);
      if (ex) evidence.push({ messageId: mid, excerpt: ex.excerpt, classification: ex.classification });
    }
    if (evidence.length === 0) continue;
    // Session ids for the group.
    const sessionIds = [...new Set(exchanges.filter((e) => g.sourceMessageIds.includes(e.userMessageId)).map((e) => e.sessionId))];
    const prev = lastByTopic.get(g.topic) ?? null;
    const endTs = (db.prepare(`SELECT MAX(timestamp) AS ts FROM messages WHERE user_id = ? AND id IN (${sourceIds.map(() => "?").join(",")})`).get(owner, ...sourceIds) as { ts: number }).ts;
    const created = store.createPersonalEpisode({
      userId: owner,
      topic: g.topic,
      startTs: g.startTs,
      endTs: Math.max(g.endTs, endTs),
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
  const episode = db.prepare("SELECT id, source_message_ids FROM short_term_memories WHERE id = ? AND user_id = ?").get(episodeId, owner) as
    | { id: number; source_message_ids: string }
    | undefined;
  if (!episode) throw new Error("episode not found or not owned");
  if (proposals.length === 0) {
    if (!opts?.explicitNoLearn) throw new Error("empty promotion requires explicitNoLearn disposition");
    return [];
  }
  const sourceIds: unknown = JSON.parse(episode.source_message_ids);
  if (!Array.isArray(sourceIds)) throw new Error("invalid episode source evidence");
  return db.transaction(() => {
    const results: Array<{ durableId: number }> = [];
    for (const p of proposals) {
      if (p.evidence.some(e => !sourceIds.includes(Number(/^(?:messages:)?([1-9]\d*)$/.exec(e.ref)?.[1])))) throw new Error("promotion evidence must belong to its episode");
      // Authority guard: agent text, summaries or model claims cannot supply
      // user authority. User classes require user evidence.
      if ((p.authority === "user_statement" || p.authority === "confirmed_decision") && !p.evidence.some((e) => e.kind === "user_message" || e.kind === "user_confirmation")) {
        throw new Error("user authority requires user evidence");
      }
      // Agent proposals never become approved decisions through consolidation.
      if (p.authority === "confirmed_decision" && p.authorityBasis.includes("agent proposal")) {
        throw new Error("agent proposal cannot be promoted to confirmed decision");
      }
      // Idempotent replay: the same episode content promotes once. Exact
      // json_extract (not LIKE) so episode 5 never matches episode 51.
      const existing = db.prepare(
        "SELECT id FROM long_term_memories WHERE user_id = ? AND content = ? AND json_valid(provenance) AND json_extract(provenance, '$.episodeId') = ? LIMIT 1",
      ).get(owner, p.content.trim(), episodeId) as { id: number } | undefined;
      if (existing) {
        results.push({ durableId: existing.id });
        continue;
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
  })();
}

/**
 * Settle one sleep run's Dreamy proposals through the single new-model
 * writer (M2 production seam).
 *
 * Loads the settled messages in (watermarkTs, coveredThroughTs], builds
 * complete exchanges (one user turn plus its same-session assistant
 * responses; unfinished turns are excluded and retained), classifies each
 * user turn's topic deterministically, groups into episodes, then promotes
 * each episode from the run's Dreamy proposals with evidence-matched
 * authority. Every proposal and every no-learn episode leaves a durable
 * receipt, so settlement can prove an explicit disposition before any
 * pruning. Failures throw and the caller must not advance the watermark.
 *
 * Authority rule (no fabrication): a proposal becomes `user_statement` only
 * when its whole text is a verbatim quote of a user message from its
 * episode; everything else promotes as `inference`. `confirmed_decision`
 * never comes out of Dreamy consolidation — approval needs the owner
 * correction path. Evidence excerpts are always real source quotes, never
 * model text.
 *
 * Session/execution identity is the message sessionId (the messages schema
 * carries no separate execution id); topic switches and later returns start
 * new episodes via groupExchangesByTopic.
 */
export function settleSleepProposals(
  db: Database.Database,
  store: PrivateMemoryMutationStore,
  opts: {
    owner: string;
    actorId: string;
    memoryDir: string;
    runId: string;
    step: string;
    watermarkTs: number;
    coveredThroughTs: number;
    proposals: Array<{ memoryType: string; content: string; contentOriginal?: string }>;
  },
): { episodes: Array<{ episodeId: number; replayed: boolean }>; promoted: number; declined: number } {
  if (!isPersonalReady(db)) {
    const state = getPersonalState(db);
    throw new Error(`personal learning refused: dataset is ${state?.state ?? "unknown"} (${state?.reason ?? "conversion required"})`);
  }
  if (opts.coveredThroughTs <= opts.watermarkTs) throw new Error("settle requires a non-empty covered range");
  const rows = db.prepare(
    `SELECT id, session_id, role, content, timestamp FROM messages
     WHERE user_id = ? AND timestamp > ? AND timestamp <= ?
       AND ${CONSUMED_SESSION_SQL} AND content NOT LIKE '[SYSTEM%'
     ORDER BY timestamp ASC, id ASC`,
  ).all(opts.owner, opts.watermarkTs, opts.coveredThroughTs) as Array<{
    id: number; session_id: string; role: string; content: string; timestamp: number;
  }>;
  // Build complete exchanges; unfinished turns stay out and stay retained.
  const descriptors: SleepExchangeDescriptor[] = [];
  let open: { userMessageId: number; userTs: number; sessionId: string; topicHint?: string; responseMessageIds: number[] } | null = null;
  const flushOpen = (): void => {
    if (open && open.responseMessageIds.length > 0) descriptors.push({ ...open });
    open = null;
  };
  for (const row of rows) {
    if (row.role === "user") {
      flushOpen();
      open = {
        userMessageId: row.id,
        userTs: row.timestamp,
        sessionId: row.session_id,
        topicHint: classifyTurn(row.role, row.content).topicHint ?? undefined,
        responseMessageIds: [],
      };
    } else if (row.role === "assistant" || row.role === "compaction") {
      if (open && open.sessionId === row.session_id) open.responseMessageIds.push(row.id);
    }
  }
  flushOpen();
  // Crash-retry idempotency (C2): turns already bound to an accepted episode
  // are settled and must not be regrouped — skipping them keeps the retry
  // able to settle new exchanges instead of throwing on overlap forever.
  const boundUserTurns = new Set<number>();
  try {
    const bound = db.prepare(
      "SELECT source_message_ids FROM short_term_memories WHERE user_id = ? AND json_valid(source_message_ids)",
    ).all(opts.owner) as Array<{ source_message_ids: string }>;
    for (const row of bound) {
      const ids: unknown = JSON.parse(row.source_message_ids);
      if (!Array.isArray(ids)) continue;
      for (const id of ids) if (typeof id === "number") boundUserTurns.add(id);
    }
  } catch { /* episodes may predate structural migration in tests */ }
  const newDescriptors = descriptors.filter((d) => !boundUserTurns.has(d.userMessageId));
  if (newDescriptors.length === 0) {
    writeReceipts(opts.memoryDir, [{
      runId: opts.runId, step: opts.step, principal: opts.owner,
      opId: `${opts.runId}/${opts.step}/already-settled`, op: "no-learn",
      disposition: "declined", reason: "every exchange in range is already settled",
      at: Date.now(),
    }]);
    return { episodes: [], promoted: 0, declined: 1 };
  }
  if (descriptors.length === 0) {
    writeReceipts(opts.memoryDir, [{
      runId: opts.runId, step: opts.step, principal: opts.owner,
      opId: `${opts.runId}/${opts.step}/no-exchanges`, op: "no-learn",
      disposition: "declined", reason: "no complete exchanges in covered range",
      at: Date.now(),
    }]);
    return { episodes: [], promoted: 0, declined: 1 };
  }
  const episodes = groupSleepExchanges(db, store, opts.owner, newDescriptors, opts.actorId);
  // Index episode excerpts for verbatim matching: normalized quote -> source.
  // Role comes from the live message when present, else the persisted excerpt
  // role; an unresolvable role is never treated as the user (no fabricated
  // user authority after pruning).
  const quoteIndex: Array<{ episodeId: number; messageId: number; role: string; quote: string; classification: number }> = [];
  for (const ep of episodes) {
    const row = db.prepare("SELECT evidence_excerpts FROM short_term_memories WHERE id = ? AND user_id = ?").get(ep.episodeId, opts.owner) as
      | { evidence_excerpts: string } | undefined;
    if (!row) continue;
    const entries = JSON.parse(row.evidence_excerpts) as Array<{ messageId: number; excerpt: string; classification: number; role?: string }>;
    for (const entry of entries) {
      const source = db.prepare("SELECT role FROM messages WHERE id = ? AND user_id = ?").get(entry.messageId, opts.owner) as
        | { role: string } | undefined;
      quoteIndex.push({
        episodeId: ep.episodeId,
        messageId: entry.messageId,
        role: source?.role ?? (typeof entry.role === "string" ? entry.role : "assistant"),
        quote: entry.excerpt,
        classification: entry.classification,
      });
    }
  }
  const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");
  const MIN_QUOTE = 20;
  const QUOTE_WINDOW = 80;
  // Best verbatim support for one proposal: the longest episode-source span
  // (at least MIN_QUOTE chars) appearing verbatim in the proposal text.
  // fullQuote is true when the whole proposal is a verbatim source quote.
  const bestSupport = (
    text: string,
  ): { episodeId: number; messageId: number; role: string; quote: string; classification: number; fullQuote: boolean } | null => {
    const needle = norm(text);
    let best: { episodeId: number; messageId: number; role: string; quote: string; classification: number; fullQuote: boolean } | null = null;
    for (const q of quoteIndex) {
      const hay = norm(q.quote);
      if (hay.length < MIN_QUOTE) continue;
      if (hay.includes(needle) && needle.length >= MIN_QUOTE) {
        return { ...q, fullQuote: true };
      }
      const window = hay.slice(0, Math.min(hay.length, QUOTE_WINDOW));
      // Slide a MIN_QUOTE window over the source quote; the first verbatim
      // hit scores by quote length (longer source quotes win ties).
      for (let start = 0; start + MIN_QUOTE <= window.length; start++) {
        const span = window.slice(start, start + MIN_QUOTE);
        if (needle.includes(span)) {
          if (!best || hay.length > norm(best.quote).length) {
            best = { ...q, fullQuote: false };
          }
          break;
        }
      }
    }
    return best;
  };
  let promoted = 0;
  let declined = 0;
  const learnedEpisodes = new Set<number>();
  const opHash = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 12);
  for (let index = 0; index < opts.proposals.length; index++) {
    const proposal = opts.proposals[index]!;
    const text = proposal.content.trim();
    const opId = `${opts.runId}/${opts.step}/p${index}-${opHash(`${proposal.memoryType}:${text}`)}`;
    if (!text) {
      declined++;
      writeReceipts(opts.memoryDir, [{
        runId: opts.runId, step: opts.step, principal: opts.owner,
        opId, op: "promote", disposition: "declined", reason: "empty proposal",
        at: Date.now(),
      }]);
      continue;
    }
    const support = bestSupport(text);
    if (!support) {
      // No verbatim source support: explicit decline, never fabricated.
      declined++;
      writeReceipts(opts.memoryDir, [{
        runId: opts.runId, step: opts.step, principal: opts.owner,
        opId, op: "promote", disposition: "declined", reason: "no verbatim source quote; not learned",
        at: Date.now(),
      }]);
      continue;
    }
    const authority = support.role === "user" && support.fullQuote ? "user_statement" as const : "inference" as const;
    const evidence = [{
      kind: support.role === "user" ? "user_message" : "agent_message",
      ref: `messages:${support.messageId}`,
      excerpt: support.quote,
      classification: support.classification,
    }];
    try {
      const results = promoteEpisode(db, store, opts.owner, support.episodeId, [{
        memoryType: proposal.memoryType,
        content: text,
        authority,
        authorityBasis: authority === "user_statement" ? `verbatim user quote messages:${support.messageId}` : `dreamy ${opts.step} inference over episode ${support.episodeId}`,
        evidence,
      }], opts.actorId);
      promoted += results.length;
      learnedEpisodes.add(support.episodeId);
      writeReceipts(opts.memoryDir, [{
        runId: opts.runId, step: opts.step, principal: opts.owner,
        opId, op: "promote", disposition: "accepted",
        reason: `${authority} from episode ${support.episodeId}`,
        memoryId: results[0]?.durableId,
        at: Date.now(),
      }]);
    } catch (err) {
      declined++;
      writeReceipts(opts.memoryDir, [{
        runId: opts.runId, step: opts.step, principal: opts.owner,
        opId, op: "promote", disposition: "rejected",
        reason: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        at: Date.now(),
      }]);
    }
  }
  // Episodes with no matched proposal get an explicit no-learn disposition so
  // settlement can prove they were deliberately not learned from.
  for (const ep of episodes) {
    if (learnedEpisodes.has(ep.episodeId)) continue;
    declined++;
    writeReceipts(opts.memoryDir, [{
      runId: opts.runId, step: opts.step, principal: opts.owner,
      opId: `${opts.runId}/${opts.step}/ep${ep.episodeId}-nolearn`, op: "no-learn",
      disposition: "declined", reason: "no supported proposal for episode",
      at: Date.now(),
    }]);
  }
  return { episodes, promoted, declined };
}
