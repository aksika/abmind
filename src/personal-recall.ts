/** Recall storage boundary; #1928 owns indexed ranking and pipeline integration. */
import type Database from "better-sqlite3";
import { requirePersonalRoute } from "./personal-readiness.js";
import { isSuppressedByForget } from "./personal-forget.js";

export type PersonalRecallProfile = "recall_fast" | "recall_normal" | "recall_full";
export type PersonalRecallHit = {
  layer: "durable" | "episode" | "raw" | "s6";
  id: number | string;
  content: string;
  score: number;
  evidence?: Array<{ messageId?: number; excerpt: string; classification?: number }>;
  rationale: string;
};
export type PersonalRecallResult = { profile: PersonalRecallProfile; hits: PersonalRecallHit[]; s6Included: boolean };

function keywordsOf(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

/**
 * New-model equivalent of the legacy raw-turn skip (#1877): when every
 * informative query term is over-common in this owner's durable + episode
 * corpus, the turn carries no discriminating evidence and recall is a pure
 * omission. Same constants as the retired heuristic (minimum corpus 5,
 * ceiling max(2, floor(corpus / 4))). Explicit callers never skip.
 */
export function personalSkipVerdict(
  db: Database.Database,
  owner: string,
  query: string,
  maxClassification = 2,
): boolean {
  const candidates = keywordsOf(query).filter((t) => t.length >= 3);
  if (candidates.length === 0) return true;
  let corpus = 0;
  try {
    corpus = (db.prepare(
      "SELECT (SELECT COUNT(*) FROM long_term_memories WHERE user_id = ? AND classification <= ?) + (SELECT COUNT(*) FROM short_term_memories WHERE user_id = ? AND classification <= ?) AS c",
    ).get(owner, maxClassification, owner, maxClassification) as { c: number }).c;
  } catch {
    return false;
  }
  if (corpus < 5) return false;
  const ceiling = Math.max(2, Math.floor(corpus / 4));
  for (const term of candidates) {
    const like = `%${term}%`;
    let df = 0;
    try {
      df = (db.prepare(
        "SELECT (SELECT COUNT(*) FROM long_term_memories WHERE user_id = ? AND classification <= ? AND (content LIKE ? OR COALESCE(content_original, '') LIKE ?)) + (SELECT COUNT(*) FROM short_term_memories WHERE user_id = ? AND classification <= ? AND (topic LIKE ? OR COALESCE(outcomes, '') LIKE ? OR COALESCE(unresolved, '') LIKE ?)) AS df",
      ).get(owner, maxClassification, like, like, owner, maxClassification, like, like, like) as { df: number }).df;
    } catch {
      return false;
    }
    if (df <= ceiling) return false;
  }
  return true;
}
function score(content: string, keywords: string[]): number {
  const lower = content.toLocaleLowerCase();
  return keywords.length ? keywords.filter(k => lower.includes(k)).length / keywords.length : 0;
}
type Evidence = { messageId?: number; ref?: string; excerpt: string; classification: number };
function evidenceOf(raw: string, maxClassification: number): Evidence[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data)) throw new Error("invalid personal recall evidence");
  return data.filter((e): e is Evidence => e !== null && typeof e === "object" &&
    typeof e.excerpt === "string" && Number.isInteger(e.classification) && e.classification <= maxClassification && e.classification < 3);
}

/** Only grounded, authorized excerpts can expand into retained raw evidence. */
export function rawEvidenceSafe(db: Database.Database, owner: string, id: number, maxClassification = 2): boolean {  const classified = db.prepare("SELECT MAX(classification) AS level FROM extracted_memories WHERE user_id = ? AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(source_message_ids) THEN source_message_ids ELSE '[]' END) WHERE CAST(value AS TEXT) = ?)").get(owner, String(id)) as { level: number | null };
  if ((classified.level ?? 0) > Math.min(maxClassification, 2)) return false;
  const sealedEpisode = db.prepare("SELECT 1 FROM short_term_memories WHERE user_id = ? AND classification > ? AND EXISTS (SELECT 1 FROM json_each(source_message_ids) WHERE CAST(value AS TEXT) = ?) LIMIT 1").get(owner, Math.min(maxClassification, 2), String(id));
  return !sealedEpisode;
}

export function personalRecall(db: Database.Database, owner: string, profile: PersonalRecallProfile, query: string,
  opts?: { limit?: number; maxClassification?: number }): PersonalRecallResult {
  requirePersonalRoute(db, "recall");
  if (!["recall_fast", "recall_normal", "recall_full"].includes(profile)) throw new Error("unknown personal recall profile");
  const limit = opts?.limit ?? 10, requestedClass = opts?.maxClassification ?? 2;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("recall limit must be 1-100");
  if (!Number.isSafeInteger(requestedClass) || requestedClass < 0 || requestedClass > 3) throw new Error("classification must be 0-3");
  const maxClassification = Math.min(requestedClass, 2), keywords = keywordsOf(query), hits: PersonalRecallHit[] = [];
  const rawEvidence = new Map<number, Evidence>();
  const addEvidence = (evidence: Evidence[]): void => {
    for (const e of evidence) {
      const id = e.messageId ?? Number(/^(?:messages:)?([1-9]\d*)$/.exec(e.ref ?? "")?.[1]);
      if (Number.isSafeInteger(id) && rawEvidenceSafe(db, owner, id, maxClassification) &&
        !isSuppressedByForget(db, owner, { messageId: id })) rawEvidence.set(id, e);
    }
  };
  const durable = db.prepare("SELECT id,content,classification,authority,evidence FROM long_term_memories WHERE user_id = ? AND classification <= ? AND encrypted = 0 AND superseded_by_id IS NULL AND (valid_to IS NULL OR valid_to > date('now','localtime')) ORDER BY created_at DESC LIMIT 200")
    .all(owner, maxClassification) as Array<{ id: number; content: string; classification: number; authority: string; evidence: string }>;
  for (const r of durable) {
    const evidence = evidenceOf(r.evidence, maxClassification);
    if (isSuppressedByForget(db, owner, { durableId: r.id, content: r.content, evidence })) continue;
    const relevance = score(r.content, keywords);
    if (relevance <= 0) continue;
    const safe = evidence.filter(e => {
      const id = e.messageId ?? Number(/^(?:messages:)?([1-9]\d*)$/.exec(e.ref ?? "")?.[1]);
      return !Number.isSafeInteger(id) || rawEvidenceSafe(db, owner, id, maxClassification);
    });
    addEvidence(safe);
    hits.push({ layer: "durable", id: r.id, content: r.content, score: relevance + (["user_statement", "confirmed_decision"].includes(r.authority) ? 0.2 : 0),
      evidence: safe.map(e => ({ messageId: e.messageId ?? (Number(/^(?:messages:)?([1-9]\d*)$/.exec(e.ref ?? "")?.[1]) || undefined), excerpt: e.excerpt, classification: e.classification })),
      rationale: "durable " + r.authority });
  }
  if (profile !== "recall_fast") {
    const episodes = db.prepare("SELECT id,topic,outcomes,unresolved,evidence_excerpts,prominence FROM short_term_memories WHERE user_id = ? AND classification <= ? AND encrypted = 0 ORDER BY start_ts DESC LIMIT 100")
      .all(owner, maxClassification) as Array<{ id: number; topic: string; outcomes: string | null; unresolved: string | null; evidence_excerpts: string; prominence: number }>;
    const candidates: PersonalRecallHit[] = [];
    for (const r of episodes) {
      if (isSuppressedByForget(db, owner, { episodeId: r.id })) continue;
      const evidence = evidenceOf(r.evidence_excerpts, maxClassification).filter(e => e.messageId !== undefined &&
        rawEvidenceSafe(db, owner, e.messageId, maxClassification) && !isSuppressedByForget(db, owner, { messageId: e.messageId }));
      const text = [r.topic, r.outcomes, r.unresolved].filter(Boolean).join(" ");
      const relevance = score(text + " " + evidence.map(e => e.excerpt).join(" "), keywords) * r.prominence;
      if (relevance <= 0) continue;
      candidates.push({ layer: "episode", id: r.id, content: text, score: relevance, evidence, rationale: "episode " + r.topic });
    }
    candidates.sort((a, b) => b.score - a.score);
    for (const h of candidates.slice(0, profile === "recall_normal" ? 5 : 20)) { hits.push(h); addEvidence(h.evidence as Evidence[]); }
  }
  if (profile === "recall_full") {
    for (const [id, e] of rawEvidence) {
      const source = db.prepare("SELECT content FROM messages WHERE user_id = ? AND id = ?").get(owner, id) as { content: string } | undefined;
      if (!source || !source.content.includes(e.excerpt)) continue;
      const relevance = score(e.excerpt, keywords) * 0.5;
      if (relevance > 0) hits.push({ layer: "raw", id, content: e.excerpt, score: relevance, rationale: "retained authorized source excerpt" });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  return { profile, hits: hits.slice(0, limit), s6Included: false };
}
