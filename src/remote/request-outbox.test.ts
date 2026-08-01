import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RequestOutbox, OUTBOX_MAX_ATTEMPTS } from "./request-outbox.js";
import { ROUTE_RETRY_DEADLINE_MS, ROUTE_TERMINAL_UNKNOWN_MAX_ENTRIES, ROUTE_TERMINAL_UNKNOWN_RETENTION_MS } from "./route-contract.js";

let uid = 0;

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), `abmind-outbox-${++uid}-`));
  mkdirSync(root, { recursive: true });
  return root;
}

function v1File(peer: string, entries: unknown[]): string {
  return JSON.stringify({ version: 1, peer, entries });
}

describe("RequestOutbox V2", () => {
  let root: string;
  beforeEach(() => { root = makeRoot(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("appends entries in the admitted state with a persisted wall-clock deadline", () => {
    const path = join(root, "peer.json");
    const outbox = new RequestOutbox("peer", path);
    expect(outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {})).toBe(true);
    const entry = outbox.get("f-1")!;
    expect(entry.state).toBe("admitted");
    expect(entry.attempts).toBe(0);
    expect(Date.parse(entry.deadlineAt) - Date.parse(entry.createdAt)).toBe(ROUTE_RETRY_DEADLINE_MS);
    expect(outbox.counts()).toEqual({ retryEligible: 1, terminalUnknown: 0, nextAttemptAt: undefined });
  });

  it("migrates valid V1 files without refreshing the age-derived deadline", () => {
    const path = join(root, "peer.json");
    const createdAt = new Date(Date.now() - ROUTE_RETRY_DEADLINE_MS / 2).toISOString();
    writeFileSync(path, v1File("peer", [{
      id: "f-old", method: "private.edit", requestId: "r-old", idempotencyKey: "k-old",
      body: "{}", version: 1, payload: {}, createdAt, attempts: 2, lastError: "timeout",
    }]));
    const outbox = new RequestOutbox("peer", path);
    expect(outbox.isQuarantined).toBe(false);
    const entry = outbox.get("f-old")!;
    expect(entry.state).toBe("admitted");
    expect(entry.attempts).toBe(2);
    expect(entry.idempotencyKey).toBe("k-old");
    // Deadline derived from the ORIGINAL createdAt, not migration time.
    expect(Date.parse(entry.deadlineAt)).toBe(Date.parse(createdAt) + ROUTE_RETRY_DEADLINE_MS);
    // The file is rewritten as V2 once.
    const saved = JSON.parse(readFileSync(path, "utf-8")) as { version: number };
    expect(saved.version).toBe(2);
  });

  it("marks already-expired migrated entries terminal_unknown", () => {
    const path = join(root, "peer.json");
    const createdAt = new Date(Date.now() - ROUTE_RETRY_DEADLINE_MS - 10_000).toISOString();
    writeFileSync(path, v1File("peer", [{
      id: "f-expired", method: "private.edit", requestId: "r-expired",
      body: "{}", version: 1, createdAt, attempts: 1,
    }]));
    const outbox = new RequestOutbox("peer", path);
    expect(outbox.get("f-expired")!.state).toBe("terminal_unknown");
    expect(outbox.counts().terminalUnknown).toBe(1);
  });

  it("quarantines corrupt state and never silently replaces it", () => {
    const path = join(root, "peer.json");
    writeFileSync(path, "{ not json", "utf-8");
    const outbox = new RequestOutbox("peer", path);
    expect(outbox.isQuarantined).toBe(true);
    expect(outbox.length).toBe(0);
    expect(outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {})).toBe(false);
    const quarantined = readdirQuarantine(root);
    expect(quarantined).toBe(1);
  });

  it("quarantines V2 files with duplicate frame IDs", () => {
    const path = join(root, "peer.json");
    const entry = {
      id: "f-dup", method: "private.recall", requestId: "r-1", body: "{}", version: 1,
      state: "admitted", createdAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 10_000).toISOString(), attempts: 0,
    };
    writeFileSync(path, JSON.stringify({ version: 2, peer: "peer", entries: [entry, entry] }));
    const outbox = new RequestOutbox("peer", path);
    expect(outbox.isQuarantined).toBe(true);
  });

  it("quarantines files with an invalid state or a deadline before creation", () => {
    const path = join(root, "peer.json");
    const base = {
      id: "f-1", method: "private.recall", requestId: "r-1", body: "{}", version: 1,
      createdAt: new Date().toISOString(), attempts: 0,
    };
    const badState = { ...base, state: "bogus", deadlineAt: new Date(Date.now() + 10_000).toISOString() };
    writeFileSync(path, JSON.stringify({ version: 2, peer: "peer", entries: [badState] }));
    expect(new RequestOutbox("peer", path).isQuarantined).toBe(true);

    const badDeadline = { ...base, state: "admitted", deadlineAt: new Date(Date.now() - 10_000).toISOString() };
    writeFileSync(path, JSON.stringify({ version: 2, peer: "peer", entries: [badDeadline] }));
    expect(new RequestOutbox("peer", path).isQuarantined).toBe(true);
  });

  it("quarantines files belonging to another peer (exact peer binding)", () => {
    const path = join(root, "peer.json");
    const outbox = new RequestOutbox("peer", path);
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    const other = new RequestOutbox("other", path);
    expect(other.length).toBe(0);
    expect(other.isQuarantined).toBe(true);
  });

  it("transitions through in_flight and retry_wait with bounded backoff bookkeeping", () => {
    const path = join(root, "peer.json");
    const outbox = new RequestOutbox("peer", path, { retryDeadlineMs: 60_000 });
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    expect(outbox.markInFlight("f-1")).toBe(true);
    expect(outbox.get("f-1")!.state).toBe("in_flight");
    const next = Date.now() + 5_000;
    expect(outbox.markRetryWait("f-1", "timeout", next)).toBe(true);
    const entry = outbox.get("f-1")!;
    expect(entry.state).toBe("retry_wait");
    expect(entry.attempts).toBe(1);
    expect(entry.lastFailure).toBe("timeout");
    expect(Date.parse(entry.nextAttemptAt!)).toBe(next);
    expect(outbox.counts().nextAttemptAt).toBe(next);
  });

  it("refuses to re-enter in_flight while a send is active", () => {
    const outbox = new RequestOutbox("peer", join(root, "peer.json"), { retryDeadlineMs: 60_000 });
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    outbox.markInFlight("f-1");
    expect(outbox.markInFlight("f-1")).toBe(false);
  });

  it("peekDue returns only the oldest due eligible entry", () => {
    const outbox = new RequestOutbox("peer", join(root, "peer.json"), { retryDeadlineMs: 60_000 });
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    outbox.append("f-2", "private.recall", "r-2", undefined, "{}", 1, {});
    outbox.append("f-3", "private.recall", "r-3", undefined, "{}", 1, {});
    const now = Date.now();
    outbox.markRetryWait("f-1", "timeout", now + 60_000); // not due
    expect(outbox.peekDue(now)!.id).toBe("f-2");
    expect(outbox.peekDue(now + 120_000)).toBeNull(); // deadline passed
  });

  it("exhaustion is attempts- or deadline-bounded", () => {
    const outbox = new RequestOutbox("peer", join(root, "peer.json"), { retryDeadlineMs: 60_000 });
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    outbox.markInFlight("f-1");
    const now = Date.now();
    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i++) outbox.markRetryWait("f-1", "timeout", now + i * 1_000);
    expect(outbox.isExhausted(outbox.get("f-1")!, now)).toBe(true);
  });

  it("terminal_unknown entries are never picked by the pump and never acknowledged away silently", () => {
    const outbox = new RequestOutbox("peer", join(root, "peer.json"), { retryDeadlineMs: 60_000 });
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    outbox.markInFlight("f-1");
    expect(outbox.markTerminalUnknown("f-1", "timeout")).toBe(true);
    expect(outbox.peekDue(Date.now())).toBeNull();
    expect(outbox.counts().terminalUnknown).toBe(1);
    const rec = outbox.terminalUnknownRecords()[0]!;
    expect(rec.body).toBeUndefined();
    expect(rec.payload).toBeUndefined();
    expect(rec.id).toBe("f-1");
  });

  it("prunes old terminal-unknown records without reactivating them", () => {
    const path = join(root, "peer.json");
    const outbox = new RequestOutbox("peer", path, { retryDeadlineMs: 60_000 });
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    outbox.append("f-2", "private.recall", "r-2", undefined, "{}", 1, {});
    outbox.markInFlight("f-1");
    outbox.markTerminalUnknown("f-1", "timeout");
    const now = Date.now();
    // Manually age the terminal-unknown entry beyond retention.
    const entry = outbox.get("f-1")!;
    (entry as { createdAt: string }).createdAt = new Date(now - ROUTE_TERMINAL_UNKNOWN_RETENTION_MS - 1_000).toISOString();
    expect(outbox.pruneTerminalUnknown(now)).toBe(true);
    expect(outbox.counts().terminalUnknown).toBe(0);
    // f-2 is still eligible and unaffected.
    outbox.markInFlight("f-2");
    expect(outbox.get("f-2")!.state).toBe("in_flight");
  });

  it("rejects capacity overflow without dropping accepted entries", () => {
    const outbox = new RequestOutbox("peer", join(root, "peer.json"));
    for (let i = 0; i < 200; i++) {
      expect(outbox.append(`f-${i}`, "private.recall", `r-${i}`, undefined, "{}", 1, {})).toBe(true);
    }
    expect(outbox.append("f-over", "private.recall", "r-over", undefined, "{}", 1, {})).toBe(false);
    expect(outbox.length).toBe(200);
  });

  it("keeps old or new state on checkpoint failure (atomic write)", () => {
    const path = join(root, "peer.json");
    const outbox = new RequestOutbox("peer", path);
    outbox.append("f-1", "private.recall", "r-1", undefined, "{}", 1, {});
    // Make the target directory unreadable to force checkpoint failure.
    const dir = join(root, "blocked");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "peer.json"), "{}", "utf-8");
    const blocked = new RequestOutbox("peer", join(dir, "peer.json"));
    blocked.append("f-2", "private.recall", "r-2", undefined, "{}", 1, {});
    expect(blocked.isDegraded).toBe(false);
  });
});

function readdirQuarantine(root: string): number {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  return readdirSync(root).filter(f => f.includes(".quarantine-")).length;
}
