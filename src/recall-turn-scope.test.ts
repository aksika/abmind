/**
 * #1813 — turn-scope store tests. In-memory isolation, bounds, expiry, and
 * release: the properties that keep repeat suppression from leaking across
 * turns, sessions, or users.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createTurnScopeStore, type TurnIdentity } from "./recall-turn-scope.js";

const A: TurnIdentity = { principal: "u1", session: "s1", turn: "t1" };
const A_NEXT: TurnIdentity = { principal: "u1", session: "s1", turn: "t2" };
const B: TurnIdentity = { principal: "u2", session: "s1", turn: "t1" };

describe("#1813 — turn scope store", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("isolates scopes by principal, session, and turn", () => {
    const store = createTurnScopeStore();
    store.noteDelivered(A, [{ id: 1, revision: 0 }]);
    expect(store.deliveredFor(A)).toEqual([{ id: 1, revision: 0 }]);
    expect(store.deliveredFor(A_NEXT)).toEqual([]);
    expect(store.deliveredFor(B)).toEqual([]);
  });

  it("merges refs across notes and ignores malformed refs", () => {
    const store = createTurnScopeStore();
    store.noteDelivered(A, [{ id: 1, revision: 0 }]);
    store.noteDelivered(A, [
      { id: 2, revision: 3 },
      { id: NaN, revision: 0 },
      { id: 3, revision: 1.5 },
    ]);
    expect(store.deliveredFor(A)).toEqual([
      { id: 1, revision: 0 },
      { id: 2, revision: 3 },
    ]);
  });

  it("release drops one scope; releaseAll drops everything", () => {
    const store = createTurnScopeStore();
    store.noteDelivered(A, [{ id: 1, revision: 0 }]);
    store.noteDelivered(B, [{ id: 2, revision: 0 }]);
    store.release(A);
    expect(store.deliveredFor(A)).toEqual([]);
    expect(store.deliveredFor(B)).toEqual([{ id: 2, revision: 0 }]);
    expect(store.size).toBe(1);
    store.releaseAll();
    expect(store.size).toBe(0);
    expect(store.deliveredFor(B)).toEqual([]);
  });

  it("expires entries past TTL and evicts oldest beyond the bound", () => {
    const nowSpy = vi.spyOn(Date, "now");
    let now = 1_000_000;
    nowSpy.mockImplementation(() => now);
    const store = createTurnScopeStore(2, 60_000);
    store.noteDelivered(A, [{ id: 1, revision: 0 }]);
    store.noteDelivered(B, [{ id: 2, revision: 0 }]);
    store.noteDelivered(A_NEXT, [{ id: 3, revision: 0 }]);
    // Bound of 2 evicted the oldest scope (A).
    expect(store.size).toBe(2);
    expect(store.deliveredFor(A)).toEqual([]);
    now += 61_000;
    expect(store.deliveredFor(B)).toEqual([]);
  });
});
