import type Database from "better-sqlite3";
import { isSuppressedByForget } from "./personal-forget.js";

export type PersonalEvidence = { kind: string; ref: string; excerpt: string; classification: number };

export function validateClassification(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 3) throw new Error("classification must be 0-3");
}

/** Validate the speaker and quotation from owner-bound evidence, not a model label. */
export function validatePersonalEvidence(db: Database.Database, owner: string, evidence: readonly PersonalEvidence[], userAuthority: boolean): number {
  if (!Array.isArray(evidence) || evidence.length === 0) throw new Error("preserved evidence required");
  let maxClassification = 0;
  let hasUser = false;
  for (const item of evidence) {
    if (!item || typeof item.excerpt !== "string" || !item.excerpt.trim() || typeof item.ref !== "string") throw new Error("invalid preserved evidence");
    validateClassification(item.classification);
    if (item.classification >= 3) throw new Error("sealed source values cannot be copied into plaintext evidence");
    maxClassification = Math.max(maxClassification, item.classification);
    if (item.kind === "legacy") {
      const match = /^extracted_memories:([1-9]\d*)$/.exec(item.ref);
      const row = match ? db.prepare("SELECT content_en, classification FROM extracted_memories WHERE id = ? AND user_id = ?").get(Number(match[1]), owner) as { content_en: string; classification: number } | undefined : undefined;
      if (!row || row.classification >= 3 || !row.content_en.includes(item.excerpt)) throw new Error("legacy evidence unavailable or requires its safe projection");
      maxClassification = Math.max(maxClassification, row.classification);
      continue;
    }
    if (item.kind !== "user_message" && item.kind !== "user_confirmation" && item.kind !== "agent_message" && item.kind !== "direct") throw new Error("unsupported personal evidence kind");
    if (item.kind === "direct") {
      // Owner-supplied content with no conversation source (direct CLI/MCP
      // stores on ready datasets). The excerpt is the stored content itself,
      // preserved alongside the row — never a quote borrowed from elsewhere.
      // Direct evidence never confers user authority: unvalidated assertions
      // promote as inference at most.
      if (item.ref !== "direct" || !item.excerpt.trim()) throw new Error("direct evidence requires ref 'direct' and the stored excerpt");
      continue;
    }
    const match = /^(?:messages:)?([1-9]\d*)$/.exec(item.ref);
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id) || isSuppressedByForget(db, owner, { messageId: id })) throw new Error("source reference unavailable or forgotten");
    let source = db.prepare("SELECT role, content FROM messages WHERE id = ? AND user_id = ?").get(id, owner) as { role: string; content: string } | undefined;
    if (!source) {
      const episodes = db.prepare("SELECT evidence_excerpts FROM short_term_memories WHERE user_id = ?").all(owner) as Array<{ evidence_excerpts: string }>;
      for (const episode of episodes) {
        const entries: unknown = JSON.parse(episode.evidence_excerpts);
        if (!Array.isArray(entries)) throw new Error("invalid preserved source evidence");
        for (const raw of entries) {
          if (!raw || typeof raw !== "object") continue;
          const entry = raw as Record<string, unknown>;
          if (entry["messageId"] === id && typeof entry["role"] === "string" && typeof entry["excerpt"] === "string") {
            if (typeof entry["classification"] !== "number") throw new Error("source classification unavailable");
            validateClassification(entry["classification"]);
            if (entry["classification"] >= 3) throw new Error("sealed preserved evidence requires its safe projection");
            maxClassification = Math.max(maxClassification, entry["classification"]);
            source = { role: entry["role"], content: entry["excerpt"] };
          }
        }
      }
    }
    if (!source || !source.content.includes(item.excerpt)) throw new Error("evidence is not a quote from this owner's source");
    if (item.kind === "user_message" || item.kind === "user_confirmation") {
      if (source.role !== "user") throw new Error("assistant evidence cannot supply user authority");
      hasUser = true;
    }
    const classified = db.prepare("SELECT MAX(classification) AS level FROM extracted_memories WHERE user_id = ? AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(source_message_ids) THEN source_message_ids ELSE '[]' END) WHERE CAST(value AS TEXT) = ?)").get(owner, String(id)) as { level: number | null };
    if ((classified.level ?? 0) >= 3) throw new Error("sealed source evidence requires its safe projection");
    maxClassification = Math.max(maxClassification, classified.level ?? 0);
  }
  if (userAuthority && !hasUser) throw new Error("user authority requires validated user evidence");
  return maxClassification;
}
