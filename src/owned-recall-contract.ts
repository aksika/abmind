/**
 * owned-recall-contract — #1928 C1/C2 versioned recall contract (M1).
 *
 * Binding contract: requirements R1/R2/R4, design C1/C2. Exact SQL names
 * and table decomposition stay implementation choices elsewhere; the
 * wire shapes, bounds, and ref identity rules here are binding.
 *
 * No DDL, no migration, no live deletion. M2 owns projection schema
 * behind its separate approval gate.
 */

export const OWNED_RECALL_CONTRACT = "owned-v1" as const;
export const OWNED_RECALL_FEATURE = "personal_recall_contract" as const;
export const OWNED_RECALL_POLICY_VERSION = "owned-v1" as const;

/** Transport envelope admission: no old operation retry. */
export const OWNED_INPUT_MAX_BYTES = 32 * 1024;
export const OWNED_PACKET_MAX_BYTES = 128 * 1024;
export const OWNED_CONTEXT_MAX_TURNS = 4;
export const OWNED_CONTEXT_MAX_BYTES = 8 * 1024;

export type OwnedRecallProfile = "recall_fast" | "recall_normal" | "recall_full";
export type OwnedRecallLayer = "durable" | "episode" | "raw";
export type OwnedRecallStatus =
  | "skipped"
  | "empty"
  | "evidence"
  | "partial"
  | "unavailable"
  | "cancelled";

export const OWNED_PROFILES: readonly OwnedRecallProfile[] = [
  "recall_fast",
  "recall_normal",
  "recall_full",
] as const;

export function isOwnedRecallProfile(v: unknown): v is OwnedRecallProfile {
  return v === "recall_fast" || v === "recall_normal" || v === "recall_full";
}

/**
 * Fixed engineering bounds (C3). Not measured performance claims.
 * M6 measures effectiveness; changes ship with evidence, never fitted
 * silently to held-out cases.
 */
export interface OwnedProfileBounds {
  readonly workDeadlineMs: number;
  readonly embeddingWaitMs: number;
  readonly maxOutputBytes: number;
  readonly maxItems: number;
  readonly packetId?: never;
}

export const OWNED_PROFILE_BOUNDS: Record<OwnedRecallProfile, OwnedProfileBounds> = {
  recall_fast: { workDeadlineMs: 500, embeddingWaitMs: 250, maxOutputBytes: 2000, maxItems: 5 },
  recall_normal: { workDeadlineMs: 1500, embeddingWaitMs: 500, maxOutputBytes: 12000, maxItems: 15 },
  recall_full: { workDeadlineMs: 4000, embeddingWaitMs: 1000, maxOutputBytes: 32768, maxItems: 40 },
};

export interface OwnedIdentity {
  readonly principal: string;
  readonly host?: string;
  readonly conversation?: string;
  readonly execution?: string;
  readonly generation?: number;
}

export interface OwnedContextSnapshot {
  readonly text: string;
  readonly principal: string;
  readonly host: string;
  readonly conversation: string;
  readonly generation?: number;
  readonly execution?: string;
  readonly complete: boolean;
}

export interface OwnedFilters {
  readonly memoryType?: string;
  readonly scope?: string;
  readonly timeStart?: number;
  readonly timeEnd?: number;
  readonly classificationCeiling?: number;
  readonly asOf?: string;
  readonly historyIntent?: "current" | "as_of" | "history";
}

export interface OwnedCapacity {
  readonly maxOutputBytes?: number;
  readonly maxItems?: number;
  readonly deadlineMs?: number;
}

export interface OwnedRecallRequest {
  readonly contract: typeof OWNED_RECALL_CONTRACT;
  readonly profile: OwnedRecallProfile;
  readonly identity: OwnedIdentity;
  /** Fast requires the verbatim current turn. */
  readonly rawTurn?: string;
  /** Normal/full anchor: verbatim explicit text and/or 1-50 keywords. */
  readonly query?: { readonly text?: string; readonly keywords?: readonly string[] };
  readonly context?: readonly OwnedContextSnapshot[];
  readonly filters?: OwnedFilters;
  readonly capacity?: OwnedCapacity;
  /** Opaque owner-issued handle for normal/full continuation (C5, M3). */
  readonly continuation?: string;
}

export type OwnedRecallRef =
  | { readonly kind: "db"; readonly layer: OwnedRecallLayer; readonly recordId: number; readonly owner: string; readonly version: string }
  | { readonly kind: "artifact"; readonly owner: string; readonly artifact: string; readonly contentVersion: string; readonly coveredPeriod?: string }
  | { readonly kind: "graph"; readonly edge: string; readonly sources: readonly string[] };

export interface OwnedPacketItem {
  readonly ref: OwnedRecallRef;
  /**
   * Registry document id for db refs (M3 navigation aid for in-process
   * composition; unique across layers). Absent for artifact/graph extras
   * and for required evidence resolved outside the registry.
   */
  readonly docId?: number;
  readonly authority: string;
  readonly scope: string;
  readonly currentness: string;
  readonly rationale: string;
  readonly excerpt: string;
  readonly excerptProvenance: string;
  readonly sourceRefs: readonly string[];
  /**
   * Fused relevance for in-process composition (M3 additive). Ordering is
   * authoritative in `items`; the score is diagnostic, never a caller knob.
   */
  readonly score?: number;
}

export interface OwnedRecallPacket {
  readonly contract: typeof OWNED_RECALL_CONTRACT;
  readonly profile: OwnedRecallProfile;
  readonly packetId: string;
  readonly principal: string;
  /** Request binding (#1928 C7): hosts compare these against the session
   *  they issued the call for and drop a packet that no longer matches. */
  readonly host?: string;
  readonly conversation?: string;
  readonly execution?: string;
  /** Session generation the request declared (default 0). Distinct from the
   *  serving projection generation. */
  readonly generation?: number;
  readonly status: OwnedRecallStatus;
  readonly items: readonly OwnedPacketItem[];
  readonly text: string;
  readonly effective: { readonly maxOutputBytes: number; readonly maxItems: number; readonly deadlineMs: number; readonly policyVersion: string };
  readonly stageOutcomes: Record<string, { readonly status: string; readonly hitCount: number; readonly reason?: string }>;
  readonly omissionReasons: readonly string[];
  readonly truncation?: { readonly renderedBytes: number; readonly omittedCount: number };
  readonly continuation?: string;
  readonly contextRejected?: readonly string[];
}

/** Complete-ref key: loss of any identity component breaks the key. */
export function ownedRefKey(ref: OwnedRecallRef): string {
  switch (ref.kind) {
    case "db": return `db:${ref.layer}:${ref.recordId}:${ref.owner}:${ref.version}`;
    case "artifact": return `artifact:${ref.owner}:${ref.artifact}:${ref.contentVersion}`;
    case "graph": return `graph:${ref.edge}:${ref.sources.join("+")}`;
  }
}

/** C2: numeric IDs never identify evidence alone. */
export function isCompleteOwnedRef(ref: unknown): boolean {
  if (typeof ref !== "object" || ref === null) return false;
  const r = ref as Record<string, unknown>;
  if (r.kind === "db") {
    return (r.layer === "durable" || r.layer === "episode" || r.layer === "raw")
      && Number.isSafeInteger(r.recordId)
      && typeof r.owner === "string" && r.owner.length > 0
      && typeof r.version === "string" && r.version.length > 0;
  }
  if (r.kind === "artifact") {
    return typeof r.owner === "string" && r.owner.length > 0
      && typeof r.artifact === "string" && r.artifact.length > 0
      && typeof r.contentVersion === "string" && r.contentVersion.length > 0;
  }
  if (r.kind === "graph") {
    return typeof r.edge === "string" && r.edge.length > 0 && Array.isArray(r.sources);
  }
  return false;
}

function isNonBlank(s: unknown): s is string {
  return typeof s === "string" && s.trim().length > 0;
}

const FORBIDDEN_FILTER_KEYS = new Set([
  "owner", "userId", "principal", "minScore", "scoreFloor", "score_floor",
  "maxAge", "ageHours", "stages", "stageEnable", "profile",
]);

/**
 * Binding admission check for the owned contract. Returns an error string
 * for invalid input, null when the request is admissible. Semantically
 * unusable context is not an error: it is reported via contextRejected
 * and the call proceeds raw/explicit-only (handled in owned-recall.ts).
 */
export function validateOwnedRecallRequest(request: unknown): string | null {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return "request must be an object";
  }
  const r = request as Record<string, unknown>;
  if (r.contract !== OWNED_RECALL_CONTRACT) {
    return `contract must be ${OWNED_RECALL_CONTRACT}`;
  }
  if (!isOwnedRecallProfile(r.profile)) {
    return "profile must be recall_fast, recall_normal, or recall_full";
  }
  const identity = r.identity as Record<string, unknown> | undefined;
  if (typeof identity !== "object" || identity === null) {
    return "identity must be an object";
  }
  if (!isNonBlank(identity.principal)) return "identity.principal must be a non-empty string";
  if ((identity.principal as string).length > 256) return "identity.principal exceeds 256 characters";
  for (const field of ["host", "conversation", "execution"] as const) {
    const value = identity[field];
    if (value !== undefined && (!isNonBlank(value) || (value as string).length > 512)) {
      return `identity.${field} must be a non-empty string of at most 512 characters`;
    }
  }
  if (identity.generation !== undefined
    && (!Number.isSafeInteger(identity.generation) || (identity.generation as number) < 0)) {
    return "identity.generation must be a non-negative safe integer";
  }

  if (r.profile === "recall_fast") {
    if (!isNonBlank(r.rawTurn)) return "rawTurn must be a non-empty string for recall_fast";
    if ((r.rawTurn as string).length > 16384) return "rawTurn exceeds 16 KiB";
  } else {
    const q = r.query as Record<string, unknown> | undefined;
    if (typeof q !== "object" || q === null) return "query must be an object for recall_normal/recall_full";
    const text = q.text as unknown;
    const keywords = q.keywords as unknown;
    const hasText = isNonBlank(text);
    const hasKeywords = Array.isArray(keywords)
      && keywords.length >= 1 && keywords.length <= 50
      && keywords.every((k) => isNonBlank(k) && (k as string).length <= 512);
    if (!hasText && !hasKeywords) {
      return "query needs nonblank text and/or 1-50 nonblank keywords";
    }
    if (hasText && (text as string).length > 16384) return "query.text exceeds 16 KiB";
    if (r.continuation !== undefined && typeof r.continuation !== "string") {
      return "continuation must be an opaque string";
    }
    if (typeof r.continuation === "string" && r.continuation.length > 512) {
      return "continuation exceeds 512 characters";
    }
  }
  if (r.profile === "recall_fast" && r.continuation !== undefined) {
    return "continuation is only available for recall_normal/recall_full";
  }

  if (r.context !== undefined) {
    if (!Array.isArray(r.context)) return "context must be an array of completed-turn snapshots";
    if (r.context.length > OWNED_CONTEXT_MAX_TURNS) {
      return `context must contain at most ${OWNED_CONTEXT_MAX_TURNS} snapshots`;
    }
  }
  if (r.filters !== undefined) {
    if (typeof r.filters !== "object" || r.filters === null || Array.isArray(r.filters)) {
      return "filters must be an object";
    }
    for (const key of Object.keys(r.filters)) {
      if (FORBIDDEN_FILTER_KEYS.has(key)) return `filters.${key} is not an owner contract field`;
    }
    const f = r.filters as Record<string, unknown>;
    for (const field of ["memoryType", "scope"] as const) {
      if (f[field] !== undefined && !isNonBlank(f[field])) return `filters.${field} must be a non-empty string`;
    }
    for (const field of ["timeStart", "timeEnd"] as const) {
      if (f[field] !== undefined && (!Number.isFinite(f[field]) || (f[field] as number) < 0)) {
        return `filters.${field} must be a non-negative finite timestamp`;
      }
    }
    if (typeof f.timeStart === "number" && typeof f.timeEnd === "number" && (f.timeStart as number) > (f.timeEnd as number)) {
      return "filters.timeStart must not exceed filters.timeEnd";
    }
    if (f.asOf !== undefined && (!isNonBlank(f.asOf) || !/^\d{4}-\d{2}-\d{2}/.test(f.asOf as string))) {
      return "filters.asOf must be an ISO date (YYYY-MM-DD)";
    }
    if (f.classificationCeiling !== undefined
      && (!Number.isSafeInteger(f.classificationCeiling) || (f.classificationCeiling as number) < 0 || (f.classificationCeiling as number) > 3)) {
      return "filters.classificationCeiling must be 0-3";
    }
    if (f.historyIntent !== undefined && f.historyIntent !== "current" && f.historyIntent !== "as_of" && f.historyIntent !== "history") {
      return "filters.historyIntent must be current, as_of, or history";
    }
  }
  if (r.capacity !== undefined) {
    if (typeof r.capacity !== "object" || r.capacity === null || Array.isArray(r.capacity)) {
      return "capacity must be an object";
    }
    const c = r.capacity as Record<string, unknown>;
    const bounds = OWNED_PROFILE_BOUNDS[r.profile as OwnedRecallProfile];
    if (c.maxOutputBytes !== undefined
      && (!Number.isSafeInteger(c.maxOutputBytes) || (c.maxOutputBytes as number) < 1 || (c.maxOutputBytes as number) > bounds.maxOutputBytes)) {
      return `capacity.maxOutputBytes must be 1-${bounds.maxOutputBytes} for ${r.profile}`;
    }
    if (c.maxItems !== undefined
      && (!Number.isSafeInteger(c.maxItems) || (c.maxItems as number) < 1 || (c.maxItems as number) > bounds.maxItems)) {
      return `capacity.maxItems must be 1-${bounds.maxItems} for ${r.profile}`;
    }
    if (c.deadlineMs !== undefined
      && (!Number.isSafeInteger(c.deadlineMs) || (c.deadlineMs as number) < 1 || (c.deadlineMs as number) > bounds.workDeadlineMs)) {
      return `capacity.deadlineMs must be 1-${bounds.workDeadlineMs} for ${r.profile}`;
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(request) ?? "";
  } catch {
    return "request must be JSON-serializable";
  }
  if (Buffer.byteLength(serialized, "utf-8") > OWNED_INPUT_MAX_BYTES) {
    return `request exceeds ${OWNED_INPUT_MAX_BYTES} serialized bytes`;
  }
  return null;
}

/** Split unusable context from usable snapshots. Never throws. */
export function partitionOwnedContext(
  context: readonly OwnedContextSnapshot[] | undefined,
  principal: string,
  identity?: OwnedIdentity,
): { usable: OwnedContextSnapshot[]; rejected: string[] } {
  if (!context || context.length === 0) return { usable: [], rejected: [] };
  const usable: OwnedContextSnapshot[] = [];
  const rejected: string[] = [];
  const currentGeneration = identity?.generation ?? 0;
  // #1928 C7 (folded #1910): a snapshot is only verifiable against a request
  // identity that names the host and conversation it belongs to. Without
  // them every snapshot is rejected and the call searches raw/explicit-only.
  const requestHost = identity?.host;
  const requestConversation = identity?.conversation;
  let totalBytes = 0;
  for (let i = 0; i < context.length; i++) {
    const s = context[i];
    if (!s || typeof s !== "object") { rejected.push(`context[${i}]: not an object`); continue; }
    if (!isNonBlank(requestHost) || !isNonBlank(requestConversation)) {
      rejected.push(`context[${i}]: unverifiable identity (missing host/conversation)`);
      continue;
    }
    if (s.principal !== principal) { rejected.push(`context[${i}]: foreign principal`); continue; }
    if (s.complete !== true) { rejected.push(`context[${i}]: incomplete snapshot`); continue; }
    if (!isNonBlank(s.text) || !isNonBlank(s.host) || !isNonBlank(s.conversation)) {
      rejected.push(`context[${i}]: missing text, host, or conversation`);
      continue;
    }
    if (s.host !== requestHost) { rejected.push(`context[${i}]: foreign host`); continue; }
    if (s.conversation !== requestConversation) { rejected.push(`context[${i}]: foreign conversation`); continue; }
    // Generation and execution binding: a snapshot from another generation,
    // without its source execution, or from the current execution is not
    // completed prior-turn evidence.
    if ((s.generation ?? 0) !== currentGeneration) {
      rejected.push(`context[${i}]: stale generation`);
      continue;
    }
    if (!isNonBlank(s.execution)) {
      rejected.push(`context[${i}]: missing execution`);
      continue;
    }
    if (identity?.execution !== undefined && s.execution === identity.execution) {
      rejected.push(`context[${i}]: current execution`);
      continue;
    }
    const bytes = Buffer.byteLength(s.text, "utf-8");
    if (totalBytes + bytes > OWNED_CONTEXT_MAX_BYTES) {
      rejected.push(`context[${i}]: exceeds ${OWNED_CONTEXT_MAX_BYTES} total context bytes`);
      continue;
    }
    totalBytes += bytes;
    usable.push(s);
  }
  return { usable, rejected };
}

/**
 * Owner-rendered text: every selected item's excerpt appears exactly once
 * with its citation; nothing unselected is rendered. Enforces the byte
 * budget owner-side. An over-budget item is skipped so a smaller later
 * item still fits; when nothing fits untruncated, the first item is served
 * as an owner-authored, source-bound truncated excerpt rather than a
 * silent empty. No top-hit exception ever exceeds capacity.
 */
export function renderOwnedText<T extends { ref: OwnedRecallRef; excerpt: string }>(
  items: readonly T[],
  maxOutputBytes: number,
): { text: string; truncated: boolean; omittedCount: number; selected: T[]; excerpts: string[] } {
  const lines: string[] = [];
  const selected: T[] = [];
  const excerpts: string[] = [];
  let bytes = 0;
  let omittedCount = 0;
  for (const item of items) {
    if (!item) continue;
    const line = `[${selected.length + 1}] (${ownedRefKey(item.ref)}) ${item.excerpt}`;
    if (bytes + Buffer.byteLength(line + "\n", "utf-8") > maxOutputBytes) {
      omittedCount++;
      continue;
    }
    lines.push(line);
    selected.push(item);
    excerpts.push(item.excerpt);
    bytes += Buffer.byteLength(line + "\n", "utf-8");
  }
  if (selected.length === 0 && items.length > 0) {
    // Nothing fits whole: truncate the best item's excerpt owner-side.
    const first = items[0];
    if (first) {
      const head = `[1] (${ownedRefKey(first.ref)}) `;
      const tail = "… [truncated]";
      const room = maxOutputBytes - Buffer.byteLength(head + tail + "\n", "utf-8");
      if (room > 0) {
        let excerpt = first.excerpt.slice(0, room);
        while (excerpt.length > 0 && Buffer.byteLength(head + excerpt + tail + "\n", "utf-8") > maxOutputBytes) {
          excerpt = excerpt.slice(0, Math.max(0, excerpt.length - 256));
        }
        if (excerpt.length > 0) {
          lines.push(`${head}${excerpt}${tail}`);
          selected.push(first);
          excerpts.push(excerpt);
          omittedCount = items.length - 1;
          return { text: lines.join("\n"), truncated: true, omittedCount, selected, excerpts };
        }
      }
      omittedCount = items.length;
    }
  }
  return { text: lines.join("\n"), truncated: omittedCount > 0, omittedCount, selected, excerpts };
}
