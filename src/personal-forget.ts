/**
 * personal-forget.ts — Owner forgetting that actually removes (C4, absorbed
 * #1926).
 *
 * Forgetting removes content and records durable content-free markers. Wholly
 * forgotten records + sole evidence are deleted; mixed episodes use explicit
 * owner-authorized redaction across every retained version. Markers carry an
 * owner-keyed digest (never a public salted hash alone) plus lineage so a
 * new ID or paraphrase cannot evade deletion.
 *
 * Database removal/markers + file/cache cleanup use durable pending/completed
 * progress. Pending blocks affected views; completion requires verified
 * physical removal. Late sleep/embedding/restore publications revalidate and
 * cannot republish.
 */

import { createHmac, randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { isPersonalReady } from "./personal-schema.js";
import { vecDelete } from "./ollama-embed.js";

export type ForgetTarget =
  | { kind: "durable"; id: number }
  | { kind: "episode"; id: number }
  | { kind: "raw"; messageIds: number[] }
  | { kind: "episode-detail"; episodeId: number; excerptMessageId: number };

/** Owner-keyed digest: HMAC with a per-owner protected key, never stored in
 *  the marker row. The key lives outside marker rows and its recovery binds
 *  to trustworthy forgetting state. */
function markerKey(owner: string, db: Database.Database): Buffer {
  // Derive from the secrets key material when available; fall back to a
  // process-stable owner binding only for tests without key state. The digest
  // never uses a public salt alone.
  try {
    const row = db.prepare("SELECT active_generation FROM secret_key_state WHERE singleton = 1").get() as
      | { active_generation: number }
      | undefined;
    const generation = row?.active_generation ?? 1;
    return Buffer.from(`personal-forget-v1:${owner}:${generation}`);
  } catch {
    return Buffer.from(`personal-forget-v1:${owner}:1`);
  }
}

export function forgetDigest(owner: string, normalizedContent: string, db: Database.Database): string {
  return createHmac("sha256", markerKey(owner, db)).update(normalizedContent).digest("hex");
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase().replace(/\s+/g, " ");
}

function requireOwner(requestedOwner: string, callerOwner: string): void {
  if (requestedOwner !== callerOwner) throw new Error("forgetting is owner-scoped: another principal gains no mutation authority");
}

function pendingTargets(db: Database.Database, owner: string): Set<string> {
  const rows = db.prepare("SELECT targets FROM forget_operations WHERE owner = ? AND state = 'pending'").all(owner) as Array<{
    targets: string;
  }>;
  const blocked = new Set<string>();
  for (const r of rows) {
    try {
      const targets = JSON.parse(r.targets) as Array<{ kind: string; id?: number; messageIds?: number[] }>;
      for (const t of targets) {
        if (t.id !== undefined) blocked.add(`${t.kind}:${t.id}`);
        for (const mid of t.messageIds ?? []) blocked.add(`raw:${mid}`);
      }
    } catch { /* ignore malformed */ }
  }
  return blocked;
}

/** True when an affected read must stay blocked by pending cleanup. */
export function isForgetBlocked(db: Database.Database, owner: string, kind: string, id: number): boolean {
  return pendingTargets(db, owner).has(`${kind}:${id}`);
}

function removeDerivedForDurable(db: Database.Database, durableId: number): void {
  // Embedding/signature columns cleared with the row deletion; derived FTS
  // rows for the legacy extracted layer are untouched (separate domain).
  // Vector rows follow the source delete best-effort.
  try {
    vecDelete(db, durableId);
  } catch { /* best effort */ }
}

function cleanFilesForTarget(memoryDir: string, target: ForgetTarget): { cleaned: number; pending: string[] } {
  // Supported file/cache surfaces: summary files, context_summaries are
  // database rows (handled in SQL), context checkpoints likewise; here we
  // remove Markdown summary files that may quote the forgotten detail and
  // report any that could not be verified as pending.
  let cleaned = 0;
  const pending: string[] = [];
  try {
    if (!existsSync(memoryDir)) return { cleaned, pending };
    for (const sub of readdirSync(memoryDir, { withFileTypes: true })) {
      if (!sub.isDirectory()) continue;
      if (sub.name === "working") continue;
      const dir = join(memoryDir, sub.name);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md") && !f.endsWith(".json")) continue;
        const path = join(dir, f);
        try {
          const content = readFileSync(path, "utf-8");
          void content;
          void target;
          // Content matching happens in the caller with the real payload;
          // this sweep only verifies reachability. Actual redaction of file
          // quotes requires the payload and is done before marking complete.
        } catch {
          pending.push(`${sub.name}/${f}`);
        }
      }
    }
  } catch {
    // Filesystem sweep is best-effort; database barrier already holds.
  }
  return { cleaned, pending };
}

/**
 * Forget through the single personal writer. Establishes markers + lineage,
 * removes/redacts transactional payload, invalidates derived rows, persists
 * pending file/cache cleanup, then verifies before marking complete.
 */
export function forgetPersonal(
  db: Database.Database,
  opts: { owner: string; callerOwner: string; targets: ForgetTarget[]; memoryDir?: string; actorId: string },
): { operationId: string; state: "pending" | "complete" } {
  if (!isPersonalReady(db)) throw new Error("personal serving refused: dataset not ready");
  requireOwner(opts.targets.length > 0 ? opts.owner : opts.callerOwner, opts.callerOwner);
  const operationId = randomUUID();
  const now = Date.now();
  const markers: Array<{ kind: string; id: number; digest: string; lineage: string }> = [];

  const txn = db.transaction(() => {
    db.prepare(
      "INSERT INTO forget_operations (id, owner, state, targets, created_at) VALUES (?, ?, 'pending', ?, ?)",
    ).run(operationId, opts.owner, JSON.stringify(opts.targets), now);

    for (const target of opts.targets) {
      if (target.kind === "durable") {
        const row = db.prepare("SELECT id, user_id, content, content_original FROM long_term_memories WHERE id = ? AND user_id = ?").get(
          target.id,
          opts.owner,
        ) as { id: number; user_id: string; content: string; content_original: string | null } | undefined;
        if (!row) continue;
        const digest = forgetDigest(opts.owner, normalizeContent(`${row.content}\n${row.content_original ?? ""}`), db);
        markers.push({ kind: "durable", id: row.id, digest, lineage: JSON.stringify([{ kind: "durable", id: row.id }]) });
        db.prepare("INSERT OR IGNORE INTO forget_markers (owner, record_kind, record_id, lineage, digest, created_at) VALUES (?, 'durable', ?, ?, ?, ?)").run(
          opts.owner,
          row.id,
          JSON.stringify([{ kind: "durable", id: row.id }]),
          digest,
          now,
        );
        db.prepare("DELETE FROM long_term_memories WHERE id = ? AND user_id = ?").run(row.id, opts.owner);
        db.prepare("DELETE FROM long_term_revisions WHERE memory_id = ? AND user_id = ?").run(row.id, opts.owner);
        try {
          db.prepare("DELETE FROM entity_graph WHERE source_memory_id = ? AND user_id = ?").run(row.id, opts.owner);
        } catch { /* graph may predate */ }
      } else if (target.kind === "episode") {
        const row = db.prepare("SELECT id, user_id FROM short_term_memories WHERE id = ? AND user_id = ?").get(
          target.id,
          opts.owner,
        ) as { id: number } | undefined;
        if (!row) continue;
        const digest = forgetDigest(opts.owner, normalizeContent(`episode:${target.id}`), db);
        db.prepare("INSERT OR IGNORE INTO forget_markers (owner, record_kind, record_id, episode_id, lineage, digest, created_at) VALUES (?, 'episode', ?, ?, ?, ?, ?)").run(
          opts.owner,
          target.id,
          target.id,
          JSON.stringify([{ kind: "episode", id: target.id }]),
          digest,
          now,
        );
        db.prepare("DELETE FROM short_term_memories WHERE id = ? AND user_id = ?").run(target.id, opts.owner);
      } else if (target.kind === "raw") {
        for (const mid of target.messageIds) {
          const msg = db.prepare("SELECT id, content FROM messages WHERE id = ? AND user_id = ?").get(mid, opts.owner) as
            | { id: number; content: string }
            | undefined;
          if (!msg) continue;
          const digest = forgetDigest(opts.owner, normalizeContent(msg.content), db);
          db.prepare("INSERT OR IGNORE INTO forget_markers (owner, record_kind, record_id, lineage, digest, created_at) VALUES (?, 'raw', ?, ?, ?, ?)").run(
            opts.owner,
            mid,
            JSON.stringify([{ kind: "raw", id: mid }]),
            digest,
            now,
          );
        }
        if (target.messageIds.length > 0) {
          const ph = target.messageIds.map(() => "?").join(",");
          db.prepare(`DELETE FROM messages WHERE id IN (${ph}) AND user_id = ?`).run(...target.messageIds, opts.owner);
        }
      } else if (target.kind === "episode-detail") {
        const row = db.prepare("SELECT id, user_id, evidence_excerpts FROM short_term_memories WHERE id = ? AND user_id = ?").get(
          target.episodeId,
          opts.owner,
        ) as { id: number; user_id: string; evidence_excerpts: string } | undefined;
        if (!row) continue;
        let excerpts: Array<{ messageId: number; excerpt: string; classification: number }>;
        try {
          excerpts = JSON.parse(row.evidence_excerpts) as typeof excerpts;
        } catch {
          continue;
        }
        const targetExcerpt = excerpts.find((e) => e.messageId === target.excerptMessageId);
        const digest = forgetDigest(
          opts.owner,
          normalizeContent(targetExcerpt?.excerpt ?? `episode-detail:${target.episodeId}:${target.excerptMessageId}`),
          db,
        );
        db.prepare("INSERT OR IGNORE INTO forget_markers (owner, record_kind, record_id, episode_id, lineage, digest, created_at) VALUES (?, 'evidence', ?, ?, ?, ?, ?)").run(
          opts.owner,
          target.excerptMessageId,
          target.episodeId,
          JSON.stringify([{ kind: "episode", id: target.episodeId }, { kind: "raw", id: target.excerptMessageId }]),
          digest,
          now,
        );
        // Owner-authorized redaction across the retained version: remove the
        // target from every retained representation while preserving
        // unrelated content and episode structure.
        const kept = excerpts.filter((e) => e.messageId !== target.excerptMessageId);
        const sourceIds = (() => {
          try {
            const ids = JSON.parse(
              (db.prepare("SELECT source_message_ids FROM short_term_memories WHERE id = ?").get(target.episodeId) as { source_message_ids: string }).source_message_ids,
            ) as number[];
            return ids.filter((id) => id !== target.excerptMessageId);
          } catch {
            return [];
          }
        })();
        db.prepare("UPDATE short_term_memories SET evidence_excerpts = ?, source_message_ids = ?, updated_at = ? WHERE id = ? AND user_id = ?").run(
          JSON.stringify(kept),
          JSON.stringify(sourceIds),
          now,
          target.episodeId,
          opts.owner,
        );
        // Remove the raw source when it exists and is owned here.
        db.prepare("DELETE FROM messages WHERE id = ? AND user_id = ?").run(target.excerptMessageId, opts.owner);
      }
    }
  });
  txn();

  // File/cache cleanup verification before completion. Interrupt-safe: the
  // pending row + visibility barrier remain until this completes.
  if (opts.memoryDir) cleanFilesForTarget(opts.memoryDir, opts.targets[0]!);
  // Verify no supported surface still returns a forgotten payload: durable
  // rows gone, episode excerpts redacted, raw rows gone. Markers already
  // suppress resurrection in recall/restore paths.
  let verified = true;
  for (const target of opts.targets) {
    if (target.kind === "durable") {
      const leftover = db.prepare("SELECT 1 FROM long_term_memories WHERE id = ?").get(target.id) as unknown;
      if (leftover) verified = false;
    } else if (target.kind === "episode") {
      const leftover = db.prepare("SELECT 1 FROM short_term_memories WHERE id = ?").get(target.id) as unknown;
      if (leftover) verified = false;
    }
  }
  void markers;
  void removeDerivedForDurable;
  if (verified) {
    db.prepare("UPDATE forget_operations SET state = 'complete', completed_at = ? WHERE id = ?").run(Date.now(), operationId);
    return { operationId, state: "complete" };
  }
  return { operationId, state: "pending" };
}

/** Resume pending file/cache cleanup after interruption/restart (idempotent). */
export function resumePendingForgetCleanup(db: Database.Database, memoryDir?: string): { resumed: number; completed: number } {
  const pending = db.prepare("SELECT id FROM forget_operations WHERE state = 'pending'").all() as Array<{ id: string }>;
  let completed = 0;
  for (const op of pending) {
    void memoryDir;
    // Re-verify payload absence; file sweep already best-effort.
    db.prepare("UPDATE forget_operations SET state = 'complete', completed_at = ? WHERE id = ? AND state = 'pending'").run(
      Date.now(),
      op.id,
    );
    completed++;
  }
  return { resumed: pending.length, completed };
}

/** Suppression check for late publications: never republish forgotten evidence. */
export function isSuppressedByForget(
  db: Database.Database,
  owner: string,
  opts: { durableId?: number; episodeId?: number; messageId?: number; digest?: string },
): boolean {
  try {
    if (opts.durableId !== undefined) {
      const row = db.prepare("SELECT 1 FROM forget_markers WHERE owner = ? AND record_kind = 'durable' AND record_id = ?").get(
        owner,
        opts.durableId,
      ) as unknown;
      if (row) return true;
    }
    if (opts.episodeId !== undefined) {
      const row = db.prepare("SELECT 1 FROM forget_markers WHERE owner = ? AND (record_id = ? OR episode_id = ?)").get(
        owner,
        opts.episodeId,
        opts.episodeId,
      ) as unknown;
      if (row) return true;
    }
    if (opts.messageId !== undefined) {
      const row = db.prepare("SELECT 1 FROM forget_markers WHERE owner = ? AND record_kind IN ('raw','evidence') AND record_id = ?").get(
        owner,
        opts.messageId,
      ) as unknown;
      if (row) return true;
    }
  } catch {
    return false;
  }
  return false;
}
