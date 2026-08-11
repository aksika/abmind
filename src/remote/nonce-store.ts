import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { abmindHome } from "../mem-paths.js";
import { requireNativeDep } from "../../cli/lib/native-dep.js";

const NONCE_TTL_MS = 60_000;
const WSS_TABLE = "wss_request_nonces";

let _Database: any = null;

function getDb(): any {
  if (!_Database) {
    _Database = requireNativeDep("better-sqlite3");
  }
  return _Database;
}

export interface NonceClaimResultOk { ok: true }
export interface NonceClaimResultReplay { ok: false; reason: "replay" }
export interface NonceClaimResultStoreError { ok: false; reason: "store_error" }
export type NonceClaimResult = NonceClaimResultOk | NonceClaimResultReplay | NonceClaimResultStoreError;

export class NonceStore {
  private db: any;

  constructor(dbPath?: string) {
    const Database = getDb();
    const path = dbPath ?? join(abmindHome(), "remote", "nonces.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS ${WSS_TABLE} (
        peer_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        seen_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (peer_id, nonce)
      )`
    );
    try {
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_nonces_expires ON ${WSS_TABLE}(expires_at)`);
    } catch { /* best effort */ }
  }

  claim(peerId: string, nonce: string, nowMs?: number): NonceClaimResult {
    try {
      this.db.prepare(`DELETE FROM ${WSS_TABLE} WHERE expires_at < ?`).run(Date.now());
    } catch { return { ok: false, reason: "store_error" }; }

    const now = nowMs ?? Date.now();
    try {
      this.db.prepare(
        `INSERT INTO ${WSS_TABLE} (peer_id, nonce, seen_at, expires_at) VALUES (?, ?, ?, ?)`
      ).run(peerId, nonce, now, now + NONCE_TTL_MS);
      return { ok: true };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e?.code === "SQLITE_CONSTRAINT" || e?.message?.includes("UNIQUE")) {
        return { ok: false, reason: "replay" };
      }
      return { ok: false, reason: "store_error" };
    }
  }

  prune(): void {
    try { this.db.prepare(`DELETE FROM ${WSS_TABLE} WHERE expires_at < ?`).run(Date.now()); } catch { /* best effort */ }
  }

  close(): void {
    try { this.db.close(); } catch { /* best effort */ }
  }
}
