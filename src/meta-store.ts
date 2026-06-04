/**
 * meta-store.ts — Read/write system metadata from _meta table (#447).
 * Single-row INSERT OR REPLACE per key. Zero overhead.
 */

import type Database from "better-sqlite3";

export function metaGet(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function metaGetInt(db: Database.Database, key: string): number | null {
  const v = metaGet(db, key);
  return v !== null ? parseInt(v, 10) : null;
}

export function metaSet(db: Database.Database, key: string, value: string | number): void {
  db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run(key, String(value));
}

export function metaIncrement(db: Database.Database, key: string): void {
  const current = metaGetInt(db, key) ?? 0;
  metaSet(db, key, current + 1);
}
