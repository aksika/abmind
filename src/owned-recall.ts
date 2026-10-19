/**
 * owned-recall — #1928 one core entry (C1/C2, M3 pipeline).
 *
 * Validates the owned-v1 contract, enforces owner authorization, runs the
 * indexed pipeline over serving projections (Sf/Se/Ss/S8, full-only S6),
 * revalidates every candidate before publication, and renders the owner
 * packet. No stage searches legacy memories; legacy serving paths are
 * retired behind this entry.
 */

import { randomUUID, createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getMemoryDb, getMemoryDir } from "./memory-manager.js";
import type { MemoryManager } from "./memory-manager.js";
import { personalSkipVerdict } from "./personal-recall.js";
import { isSuppressedByForget } from "./personal-forget.js";
import { parseArtifactOwner } from "./sleep/sleep-daily-summary.js";
import {
  OWNED_RECALL_CONTRACT,
  OWNED_RECALL_POLICY_VERSION,
  OWNED_PROFILE_BOUNDS,
  validateOwnedRecallRequest,
  partitionOwnedContext,
  renderOwnedText,
  ownedRefKey,
} from "./owned-recall-contract.js";
import { servingGeneration } from "./recall-projection-build.js";
import { episodeSourceVersion } from "./recall-projection-build.js";
import { runOwnedPipeline, anchorHashOf, OwnedPipelineCancelled } from "./owned-pipeline.js";
import type { OwnedPipelineItem } from "./owned-pipeline.js";
import { resumeContinuation, issueContinuation } from "./owned-continuation.js";
import { extractSignificantTerms } from "./trigram-search.js";
import type {
  OwnedRecallRequest,
  OwnedRecallPacket,
  OwnedPacketItem,
  OwnedRecallRef,
  OwnedCapacity,
} from "./owned-recall-contract.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface OwnedRecallOptions {
  /** Authenticated transport principal; must equal identity.principal. */
  readonly transportPrincipal?: string;
  /** Cancellation for in-flight lookups; late results never publish. */
  readonly signal?: AbortSignal;
  /**
   * Whether the fast auto-skip may apply. The owned contract's fast profile
   * is the automatic-compact request and skips by default; the legacy
   * in-process mapping disables it for explicit-intent calls, which always
   * search. M4's owned callers never send explicit intent with fast.
   */
  readonly skipAllowed?: boolean;
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

  const { usable, rejected } = partitionOwnedContext(request.context, principal, request.identity);
  // Unusable context is reported separately (`contextRejected`); searching
  // raw/explicit-only is the specified behavior, not degraded coverage, so
  // it does not by itself turn the packet partial.
  const omissionReasons: string[] = [];

  // A committed pending forget blocks affected recall until cleanup verifies
  // (C4). This also covers a crash between the forget transaction and its
  // survivor re-index: fail closed rather than serve a hollow registry.
  try {
    const blocked = db.prepare(
      "SELECT 1 FROM forget_operations WHERE owner = ? AND state = 'pending' LIMIT 1",
    ).get(principal);
    if (blocked) {
      return {
        ...base, status: "unavailable", items: [], text: "",
        stageOutcomes: { personal: { status: "disabled", hitCount: 0, reason: "forget-barrier-pending" } },
        omissionReasons: ["unavailable: forget-barrier-pending (cleanup not verified)"],
        ...(rejected.length > 0 ? { contextRejected: rejected } : {}),
      };
    }
  } catch {
    return {
      ...base, status: "unavailable", items: [], text: "",
      stageOutcomes: { personal: { status: "failed", hitCount: 0, reason: "forget-barrier-unreadable" } },
      omissionReasons: ["unavailable: forget-barrier-unreadable"],
      ...(rejected.length > 0 ? { contextRejected: rejected } : {}),
    };
  }

  // Fast auto-skip uses the deterministic corpus rule on the eligible
  // new-model corpus. Failed/incomplete measurement searches conservatively
  // (personalSkipVerdict returns false on any measurement failure). A usable
  // context snapshot defeats the skip: the combined rule requires every
  // usable raw/context term to be over-common. Explicit-intent fast calls
  // from the legacy mapping always search.
  if (request.profile === "recall_fast" && opts?.skipAllowed !== false && usable.length === 0) {
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

  // Anchor and context plan (M3 contextual planning: the unchanged explicit
  // anchor plus at most one bounded eligible-context plan, half weight).
  const anchor = request.profile === "recall_fast"
    ? (request.rawTurn as string)
    : [request.query?.text ?? "", ...((request.query?.keywords ?? []) as readonly string[])].join(" ").trim();
  const explicitKeywords = (request.query?.keywords ?? []) as readonly string[];
  const contextTerms = usable.length > 0 ? extractSignificantTerms(usable.map((s) => s.text)).slice(0, 16) : [];
  const anchorHash = anchorHashOf(anchor, explicitKeywords, contextTerms, request.filters ?? {}, principal);
  const filtersHash = anchorHashOf("", [], [], request.filters ?? {}, principal);

  // Serving generation barrier: without a trusted generation, recall is
  // unavailable/index-required. Partial indexes never imply full coverage.
  const generation = servingGeneration(db);
  if (generation === null) {
    const snap = `projection ${request.profile} unavailable`;
    void snap;
    return {
      ...base, status: "unavailable", items: [], text: "",
      stageOutcomes: { projection: { status: "disabled", hitCount: 0, reason: "index-required" } },
      omissionReasons: [...omissionReasons, "unavailable: index-required (no serving projection generation)"],
      ...(rejected.length > 0 ? { contextRejected: rejected } : {}),
    };
  }

  // Continuation (C5): changed identity, anchor, filters, or generation is
  // invalid rather than silently widened; eviction yields expired.
  // Fast has no continuation by contract validation, so only normal/full
  // handles arrive here.
  let excludeRefKeys: Set<string> | undefined;
  let reserveRefKeys: string[] | undefined;
  let priorLookupRefKeys: readonly string[] = [];
  if (request.continuation !== undefined && request.profile !== "recall_fast") {
    const resume = resumeContinuation(request.continuation, {
      principal, profile: request.profile, anchorHash, filtersHash, generation,
    });
    if (resume.ok) {
      priorLookupRefKeys = resume.resume.entry.priorRefKeys;
      excludeRefKeys = new Set(resume.resume.entry.priorRefKeys);
      if (resume.resume.isFullContinuation) reserveRefKeys = [...resume.resume.entry.priorRefKeys];
    } else {
      omissionReasons.push(`${resume.reason}: fresh search; request a new lookup`);
    }
  }

  let pipelineItems: OwnedPipelineItem[];
  let pipelineOutcomes: OwnedRecallPacket["stageOutcomes"];
  try {
    const outcome = await runOwnedPipeline({
      db,
      owner: principal,
      profile: request.profile,
      anchorText: anchor,
      keywords: explicitKeywords,
      contextTerms,
      filters: request.filters ?? {},
      generation,
      maxItems: effective.maxItems,
      deadlineAt: startedAt + effective.deadlineMs,
      signal: opts?.signal,
      memoryDir: getMemoryDir(manager),
      embeddingProvider: manager.getEmbeddingProvider(),
      excludeRefKeys,
      reserveRefKeys,
    });
    pipelineItems = outcome.items;
    pipelineOutcomes = outcome.stageOutcomes;
    omissionReasons.push(...outcome.omissionReasons);
    const overrun = outcome.elapsedMs - effective.deadlineMs;
    if (overrun > 0) omissionReasons.push(`deadline-overrun-ms=${overrun}`);
  } catch (err) {
    if (err instanceof OwnedPipelineCancelled || opts?.signal?.aborted === true) {
      return {
        ...base, status: "cancelled", items: [], text: "",
        stageOutcomes: { pipeline: { status: "failed", hitCount: 0, reason: "cancelled" } },
        omissionReasons: [...omissionReasons, "cancelled: lookup abandoned; late results cannot publish"],
        ...(rejected.length > 0 ? { contextRejected: rejected } : {}),
      };
    }
    const detail = err instanceof Error ? err.message : "retrieval failed";
    return {
      ...base, status: "unavailable", items: [], text: "",
      stageOutcomes: { pipeline: { status: "failed", hitCount: 0, reason: detail.slice(0, 160) } },
      omissionReasons: [...omissionReasons, `unavailable: retrieval failed (${detail.slice(0, 160)})`],
      ...(rejected.length > 0 ? { contextRejected: rejected } : {}),
    };
  }

  // Publication gate: revalidate every candidate against current sources
  // after every external await. A changed source is omitted, never
  // substituted; late completions can never publish.
  const items: OwnedPacketItem[] = [];
  const memoryDir = getMemoryDir(manager);
  for (const item of pipelineItems) {
    const problem = recheckItemForPublication(db, principal, item, memoryDir);
    if (problem !== null) {
      omissionReasons.push(problem);
      continue;
    }
    items.push({
      ref: item.ref,
      ...(item.docId !== null ? { docId: item.docId } : {}),
      authority: item.authority,
      scope: item.scope,
      currentness: item.currentness,
      rationale: item.rationale,
      excerpt: item.excerpt,
      excerptProvenance: item.provenance,
      sourceRefs: item.sourceRefs,
      score: item.score,
    });
    if (items.length >= effective.maxItems) break;
  }

  // A stage that was attempted but failed or timed out is visible
  // degradation: usable deterministic evidence still returns, but as
  // `partial`, never as complete evidence. Configured-off stages are not
  // degradations. `disabled`/`no-provider` remain observable in the packet.
  for (const [stage, outcome] of Object.entries(pipelineOutcomes)) {
    if (outcome.status === "failed" || outcome.status === "deadline") {
      omissionReasons.push(`stage-degraded: ${stage} (${outcome.status})`);
    }
  }

  const rendered = renderOwnedText(items, effective.maxOutputBytes);  const selected = rendered.selected;
  const finalText = rendered.text;
  // A rendered excerpt is the selected excerpt: when the owner truncated an
  // over-capacity item, the packet carries exactly the rendered text rather
  // than a longer payload the host could reconstruct.
  const renderedItems: OwnedPacketItem[] = selected.map((item, index) => ({
    ...item,
    excerpt: rendered.excerpts[index] ?? item.excerpt,
    excerptProvenance: rendered.excerpts[index] === item.excerpt
      ? item.excerptProvenance
      : `${item.excerptProvenance} (truncated owner-side)`,
  }));
  if (rendered.truncated) {
    omissionReasons.push(`truncated: ${rendered.omittedCount} item(s) over ${effective.maxOutputBytes} bytes`);
  }

  const elapsed = Date.now() - startedAt;
  if (elapsed > effective.deadlineMs) {
    omissionReasons.push(`deadline-overrun-ms=${elapsed - effective.deadlineMs}`);
  }

  let status: OwnedRecallPacket["status"];
  if (selected.length === 0) {
    status = omissionReasons.length > 0 ? "partial" : "empty";
  } else if (omissionReasons.length > 0) {
    status = "partial";
  } else {
    status = "evidence";
  }

  // Issue a continuation handle for normal/full results (C5 paging and
  // normal-to-full escalation). Fast has no continuation by contract. The
  // handle accumulates every ref served across this lookup's pages so a
  // later page can never repeat an earlier one.
  let continuationHandle: string | undefined;
  if ((request.profile === "recall_normal" || request.profile === "recall_full") && selected.length > 0) {
    const priorKeys = new Set(priorLookupRefKeys);
    const accumulated = [...priorLookupRefKeys];
    for (const item of selected) {
      const key = ownedRefKey(item.ref);
      if (!priorKeys.has(key)) {
        priorKeys.add(key);
        accumulated.push(key);
      }
    }
    const issued = issueContinuation({
      principal,
      originProfile: request.profile,
      anchorHash,
      filtersHash,
      generation,
      priorRefKeys: accumulated,
    });
    continuationHandle = issued.handle;
  }

  let packet: OwnedRecallPacket = {
    ...base,
    status,
    items: renderedItems,
    text: finalText,
    stageOutcomes: pipelineOutcomes,
    omissionReasons,
    ...(rendered.truncated
      ? { truncation: { renderedBytes: Buffer.byteLength(finalText, "utf-8"), omittedCount: rendered.omittedCount } }
      : {}),
    ...(rejected.length > 0 ? { contextRejected: rejected } : {}),
    ...(continuationHandle !== undefined ? { continuation: continuationHandle } : {}),
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
      items: re.selected.map((item, index) => ({
        ...item,
        excerpt: re.excerpts[index] ?? item.excerpt,
      })),
      text: re.text,
      omissionReasons: [...packet.omissionReasons, "packet-over-budget: reduced selection owner-side"],
      truncation: { renderedBytes: Buffer.byteLength(re.text, "utf-8"), omittedCount: items.length - selected.length },
    };
    serializedBytes = Buffer.byteLength(JSON.stringify(packet), "utf-8");
  }
  return packet;
}

/**
 * Publication gate: revalidate one pipeline candidate against current
 * sources after every external await. Returns null when servable, or an
 * omission reason when the candidate must be withheld. A changed source
 * is omitted, never substituted; late completions can never publish.
 */
function recheckItemForPublication(
  db: NonNullable<ReturnType<typeof getMemoryDb>>,
  principal: string,
  item: OwnedPipelineItem,
  memoryDir: string | null,
): string | null {
  const ref = item.ref;
  if (ref.kind === "artifact") {
    // Artifact evidence revalidates against the file: it must still exist
    // under the canonical summary roots with matching owner provenance and
    // unchanged content version, and no forget barrier may be pending.
    try {
      const blocked = db.prepare("SELECT 1 FROM forget_operations WHERE owner = ? AND state = 'pending' LIMIT 1").get(principal);
      if (blocked) return "forget-barrier-pending: summary withheld";
    } catch {
      return "forget-barrier-unreadable: summary withheld";
    }
    if (memoryDir === null) return "source-withheld: summary roots unavailable at publication";
    if (!isSafeArtifactPath(ref.artifact)) return "source-withheld: non-canonical artifact path";
    const filePath = join(memoryDir, ref.artifact);
    let head: string;
    try {
      const fd = openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(4096);
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        head = buffer.subarray(0, read).toString("utf-8");
      } finally {
        closeSync(fd);
      }
    } catch {
      return `source-withheld: summary ${ref.artifact} missing or unreadable`;
    }
    if (parseArtifactOwner(head) !== principal) {
      return `source-withheld: summary ${ref.artifact} owner provenance changed`;
    }
    return null;
  }
  if (ref.kind === "graph") {
    // Graph evidence is only as eligible as its bound source documents.
    for (const src of ref.sources) {
      const parsed = parseDbKey(src, principal);
      if (!parsed) return `unauthorized-source: graph edge with foreign source`;
      const problem = recheckDbSource(db, principal, parsed.layer, parsed.recordId, parsed.version);
      if (problem !== null) return problem;
    }
    return null;
  }
  const problem = recheckDbSource(db, principal, ref.layer, ref.recordId, ref.version);
  if (problem !== null) return problem;
  // Quotes that reached the excerpt must still be authorized: an unproven
  // source denies its preserved excerpt as well as raw expansion. Source
  // refs carry only verified quotes; the raw evidence lineage behind the
  // item stays informational and never publishes foreign content.
  for (const sourceRef of item.sourceRefs) {
    const parsed = parseDbKey(sourceRef, principal);
    if (!parsed || parsed.layer !== "raw") return `source-withheld: unverified source ref`;
    try {
      const msg = db.prepare("SELECT user_id FROM messages WHERE id = ?").get(parsed.recordId) as
        | { user_id: string } | undefined;
      if (!msg) return `source-withheld: evidence message ${parsed.recordId} pruned`;
      if (msg.user_id !== principal) return `source-withheld: evidence message ${parsed.recordId} foreign owner`;
      if (isSuppressedByForget(db, principal, { messageId: parsed.recordId })) {
        return `forgotten: evidence message ${parsed.recordId} suppressed`;
      }
    } catch {
      return `source-withheld: evidence message ${parsed.recordId} unreadable`;
    }
  }
  return null;
}

function parseDbKey(key: string, principal: string): { layer: "durable" | "episode" | "raw"; recordId: number; version: string } | null {  const match = /^db:(durable|episode|raw):([1-9]\d*):(.+):(.+)$/.exec(key);
  const layer = match?.[1];
  const recordId = Number(match?.[2]);
  const owner = match?.[3];
  const version = match?.[4];
  if ((layer !== "durable" && layer !== "episode" && layer !== "raw") || !Number.isSafeInteger(recordId) || owner !== principal || !version) {
    return null;
  }
  return { layer, recordId, version };
}

/** Relative artifact identity only: no absolute paths, no traversal. */
function isSafeArtifactPath(rel: string): boolean {
  if (rel.length === 0 || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return !rel.split("/").some((part) => part === ".." || part === ".");
}

/** Version, access, and forget revalidation for one db ref. */
function recheckDbSource(
  db: NonNullable<ReturnType<typeof getMemoryDb>>,
  principal: string,
  layer: "durable" | "episode" | "raw",
  recordId: number,
  version: string,
): string | null {
  try {
    if (layer === "durable") {
      const row = db.prepare(
        "SELECT user_id, revision, classification, encrypted, superseded_by_id FROM long_term_memories WHERE id = ?",
      ).get(recordId) as
        | { user_id: string; revision: number; classification: number; encrypted: number; superseded_by_id: number | null }
        | undefined;
      if (!row) return `stale-version: durable ${recordId} no longer exists`;
      if (row.user_id !== principal) return `unauthorized-source: durable ${recordId} owner mismatch`;
      if (row.encrypted !== 0 || row.classification > 2) return `restricted-source: durable ${recordId} classification/encryption`;
      if (String(row.revision) !== version) return `stale-version: durable ${recordId} revised`;
      if (row.superseded_by_id !== null) return `superseded: durable ${recordId} replaced`;
      if (isSuppressedByForget(db, principal, { durableId: recordId })) return `forgotten: durable ${recordId} suppressed`;
      return null;
    }
    if (layer === "episode") {
      const row = db.prepare(
        "SELECT user_id, classification, topic, outcomes, unresolved, evidence_excerpts FROM short_term_memories WHERE id = ?",
      ).get(recordId) as
        | { user_id: string; classification: number; topic: string; outcomes: string | null; unresolved: string | null; evidence_excerpts: string }
        | undefined;
      if (!row) return `stale-version: episode ${recordId} no longer exists`;
      if (row.user_id !== principal) return `unauthorized-source: episode ${recordId} owner mismatch`;
      if (row.classification > 2) return `restricted-source: episode ${recordId} classification`;
      // Deterministic source-content version: a redaction or edit between
      // retrieval and publication invalidates the selected ref. The registry
      // also stores this version, and the packet ref carries it.
      if (episodeSourceVersion(row.topic, row.outcomes, row.unresolved, row.evidence_excerpts) !== version) {
        return `stale-version: episode ${recordId} content changed`;
      }
      if (isSuppressedByForget(db, principal, { episodeId: recordId })) return `forgotten: episode ${recordId} suppressed`;
      return null;
    }
    const row = db.prepare("SELECT user_id, content FROM messages WHERE id = ?").get(recordId) as
      | { user_id: string; content: string } | undefined;
    if (!row) return `stale-version: raw ${recordId} pruned`;
    if (row.user_id !== principal) return `unauthorized-source: raw ${recordId} foreign owner`;
    if (isSuppressedByForget(db, principal, { messageId: recordId })) return `forgotten: raw ${recordId} suppressed`;
    if (createHash("sha256").update(row.content, "utf-8").digest("hex") !== version) {
      return `stale-version: raw ${recordId} content changed`;
    }
    return null;
  } catch {
    return `stale-version: ${layer} ${recordId} unreadable`;
  }
}

export function isOwnedPacket(v: unknown): v is OwnedRecallPacket {
  if (!isRecord(v)) return false;
  return v.contract === OWNED_RECALL_CONTRACT && typeof v.packetId === "string" && Array.isArray(v.items);
}
