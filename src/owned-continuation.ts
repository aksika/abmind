/**
 * owned-continuation — #1928 C5 optional owner-issued continuation (M3).
 *
 * Opaque handles bound to principal + session identity (host, conversation,
 * session generation), query anchor, filters, corpus/projection generation,
 * and prior selected refs. Stored lookup metadata only, in process memory:
 * at most 16 lookups, 128 retained refs per lookup, five minute TTL, eight
 * pages. Eviction or restart yields `continuation_expired` and a
 * fresh-search instruction — never a widened or cross-execution lookup. A
 * reset or rewind (session generation change) invalidates the lookup. Late
 * results and handles cannot authorize another execution; the current
 * request supplies its own authenticated execution.
 */

import { randomUUID } from "node:crypto";

export const OWNED_CONTINUATION_MAX_LOOKUPS = 16;
export const OWNED_CONTINUATION_MAX_REFS = 128;
export const OWNED_CONTINUATION_TTL_MS = 5 * 60 * 1000;
export const OWNED_CONTINUATION_MAX_PAGES = 8;

export type OwnedContinuationProfile = "recall_normal" | "recall_full";

export interface OwnedLookupState {
  readonly handle: string;
  readonly principal: string;
  /** Session identity at issue time (#1928 C7). Reset/rewind invalidates. */
  readonly host: string;
  readonly conversation: string;
  readonly sessionGeneration: number;
  readonly originProfile: OwnedContinuationProfile;
  readonly anchorHash: string;
  readonly filtersHash: string;
  /** Serving projection generation (distinct from sessionGeneration). */
  readonly generation: number;
  readonly priorRefKeys: readonly string[];
  readonly createdAt: number;
  readonly page: number;
}

export interface OwnedContinuationResume {
  readonly entry: OwnedLookupState;
  readonly isFullContinuation: boolean;
}

const lookups = new Map<string, OwnedLookupState>();

function purgeExpired(now: number): void {
  for (const [handle, entry] of lookups) {
    if (now - entry.createdAt > OWNED_CONTINUATION_TTL_MS) lookups.delete(handle);
  }
  while (lookups.size > OWNED_CONTINUATION_MAX_LOOKUPS) {
    const oldest = lookups.keys().next();
    if (oldest.done) break;
    lookups.delete(oldest.value);
  }
}

/**
 * Issue a handle for a served normal/full lookup. The caller retains at
 * most 128 prior selected ref keys; older keys are dropped first.
 */
export function issueContinuation(input: {
  principal: string;
  host: string;
  conversation: string;
  sessionGeneration: number;
  originProfile: OwnedContinuationProfile;
  anchorHash: string;
  filtersHash: string;
  generation: number;
  priorRefKeys: readonly string[];
}): OwnedLookupState {
  const now = Date.now();
  purgeExpired(now);
  const handle = randomUUID().replace(/-/g, "");
  const entry: OwnedLookupState = {
    handle,
    principal: input.principal,
    host: input.host,
    conversation: input.conversation,
    sessionGeneration: input.sessionGeneration,
    originProfile: input.originProfile,
    anchorHash: input.anchorHash,
    filtersHash: input.filtersHash,
    generation: input.generation,
    priorRefKeys: input.priorRefKeys.slice(-OWNED_CONTINUATION_MAX_REFS),
    createdAt: now,
    page: 0,
  };
  lookups.set(handle, entry);
  purgeExpired(now);
  return entry;
}

/**
 * Resume a lookup. Changed identity, anchor, filters, or generation is
 * invalid rather than silently widened; evicted/restarted handles report
 * expired. Normal-to-full is the only profile change; same-profile paging
 * is always allowed.
 */
export function resumeContinuation(
  handle: string,
  current: {
    principal: string;
    host: string;
    conversation: string;
    sessionGeneration: number;
    profile: "recall_normal" | "recall_full";
    anchorHash: string;
    filtersHash: string;
    generation: number;
  },
): { ok: true; resume: OwnedContinuationResume } | { ok: false; reason: string } {
  const now = Date.now();
  const entry = lookups.get(handle);
  if (!entry || now - entry.createdAt > OWNED_CONTINUATION_TTL_MS) {
    if (entry) lookups.delete(handle);
    return { ok: false, reason: "continuation_expired" };
  }
  if (entry.principal !== current.principal) return { ok: false, reason: "continuation_invalid_principal" };
  // Session identity: a reset or rewind (generation bump) or a different
  // host/conversation invalidates the lookup instead of widening it.
  if (entry.host !== current.host || entry.conversation !== current.conversation
    || entry.sessionGeneration !== current.sessionGeneration) {
    return { ok: false, reason: "continuation_invalid_identity" };
  }
  if (entry.anchorHash !== current.anchorHash) return { ok: false, reason: "continuation_invalid_anchor" };
  if (entry.filtersHash !== current.filtersHash) return { ok: false, reason: "continuation_invalid_filters" };
  if (entry.generation !== current.generation) return { ok: false, reason: "continuation_invalid_generation" };
  const sameProfile = entry.originProfile === current.profile;
  const normalToFull = entry.originProfile === "recall_normal" && current.profile === "recall_full";
  if (!sameProfile && !normalToFull) return { ok: false, reason: "continuation_invalid_profile" };
  if (entry.page + 1 > OWNED_CONTINUATION_MAX_PAGES) return { ok: false, reason: "continuation_expired" };
  const advanced: OwnedLookupState = { ...entry, page: entry.page + 1 };
  lookups.set(handle, advanced);
  return { ok: true, resume: { entry: advanced, isFullContinuation: normalToFull } };
}

/** Test isolation only: drop every stored lookup. */
export function resetContinuationsForTests(): void {
  lookups.clear();
}
