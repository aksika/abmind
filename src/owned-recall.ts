/**
 * owned-recall — #1928 M1 one core entry (C1/C2).
 *
 * Validates the owned-v1 contract, enforces owner authorization, runs the
 * current new-model retrieval (personalRecall storage boundary), revalidates
 * every candidate before publication, and renders the owner packet.
 *
 * Indexed stages (Sf/Se/Ss/S8/S6), contextual planning, and continuation
 * paging land in M3; projection status in M2. Until then the packet reports
 * those stages as disabled with pending reasons rather than claiming
 * coverage it did not exercise.
 */

import { createHash, randomUUID } from "node:crypto";
import { getMemoryDb } from "./memory-manager.js";
import type { MemoryManager } from "./memory-manager.js";
import { personalRecall, personalSkipVerdict } from "./personal-recall.js";
import type { PersonalRecallHit } from "./personal-recall.js";
import { isSuppressedByForget } from "./personal-forget.js";
import {
  OWNED_RECALL_CONTRACT,
  OWNED_RECALL_POLICY_VERSION,
  OWNED_PROFILE_BOUNDS,
  validateOwnedRecallRequest,
  partitionOwnedContext,
  renderOwnedText,
} from "./owned-recall-contract.js";
import type {
  OwnedRecallRequest,
  OwnedRecallPacket,
  OwnedPacketItem,
  OwnedRecallRef,
  OwnedCapacity,
} from "./owned-recall-contract.js";

function shaVersion(canonical: string): string {
  return createHash("sha256").update(canonical, "utf-8").digest("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface OwnedRecallOptions {
  /** Authenticated transport principal; must equal identity.principal. */
  readonly transportPrincipal?: string;
}

/**
 * One core entry for owned recall. Throws on contract/authorization
 * violations (caller bugs); returns an unavailable packet when personal
 * content is not ready. Never falls back to legacy memory search.
 */
export async function ownedRecall(
  manager: MemoryManager,
  request: OwnedRecallRequest,
  opts?: OwnedRecallOptions,
): Promise<OwnedRecallPacket> {
  const validationError = validateOwnedRecallRequest(request);
  if (validationError) {
    throw new Error(`validation_error: ${validationError}`);
  }
  const principal = request.identity.principal;
  if (opts?.transportPrincipal !== undefined && opts.transportPrincipal !== principal) {
    throw new Error("unauthorized: payload identity does not match the authenticated transport");
  }
  const snapshot = manager.getOwnerSnapshot();
  if (snapshot !== null && snapshot !== principal) {
    throw new Error(`unauthorized: requested owner "${principal}" is not the primary memory owner`);
  }

  const bounds = OWNED_PROFILE_BOUNDS[request.profile];
  const capacity = request.capacity as OwnedCapacity | undefined;
  const effective = {
    maxOutputBytes: capacity?.maxOutputBytes ?? bounds.maxOutputBytes,
    maxItems: capacity?.maxItems ?? bounds.maxItems,
    deadlineMs: capacity?.deadlineMs ?? bounds.workDeadlineMs,
    policyVersion: OWNED_RECALL_POLICY_VERSION,
  };
  const startedAt = Date.now();
  const packetId = randomUUID();
  const base = {
    contract: OWNED_RECALL_CONTRACT,
    profile: request.profile,
    packetId,
    principal,
    ...(request.identity.execution !== undefined ? { execution: request.identity.execution } : {}),
    effective,
  } as const;

  const db = getMemoryDb(manager);
  if (!db) {
    return {
      ...base, status: "unavailable", items: [], text: "",
      stageOutcomes: { personal: { status: "failed", hitCount: 0, reason: "memory-not-initialized" } },
      omissionReasons: ["unavailable: memory not initialized"],
    };
  }

  // Personal readiness gate: fail closed with a truthful outcome, never
  // with mixed old/new data or a silent empty. personalRecall enforces the
  // same route; this pre-check shapes the packet status/reason.
  try {
    const { requirePersonalRoute } = await import("./personal-readiness.js");
    requirePersonalRoute(db, "recall");
  } catch (err) {
    const detail = err instanceof Error ? err.message : "personal route not ready";
    return {
      ...base, status: "unavailable", items: [], text: "",
      stageOutcomes: { personal: { status: "disabled", hitCount: 0, reason: "conversion-required" } },
      omissionReasons: [`unavailable: conversion-required (${detail.slice(0, 160)})`],
    };
  }

  // Fast auto-skip uses the deterministic corpus rule on the eligible
  // new-model corpus. Failed/incomplete measurement searches conservatively
  // (personalSkipVerdict returns false on any measurement failure).
  if (request.profile === "recall_fast") {
    const raw = request.rawTurn ?? "";
    let skip = false;
    try {
      const ceiling = request.filters?.classificationCeiling ?? 2;
      skip = personalSkipVerdict(db, principal, raw, Math.min(ceiling, 2));
    } catch {
      // Measurement failure favors searching; reported through the searched path.
      skip = false;
    }
    if (skip) {
      return {
        ...base, status: "skipped", items: [], text: "",
        stageOutcomes: { personal: { status: "completed", hitCount: 0, reason: "deterministic-skip" } },
        omissionReasons: [],
      };
    }
  }

  const { usable, rejected } = partitionOwnedContext(request.context, principal);
  const omissionReasons: string[] = [...rejected.map((r) => `context-rejected: ${r}`)];
  if (request.continuation !== undefined) {
    // C5 continuation store lands in M3; every handle is unknown until then.
    omissionReasons.push("continuation-expired: fresh search; request a new lookup");
  }
  const contextPending = usable.length > 0;
  if (contextPending) {
    // M3 delivers contextual planning. Until then a contextual call cannot
    // claim complete coverage; baseline raw/explicit calls are unaffected.
    omissionReasons.push("context-planning-pending-m3: searched anchor only");
  }

  const anchor = request.profile === "recall_fast"
    ? (request.rawTurn as string)
    : [request.query?.text ?? "", ...((request.query?.keywords ?? []) as readonly string[])].join(" ").trim();

  let hits: PersonalRecallHit[];
  try {
    const ceiling = request.filters?.classificationCeiling ?? 2;
    const result = personalRecall(db, principal, request.profile, anchor, {
      limit: effective.maxItems,
      maxClassification: Math.min(ceiling, 2),
    });
    hits = result.hits;
  } catch (err) {
    const detail = err instanceof Error ? err.message : "retrieval failed";
    return {
      ...base, status: "unavailable", items: [], text: "",
      stageOutcomes: { personal: { status: "failed", hitCount: 0, reason: detail.slice(0, 160) } },
      omissionReasons: [...omissionReasons, `unavailable: retrieval failed (${detail.slice(0, 160)})`],
    };
  }

  // C2 revalidation immediately before publication: version, access,
  // scope/currentness, and forget/restore barriers. A changed source is
  // re-resolved under the current contract or omitted, never substituted.
  const items: OwnedPacketItem[] = [];
  const withheld = new Set<string>();
  for (const hit of hits) {
    const item = revalidateHit(db, principal, hit, withheld);
    if (typeof item === "string") {
      omissionReasons.push(item);
      continue;
    }
    items.push(item);
    if (items.length >= effective.maxItems) break;
  }
  for (const note of withheld) omissionReasons.push(note);

  const rendered = renderOwnedText(items.slice(0, effective.maxItems), effective.maxOutputBytes);
  const selected = rendered.omittedCount > 0
    ? items.slice(0, items.length - rendered.omittedCount)
    : items.slice(0, effective.maxItems);
  const finalText = rendered.truncated
    ? renderOwnedText(selected, effective.maxOutputBytes).text
    : rendered.text;
  if (rendered.truncated) {
    omissionReasons.push(`truncated: ${rendered.omittedCount} item(s) over ${effective.maxOutputBytes} bytes`);
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed > effective.deadlineMs) {
    omissionReasons.push(`deadline-overrun-ms=${elapsed - effective.deadlineMs}`);
  }

  const stageOutcomes: OwnedRecallPacket["stageOutcomes"] = {
    personal: { status: "completed", hitCount: items.length },
    Sf: { status: "disabled", hitCount: 0, reason: "indexed-stages-pending-m3" },
    Se: { status: "disabled", hitCount: 0, reason: "indexed-stages-pending-m3" },
    Ss: { status: "disabled", hitCount: 0, reason: "indexed-stages-pending-m3" },
    S8: { status: "disabled", hitCount: 0, reason: "indexed-stages-pending-m3" },
    S6: { status: "disabled", hitCount: 0, reason: request.profile === "recall_full" ? "summary-search-pending-m3" : "disabled-by-profile" },
  };

  let status: OwnedRecallPacket["status"];
  if (selected.length === 0) {
    status = omissionReasons.length > 0 ? "partial" : "empty";
  } else if (omissionReasons.length > 0) {
    status = "partial";
  } else {
    status = "evidence";
  }

  let packet: OwnedRecallPacket = {
    ...base,
    status,
    items: selected,
    text: finalText,
    stageOutcomes,
    omissionReasons,
    ...(rendered.truncated
      ? { truncation: { renderedBytes: Buffer.byteLength(finalText, "utf-8"), omittedCount: rendered.omittedCount } }
      : {}),
    ...(rejected.length > 0 ? { contextRejected: rejected } : {}),
  };

  // 128 KiB serialized cap: reduce selection owner-side, never clip silently.
  let serializedBytes = Buffer.byteLength(JSON.stringify(packet), "utf-8");
  const PACKET_CAP = 128 * 1024;
  while (selected.length > 0 && serializedBytes > PACKET_CAP) {
    selected.pop();
    const re = renderOwnedText(selected, effective.maxOutputBytes);
    packet = {
      ...packet,
      status: "partial",
      items: [...selected],
      text: re.text,
      omissionReasons: [...packet.omissionReasons, "packet-over-budget: reduced selection owner-side"],
      truncation: { renderedBytes: Buffer.byteLength(re.text, "utf-8"), omittedCount: items.length - selected.length },
    };
    serializedBytes = Buffer.byteLength(JSON.stringify(packet), "utf-8");
  }
  return packet;
}

/**
 * Revalidate one candidate against current sources. Returns the packet
 * item, or an omission reason string when the candidate cannot be served.
 */
function revalidateHit(
  db: NonNullable<ReturnType<typeof getMemoryDb>>,
  principal: string,
  hit: PersonalRecallHit,
  withheld: Set<string>,
): OwnedPacketItem | string {
  if (hit.layer === "durable" && typeof hit.id === "number") {
    let row: { user_id: string; revision: number; classification: number; encrypted: number; superseded_by_id: number | null; valid_to: string | null; authority: string; applicability_scope: string; evidence: string } | undefined;
    try {
      row = db.prepare(
        "SELECT user_id, revision, classification, encrypted, superseded_by_id, valid_to, authority, applicability_scope, evidence FROM long_term_memories WHERE id = ?",
      ).get(hit.id) as typeof row;
    } catch {
      return `stale-version: durable ${hit.id} unreadable`;
    }
    if (!row) return `stale-version: durable ${hit.id} no longer exists`;
    if (row.user_id !== principal) return `unauthorized-source: durable ${hit.id} owner mismatch`;
    if (row.encrypted !== 0 || row.classification > 2) return `restricted-source: durable ${hit.id} classification/encryption`;
    if (isSuppressedByForget(db, principal, { durableId: hit.id })) return `forgotten: durable ${hit.id} suppressed`;
    if (row.superseded_by_id !== null && row.superseded_by_id !== undefined) {
      return `superseded: durable ${hit.id} replaced`;
    }
    collectWithheldEvidenceNotes(db, principal, row.evidence, `durable ${hit.id}`, withheld);
    const ref: OwnedRecallRef = { kind: "db", layer: "durable", recordId: hit.id, owner: row.user_id, version: String(row.revision) };
    const excerpt = hit.content;
    return {
      ref,
      authority: row.authority,
      scope: row.applicability_scope,
      currentness: "current",
      rationale: hit.rationale,
      excerpt,
      excerptProvenance: `durable revision ${row.revision}`,
      sourceRefs: (hit.evidence ?? []).map((e) => e.messageId !== undefined ? `db:raw:${e.messageId}` : "preserved-excerpt"),
    };
  }
  if (hit.layer === "episode" && typeof hit.id === "number") {
    let row: { user_id: string; classification: number; topic: string; outcomes: string | null; unresolved: string | null; evidence_excerpts: string } | undefined;
    try {
      row = db.prepare(
        "SELECT user_id, classification, topic, outcomes, unresolved, evidence_excerpts FROM short_term_memories WHERE id = ?",
      ).get(hit.id) as typeof row;
    } catch {
      return `stale-version: episode ${hit.id} unreadable`;
    }
    if (!row) return `stale-version: episode ${hit.id} no longer exists`;
    if (row.user_id !== principal) return `unauthorized-source: episode ${hit.id} owner mismatch`;
    if (row.classification > 2) return `restricted-source: episode ${hit.id} classification`;
    if (isSuppressedByForget(db, principal, { episodeId: hit.id })) return `forgotten: episode ${hit.id} suppressed`;
    collectWithheldEvidenceNotes(db, principal, row.evidence_excerpts, `episode ${hit.id}`, withheld);
    // Deterministic source-content version: redaction invalidates old refs.
    const version = shaVersion([row.topic, row.outcomes ?? "", row.unresolved ?? "", row.evidence_excerpts].join("\0"));
    const ref: OwnedRecallRef = { kind: "db", layer: "episode", recordId: hit.id, owner: row.user_id, version };
    return {
      ref,
      authority: "inference",
      scope: "general",
      currentness: "current",
      rationale: hit.rationale,
      excerpt: hit.content,
      excerptProvenance: `episode content-version ${version.slice(0, 12)}`,
      sourceRefs: (hit.evidence ?? []).map((e) => e.messageId !== undefined ? `db:raw:${e.messageId}` : "preserved-excerpt"),
    };
  }
  if (hit.layer === "raw" && typeof hit.id === "number") {
    let row: { user_id: string; content: string } | undefined;
    try {
      row = db.prepare("SELECT user_id, content FROM messages WHERE id = ?").get(hit.id) as typeof row;
    } catch {
      return `stale-version: raw ${hit.id} unreadable`;
    }
    if (!row) return `stale-version: raw ${hit.id} pruned`;
    // Same-owner authorized sources only; foreign raw stays unavailable.
    if (row.user_id !== principal) return `unauthorized-source: raw ${hit.id} foreign owner`;
    if (isSuppressedByForget(db, principal, { messageId: hit.id })) return `forgotten: raw ${hit.id} suppressed`;
    if (!row.content.includes(hit.content)) return `stale-version: raw ${hit.id} redacted`;
    const version = shaVersion(row.content);
    const ref: OwnedRecallRef = { kind: "db", layer: "raw", recordId: hit.id, owner: row.user_id, version };
    return {
      ref,
      authority: "raw-message",
      scope: "general",
      currentness: "current",
      rationale: hit.rationale,
      excerpt: hit.content,
      excerptProvenance: `raw content-version ${version.slice(0, 12)}`,
      sourceRefs: [],
    };
  }
  return `stale-version: unaddressable ${hit.layer} hit without record identity`;
}

/**
 * A5: an eligible primary-owned inference is still served with actual
 * attribution while foreign-owner or pruned raw sources behind its evidence
 * are withheld with reasons. Same-owner unexpanded evidence needs no note:
 * its ref is served and expansion stays on demand.
 */
function collectWithheldEvidenceNotes(
  db: NonNullable<ReturnType<typeof getMemoryDb>>,
  principal: string,
  evidenceRaw: string,
  ownerLabel: string,
  withheld: Set<string>,
): void {
  let entries: unknown;
  try {
    entries = JSON.parse(evidenceRaw) as unknown;
  } catch {
    // Malformed evidence cannot name a source; the hit itself was already
    // filtered by personalRecall, so there is nothing attributable to add.
    return;
  }
  if (!Array.isArray(entries)) return;
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const rawRef = e.messageId !== undefined ? String(e.messageId) : String(e.ref ?? "");
    const match = /^([1-9]\d*)$/.exec(rawRef.trim());
    if (!match?.[1]) continue;
    const id = Number(match[1]);
    let ownerRow: { user_id: string } | undefined;
    try {
      ownerRow = db.prepare("SELECT user_id FROM messages WHERE id = ?").get(id) as typeof ownerRow;
    } catch {
      continue;
    }
    if (!ownerRow) {
      withheld.add(`source-withheld: ${ownerLabel} evidence message ${id} pruned`);
    } else if (ownerRow.user_id !== principal) {
      withheld.add(`source-withheld: ${ownerLabel} evidence message ${id} foreign owner`);
    }
  }
}

export function isOwnedPacket(v: unknown): v is OwnedRecallPacket {
  if (!isRecord(v)) return false;
  return v.contract === OWNED_RECALL_CONTRACT && typeof v.packetId === "string" && Array.isArray(v.items);
}
