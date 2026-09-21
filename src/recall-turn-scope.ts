/**
 * recall-turn-scope.ts — #1813 bounded ephemeral repeat context.
 *
 * Records which evidence a turn was actually given so a later pull in the
 * same turn can return already-supplied instead of reinjecting. Scoped by
 * (principal, session, turn); caller-supplied identity is bound to the
 * authenticated principal by the owner before use — the store itself trusts
 * nothing and holds no authority.
 *
 * In-memory only: daemon restart and manager close clear all scopes, and
 * per-connection transport close is covered by the 30-minute lazy expiry
 * plus explicit release (recorded decision 2026-09-21: no cross-turn leakage
 * within those bounds, so no close-hook wiring). No timers anywhere (nothing
 * races the heartbeat): expiry is lazy on access plus an entry bound with
 * oldest-first eviction.
 */

export interface TurnIdentity {
  readonly principal: string;
  readonly session: string;
  readonly turn: string;
}

export interface DeliveredRef {
  readonly id: number;
  readonly revision: number;
}

export interface TurnScopeStore {
  noteDelivered(identity: TurnIdentity, refs: readonly DeliveredRef[]): void;
  deliveredFor(identity: TurnIdentity): DeliveredRef[];
  release(identity: TurnIdentity): void;
  releaseAll(): void;
  readonly size: number;
}

interface ScopeEntry {
  refs: Map<number, number>;
  updatedAt: number;
}

function scopeKey(identity: TurnIdentity): string {
  // NUL separators: principal/session/turn are free-form caller strings and
  // must not be able to collide across segment boundaries.
  return `${identity.principal}\u0000${identity.session}\u0000${identity.turn}`;
}

/** Create an independent scope store. The owner holds exactly one. */
export function createTurnScopeStore(
  maxEntries = 500,
  ttlMs = 30 * 60_000,
): TurnScopeStore {
  const entries = new Map<string, ScopeEntry>();

  function prune(now: number): void {
    for (const [key, entry] of entries) {
      if (now - entry.updatedAt > ttlMs) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    noteDelivered(identity, refs): void {
      const now = Date.now();
      const key = scopeKey(identity);
      let entry = entries.get(key);
      if (!entry) {
        entry = { refs: new Map(), updatedAt: now };
      } else {
        // Refresh recency: re-insert so oldest-first eviction sees the write.
        entries.delete(key);
      }
      entries.set(key, entry);
      for (const ref of refs) {
        if (Number.isInteger(ref.id) && Number.isInteger(ref.revision)) {
          entry.refs.set(ref.id, ref.revision);
        }
      }
      entry.updatedAt = now;
      // Bound after insert: the new entry must never evict itself, and an
      // over-bound store must converge here rather than on the next access.
      prune(now);
    },
    deliveredFor(identity): DeliveredRef[] {
      const now = Date.now();
      const entry = entries.get(scopeKey(identity));
      if (!entry) return [];
      if (now - entry.updatedAt > ttlMs) {
        entries.delete(scopeKey(identity));
        return [];
      }
      return [...entry.refs].map(([id, revision]) => ({ id, revision }));
    },
    release(identity): void {
      entries.delete(scopeKey(identity));
    },
    releaseAll(): void {
      entries.clear();
    },
    get size(): number {
      return entries.size;
    },
  };
}
