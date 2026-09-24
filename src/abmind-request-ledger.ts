import type Database from "better-sqlite3";
import type { AbmindMethod, AbmindResponseV1 } from "./abmind-protocol.js";
import { logWarn } from "./mem-logger.js";
import { fingerprint } from "./request-fingerprint.js";

// ── Idempotency ledger ──────────────────────────────────────────────────────
// Extracted verbatim from abmind-service.ts (#1695). SQL, state meanings,
// crash recovery, and cleanup are identical; only the module changed.

export type ReservationResult =
  | { status: "completed"; responseJson: string }
  | { status: "conflict"; message: string }
  | { status: "in_flight" }
  | { status: "outcome_unknown" }
  | { status: "reserved" };

/** In-process ownership of one live mutation dispatch (#1659). Content-free. */
export type InFlightMutation = {
  readonly method: AbmindMethod;
  readonly payloadHash: string;
  readonly outcome: Promise<AbmindResponseV1>;
};

export class AbmindRequestLedger {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  reserve(principalId: string, idempotencyKey: string, method: string, payloadHash: string): ReservationResult {
    const existing = this.db.prepare(`
      SELECT method, payload_hash, state, response_json, created_at, updated_at FROM abmind_service_requests
      WHERE principal_id = ? AND idempotency_key = ?
    `).get(principalId, idempotencyKey) as { method: string; payload_hash: string; state: string; response_json: string | null; created_at: number; updated_at: number } | undefined;
    if (existing) {
      if (existing.method !== method || existing.payload_hash !== payloadHash) {
        const rowAge = Date.now() - existing.created_at;
        const existingPrefix = existing.payload_hash.slice(0, 8);
        const incomingPrefix = payloadHash.slice(0, 8);
        const keyFingerprint = fingerprint(idempotencyKey, 8);
        const principalFingerprint = fingerprint(principalId, 8);
        logWarn("request-ledger", `Conflict: method=${existing.method}→${method} key=${keyFingerprint}.. principal=${principalFingerprint}.. existing_hash=${existingPrefix}.. incoming_hash=${incomingPrefix}.. state=${existing.state} age=${rowAge}ms`);
        return { status: "conflict", message: "Idempotency key used with different method or payload" };
      }
      if (existing.state === "completed") {
        return { status: "completed", responseJson: existing.response_json! };
      }
      if (existing.state === "in_flight") {
        return { status: "in_flight" };
      }
      // reserved / dispatch_started / outcome_unknown rows are not live in
      // this process: the mutation may or may not have committed.
      return { status: "outcome_unknown" };
    }

    const now = Date.now();
    try {
      this.db.prepare(`
        INSERT INTO abmind_service_requests (principal_id, idempotency_key, method, payload_hash, state, response_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'reserved', NULL, ?, ?)
      `).run(principalId, idempotencyKey, method, payloadHash, now, now);
      return { status: "reserved" };
    } catch {
      return { status: "outcome_unknown" };
    }
  }

  markStarted(principalId: string, idempotencyKey: string): boolean {
    try {
      const result = this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'in_flight', updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ? AND state = 'reserved'
      `).run(Date.now(), principalId, idempotencyKey);
      return result.changes === 1;
    } catch {
      return false;
    }
  }

  complete(principalId: string, idempotencyKey: string, responseJson: string): boolean {
    try {
      const result = this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'completed', response_json = ?, updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ? AND state = 'in_flight'
      `).run(responseJson, Date.now(), principalId, idempotencyKey);
      return result.changes === 1;
    } catch {
      return false;
    }
  }

  markUnknown(principalId: string, idempotencyKey: string): boolean {
    try {
      const result = this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'outcome_unknown', updated_at = ?
      WHERE principal_id = ? AND idempotency_key = ? AND state IN ('reserved', 'dispatch_started', 'in_flight')
      `).run(Date.now(), principalId, idempotencyKey);
      if (result.changes === 1) return true;
      const row = this.db.prepare(
        "SELECT state FROM abmind_service_requests WHERE principal_id = ? AND idempotency_key = ?",
      ).get(principalId, idempotencyKey) as { state: string } | undefined;
      return row?.state === "outcome_unknown";
    } catch {
      return false;
    }
  }

  /** Transition rows left in flight by a crash to durable unknown tombstones. */
  recoverCrashed(): void {
    const result = this.db.prepare(`
      UPDATE abmind_service_requests SET state = 'outcome_unknown', updated_at = ?
      WHERE state = 'in_flight' OR state = 'dispatch_started' OR state = 'reserved'
    `).run(Date.now());
    const tombstones = this.db.prepare("SELECT COUNT(*) as c FROM abmind_service_requests WHERE state = 'outcome_unknown'").get() as { c: number };
    if (result.changes > 0 || tombstones.c > 0) {
      logWarn("request-ledger", `Recovered ${result.changes} crashed dispatch(es); ${tombstones.c} outcome_unknown tombstone(s) retained (never reusable)`);
    }
  }

  cleanup(): void {
    const cutoff = Date.now() - 30 * 24 * 3600_000;
    this.db.prepare(`
      DELETE FROM abmind_service_requests WHERE state = 'completed' AND updated_at < ?
    `).run(cutoff);

    const count = this.db.prepare("SELECT COUNT(*) as c FROM abmind_service_requests WHERE state = 'completed'").get() as { c: number };
    if (count.c > 10000) {
      this.db.prepare(`
        DELETE FROM abmind_service_requests WHERE rowid IN (
          SELECT rowid FROM abmind_service_requests WHERE state = 'completed'
          ORDER BY updated_at ASC LIMIT ?
        )
      `).run(count.c - 10000);
    }
  }
}
