/**
 * personal-controls.ts — Owner inspect/explain/correct/scope/forget across
 * the supported API/CLI/MCP surfaces (C4 + absorbed #1926, #1930 M4).
 *
 * Explanations consume real owner evidence and diagnostics rather than
 * inventing a rationale. Corrections and scope restrictions reuse the
 * revision-safe mutation boundary. Applicability scope is never confused
 * with access permission, and another principal gains no authority.
 */

import type Database from "better-sqlite3";
import { requirePersonalRoute } from "./personal-readiness.js";
import { getEpisode } from "./personal-episodes.js";
import { getDurable } from "./personal-durable.js";
import { resolveCurrentBelief } from "./personal-beliefs.js";
import { personalRecall, rawEvidenceSafe } from "./personal-recall.js";
import { isSuppressedByForget } from "./personal-forget.js";

export type InspectResult =
  | { found: true; layer: "episode" | "durable" | "raw"; owner: string; record: Record<string, unknown>; evidence: unknown }
  | { found: false; reason: string };

/** Owner-scoped inspect: layer, type, origin, evidence, applicability,
 *  current vs historical status. Another principal gains no authority. */
export function inspectPersonal(
  db: Database.Database,
  callerOwner: string,
  target: { layer: "episode" | "durable" | "raw"; id: number },
): InspectResult {
  requirePersonalRoute(db, "recall");
  if (target.layer === "episode") {
    const row = getEpisode(db, callerOwner, target.id);
    if (!row) return { found: false, reason: "episode not found or not owned by caller" };
    if (row.classification >= 3) return { found: false, reason: "sealed episode requires its safe projection" };
    if (isSuppressedByForget(db, callerOwner, { episodeId: row.id })) {
      return { found: false, reason: "forgotten: affected reads stay blocked" };
    }
    return {
      found: true,
      layer: "episode",
      owner: callerOwner,
      record: { id: row.id, topic: row.topic, startTs: row.start_ts, endTs: row.end_ts, prominence: row.prominence },
      evidence: (() => {
        try {
          return JSON.parse(row.evidence_excerpts);
        } catch {
          return [];
        }
      })(),
    };
  }
  if (target.layer === "durable") {
    const row = getDurable(db, callerOwner, target.id);
    if (!row) return { found: false, reason: "durable memory not found or not owned by caller" };
    if (row.classification >= 3) return { found: false, reason: "sealed durable memory requires its safe projection" };
    if (isSuppressedByForget(db, callerOwner, { durableId: row.id })) {
      return { found: false, reason: "forgotten: affected reads stay blocked" };
    }
    return {
      found: true,
      layer: "durable",
      owner: callerOwner,
      record: {
        id: row.id,
        memoryType: row.memory_type,
        authority: row.authority,
        scope: row.applicability_scope,
        revision: row.revision,
        supersededBy: row.superseded_by_id,
      },
      evidence: (() => {
        try {
          return JSON.parse(row.evidence);
        } catch {
          return [];
        }
      })(),
    };
  }
  const msg = db.prepare("SELECT id, user_id, session_id, role, content, timestamp FROM messages WHERE id = ? AND user_id = ?").get(
    target.id,
    callerOwner,
  ) as Record<string, unknown> | undefined;
  if (!msg) return { found: false, reason: "raw message not found or not owned by caller" };
  if (!rawEvidenceSafe(db, callerOwner, target.id)) return { found: false, reason: "raw source requires its safe projection" };
  if (isSuppressedByForget(db, callerOwner, { messageId: target.id })) {
    return { found: false, reason: "forgotten: affected reads stay blocked" };
  }
  return { found: true, layer: "raw", owner: callerOwner, record: msg, evidence: [] };
}

/**
 * Explain why a particular recall returned a memory: replays the profile's
 * scoring inputs and the deterministic belief rationale over real evidence.
 * Never invents a rationale.
 */
export function explainPersonal(
  db: Database.Database,
  callerOwner: string,
  input: { profile: "recall_fast" | "recall_normal" | "recall_full"; query: string; memoryLayer: "durable" | "episode"; memoryId: number },
): { explained: boolean; reason: string; evidence: unknown } {
  requirePersonalRoute(db, "recall");
  const recalled = personalRecall(db, callerOwner, input.profile, input.query, { limit: 50 });
  const hit = recalled.hits.find((h) => h.layer === input.memoryLayer && h.id === input.memoryId);
  if (!hit) return { explained: false, reason: "memory was not returned by that recall", evidence: [] };
  if (input.memoryLayer === "durable") {
    const row = getDurable(db, callerOwner, input.memoryId);
    if (!row) return { explained: false, reason: "durable memory not owned by caller", evidence: [] };
    const belief = resolveCurrentBelief(db, callerOwner, (() => {
      try {
        return JSON.parse(row.applicability_scope) as Record<string, unknown>;
      } catch {
        return { scope: "general" };
      }
    })());
    return {
      explained: true,
      reason: `score=${hit.score.toFixed(3)} rationale=${hit.rationale} belief=${belief.status}`,
      evidence: (() => {
        try {
          return JSON.parse(row.evidence);
        } catch {
          return [];
        }
      })(),
    };
  }
  const row = getEpisode(db, callerOwner, input.memoryId);
  if (!row) return { explained: false, reason: "episode not owned by caller", evidence: [] };
  return {
    explained: true,
    reason: `score=${hit.score.toFixed(3)} rationale=${hit.rationale} prominence=${row.prominence}`,
    evidence: (() => {
      try {
        return JSON.parse(row.evidence_excerpts);
      } catch {
        return [];
      }
    })(),
  };
}
