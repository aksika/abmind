/** Personal forgetting: guarded database removal, durable cleanup and replay barriers. */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { deriveKey, hasKey, loadKey } from "./crypto.js";
import { getAbmindEnv } from "./env-schema.js";
import { isPersonalReady } from "./personal-schema.js";
import { parseArtifactOwner } from "./sleep/sleep-daily-summary.js";
import { vecDelete } from "./ollama-embed.js";
import { reconcileServingDocuments } from "./recall-projection-build.js";

export type ForgetTarget =
  | { kind: "durable"; id: number }
  | { kind: "episode"; id: number }
  | { kind: "raw"; messageIds: number[] }
  | { kind: "episode-detail"; episodeId: number; excerptMessageId: number };
type Link = { kind: string; id: number; digest?: string };
type Marker = { record_kind: string; record_id: number; episode_id: number | null; lineage: string; digest: string; key_generation: number };

/**
 * Forgetting key lifecycle.
 *
 * Marker digests are HMACs under per-owner/per-generation ring keys kept in
 * `forget_key_ring`, each wrapped (AES-256-GCM, nonce alongside) under a
 * master-derived wrapping key. Key rotation re-wraps the ring instead of
 * losing it, so digests stay verifiable across rotations without ever
 * storing content. Markers pre-dating the ring (no entry for their
 * generation) fall back to the legacy master derivation and become
 * lineage-only after a rotation — documented, and empty in practice since
 * forgetting never shipped to live hosts.
 */
export const FORGET_RING_PURPOSE = "abmind-forget-ring-v1";
const LEGACY_FORGET_PURPOSE = "abmind-personal-forget-v1:";
const GCM_TAG_LEN = 16;
const GCM_NONCE_LEN = 12;

function activeGeneration(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT active_generation FROM secret_key_state WHERE singleton = 1").get() as
      | { active_generation: number } | undefined;
    return row?.active_generation ?? 1;
  } catch {
    return 1;
  }
}

function hasKeyMaterial(): boolean {
  return hasKey() || !!process.env["ABMIND_KEY"] || existsSync(join(dirname(getAbmindEnv().keyFile), "key.verify"));
}

function wrappingKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, "", FORGET_RING_PURPOSE, 32));
}

function wrapRingKey(key: Buffer, master: Buffer): { wrapped: Buffer; nonce: Buffer } {
  const nonce = randomBytes(GCM_NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", wrappingKey(master), nonce);
  const ct = Buffer.concat([cipher.update(key), cipher.final(), cipher.getAuthTag()]);
  return { wrapped: ct, nonce };
}

function unwrapRingKey(wrapped: Buffer, nonce: Buffer, master: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", wrappingKey(master), nonce);
  decipher.setAuthTag(wrapped.subarray(wrapped.length - GCM_TAG_LEN));
  return Buffer.concat([decipher.update(wrapped.subarray(0, wrapped.length - GCM_TAG_LEN)), decipher.final()]);
}

/** Read-only ring lookup; null when this generation has no entry. A wrong
 *  master yields null (callers fall back and fail closed with an observable
 *  refusal) rather than a raw cipher error; post-commit rotation
 *  verification checks unwrapping explicitly instead. */
export function ringKeyFor(db: Database.Database, owner: string, generation: number, master: Buffer): Buffer | null {
  let row: { wrapped_key: Buffer; nonce: Buffer } | undefined;
  try {
    row = db.prepare("SELECT wrapped_key, nonce FROM forget_key_ring WHERE owner = ? AND generation = ?").get(owner, generation) as
      | { wrapped_key: Buffer; nonce: Buffer } | undefined;
  } catch {
    return null;
  }
  if (!row) return null;
  try {
    return unwrapRingKey(row.wrapped_key, row.nonce, master);
  } catch {
    return null;
  }
}

/**
 * Get-or-create the ring key for the active generation (write path — call
 * inside the caller's transaction before computing digests). Throws when no
 * master key is available: forgetting is fail-closed without one.
 */
export function ensureForgetRingKey(db: Database.Database, owner: string): Buffer {
  const master = loadKey();
  const generation = activeGeneration(db);
  const existing = ringKeyFor(db, owner, generation, master);
  if (existing) return existing;
  const key = randomBytes(32);
  const { wrapped, nonce } = wrapRingKey(key, master);
  db.prepare("INSERT OR IGNORE INTO forget_key_ring (owner, generation, wrapped_key, nonce, created_at) VALUES (?, ?, ?, ?, ?)").run(
    owner, generation, wrapped, nonce, Date.now(),
  );
  const reread = ringKeyFor(db, owner, generation, master);
  if (!reread) throw new Error("forget ring key not durable");
  return reread;
}

export function forgetDigest(owner: string, content: string, _db: Database.Database): string {
  if (markers(_db, owner).length && !hasKeyMaterial()) throw new Error("authoritative forgetting key is unavailable");
  const master = loadKey();
  const key = ringKeyFor(_db, owner, activeGeneration(_db), master) ?? deriveKey(LEGACY_FORGET_PURPOSE + owner);
  return createHmac("sha256", key).update(normalize(content)).digest("hex");
}

/** Digest of content under one marker generation; null when unavailable. */
export function forgetDigestForGeneration(db: Database.Database, owner: string, content: string, generation: number): string | null {
  let master: Buffer;
  try {
    master = loadKey();
  } catch {
    return null;
  }
  const key = ringKeyFor(db, owner, generation, master) ?? deriveKey(LEGACY_FORGET_PURPOSE + owner);
  return createHmac("sha256", key).update(normalize(content)).digest("hex");
}

/**
 * Candidate digests of content across every generation this owner has
 * markers for, so suppression survives rotation. Throws when markers exist
 * but no key material is available (fail closed, never silently unblocked).
 */
export function candidateForgetDigests(db: Database.Database, owner: string, content: string): Set<string> {
  if (markers(db, owner).length && !hasKeyMaterial()) throw new Error("authoritative forgetting key is unavailable");
  const gens = db.prepare("SELECT DISTINCT key_generation AS gen FROM forget_markers WHERE owner = ?").all(owner) as Array<{ gen: number }>;
  const out = new Set<string>();
  if (!gens.length) {
    out.add(forgetDigest(owner, content, db));
    return out;
  }
  for (const { gen } of gens) {
    const digest = forgetDigestForGeneration(db, owner, content, gen);
    if (digest) out.add(digest);
  }
  if (!out.size) throw new Error("authoritative forgetting key is unavailable");
  return out;
}
function normalize(content: string): string { return content.trim().toLowerCase().replace(/\s+/g, " "); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function links(raw: string): Link[] {
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || data.some(x => !object(x) || typeof x["kind"] !== "string" || !Number.isSafeInteger(x["id"]))) throw new Error("forget lineage is invalid");
  return data as Link[];
}
function markers(db: Database.Database, owner: string): Marker[] {
  return db.prepare("SELECT record_kind, record_id, episode_id, lineage, digest, key_generation FROM forget_markers WHERE owner = ?").all(owner) as Marker[];
}
function pending(db: Database.Database, owner: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM forget_operations WHERE owner = ? AND state = 'pending' LIMIT 1").get(owner));
}
export function isForgetBlocked(db: Database.Database, owner: string, _kind: string, _id: number): boolean {
  return pending(db, owner);
}
function sourceLinks(evidence: unknown): Link[] {
  if (!Array.isArray(evidence)) throw new Error("invalid personal evidence");
  const found: Link[] = [];
  for (const e of evidence) {
    if (!object(e) || typeof e["ref"] !== "string") continue;
    const raw = /^(?:messages:)?([1-9]\d*)$/.exec(e["ref"]);
    const legacy = /^extracted_memories:([1-9]\d*)$/.exec(e["ref"]);
    if (raw) found.push({ kind: "raw", id: Number(raw[1]) });
    if (legacy) found.push({ kind: "legacy", id: Number(legacy[1]) });
  }
  return found;
}
export function isSuppressedByForget(
  db: Database.Database,
  owner: string,
  opts: { durableId?: number; episodeId?: number; messageId?: number; digest?: string; content?: string; evidence?: unknown },
): boolean {
  const all = markers(db, owner);
  if (!all.length) return pending(db, owner);
  const wanted: Link[] = [];
  if (opts.durableId !== undefined) wanted.push({ kind: "durable", id: opts.durableId });
  if (opts.episodeId !== undefined) wanted.push({ kind: "episode", id: opts.episodeId });
  if (opts.messageId !== undefined) wanted.push({ kind: "raw", id: opts.messageId });
  if (opts.evidence !== undefined) wanted.push(...sourceLinks(opts.evidence));
  const digests = opts.digest !== undefined
    ? new Set([opts.digest])
    : opts.content !== undefined ? candidateForgetDigests(db, owner, opts.content) : undefined;
  return all.some(m => {
    if (digests && [...digests].some(digest => digest === m.digest)) return true;
    const lineage = links(m.lineage);
    if (digests && lineage.some(l => l.digest !== undefined && digests.has(l.digest))) return true;
    // A detail marker does not suppress the surviving mixed episode itself.
    if (m.record_kind !== "evidence") lineage.push({ kind: m.record_kind, id: m.record_id });
    return wanted.some(w => lineage.some(l => l.kind === w.kind && l.id === w.id));
  }) || pending(db, owner);
}

function removeDurable(db: Database.Database, owner: string, id: number): void {
  db.prepare("DELETE FROM long_term_revisions WHERE memory_id = ? AND user_id = ?").run(id, owner);
  db.prepare("DELETE FROM long_term_memories WHERE id = ? AND user_id = ?").run(id, owner);
}
/** Reapply authoritative markers after restore, before restored content is visible. */
export function enforceForgetMarkers(db: Database.Database, owner: string): void {
  const all = markers(db, owner);
  if (!all.length) return;
  const roots = all.flatMap(m => [...links(m.lineage), { kind: m.record_kind === "evidence" ? "raw" : m.record_kind, id: m.record_id }]);
  const rawIds = new Set(roots.filter(l => l.kind === "raw").map(l => l.id));
  const durableIds = new Set(roots.filter(l => l.kind === "durable").map(l => l.id));
  const episodeIds = new Set(all.filter(m => m.record_kind === "episode").map(m => m.record_id));
  const legacyIds = new Set(roots.filter(l => l.kind === "legacy").map(l => l.id));
  const digests = new Set([...all.map(m => m.digest), ...roots.flatMap(l => l.digest ? [l.digest] : [])]);
  const durables = db.prepare("SELECT id, content, evidence, provenance FROM long_term_memories WHERE user_id = ?").all(owner) as Array<{ id: number; content: string; evidence: string; provenance: string }>;
  for (const row of durables) {
    const evidence: unknown = JSON.parse(row.evidence);
    const provenance: unknown = JSON.parse(row.provenance);
    const refs = sourceLinks(evidence);
    if (durableIds.has(row.id) || refs.some(l => (l.kind === "raw" && rawIds.has(l.id)) || (l.kind === "legacy" && legacyIds.has(l.id))) ||
      (object(provenance) && ((typeof provenance["episodeId"] === "number" && episodeIds.has(provenance["episodeId"])) ||
        (typeof provenance["scopedExceptionOf"] === "number" && durableIds.has(provenance["scopedExceptionOf"])))) ||
      [...candidateForgetDigests(db, owner, row.content)].some(digest => digests.has(digest))) removeDurable(db, owner, row.id);
  }
  const history = db.prepare("SELECT id, content, evidence FROM long_term_revisions WHERE user_id = ?").all(owner) as Array<{ id: number; content: string; evidence: string }>;
  for (const row of history) {
    const refs = sourceLinks(JSON.parse(row.evidence));
    if (refs.some(l => (l.kind === "raw" && rawIds.has(l.id)) || (l.kind === "legacy" && legacyIds.has(l.id))) ||
      [...candidateForgetDigests(db, owner, row.content)].some(digest => digests.has(digest))) db.prepare("DELETE FROM long_term_revisions WHERE id = ? AND user_id = ?").run(row.id, owner);
  }
  const episodes = db.prepare("SELECT id, source_message_ids, evidence_excerpts FROM short_term_memories WHERE user_id = ?").all(owner) as Array<{ id: number; source_message_ids: string; evidence_excerpts: string }>;
  for (const row of episodes) {
    if (episodeIds.has(row.id)) {
      db.prepare("DELETE FROM personal_grouping_ledger WHERE episode_id = ? AND user_id = ?").run(row.id, owner);
      db.prepare("UPDATE short_term_memories SET prev_episode_id = NULL WHERE prev_episode_id = ? AND user_id = ?").run(row.id, owner);
      db.prepare("UPDATE short_term_memories SET next_episode_id = NULL WHERE next_episode_id = ? AND user_id = ?").run(row.id, owner);
      db.prepare("DELETE FROM short_term_memories WHERE id = ? AND user_id = ?").run(row.id, owner);
      continue;
    }
    const ids: unknown = JSON.parse(row.source_message_ids), evidence: unknown = JSON.parse(row.evidence_excerpts);
    if (!Array.isArray(ids) || !Array.isArray(evidence)) throw new Error("invalid episode evidence during forget");
    if (!ids.some(id => typeof id === "number" && rawIds.has(id))) continue;
    const kept = evidence.filter(e => !object(e) || typeof e["messageId"] !== "number" || !rawIds.has(e["messageId"]));
    db.prepare("UPDATE short_term_memories SET source_message_ids = ?, evidence_excerpts = ?, topic = 'redacted discussion', outcomes = NULL, unresolved = NULL, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(JSON.stringify(ids.filter(id => typeof id === "number" && !rawIds.has(id))), JSON.stringify(kept), Date.now(), row.id, owner);
  }
  for (const row of db.prepare("SELECT id, source_message_ids FROM extracted_memories WHERE user_id = ?").all(owner) as Array<{ id: number; source_message_ids: string | null }>) {
    const ids: unknown = JSON.parse(row.source_message_ids ?? "[]");
    if (!Array.isArray(ids)) throw new Error("invalid legacy evidence during forget");
    if (legacyIds.has(row.id) || ids.some(id => typeof id === "number" && rawIds.has(id))) {
      db.prepare("DELETE FROM entity_graph WHERE source_memory_id = ? AND user_id = ?").run(row.id, owner);
      db.prepare("DELETE FROM extracted_memories WHERE id = ? AND user_id = ?").run(row.id, owner);
      vecDelete(db, row.id);
    }
  }
  for (const id of rawIds) db.prepare("DELETE FROM messages WHERE id = ? AND user_id = ?").run(id, owner);
  // Cumulative artifacts lack per-fact lineage. Invalidate the owner's
  // projection rather than retain a paraphrased payload.
  db.prepare("DELETE FROM active_context_checkpoint WHERE chat_id = ?").run(owner);
  db.prepare("DELETE FROM context_checkpoints WHERE chat_id = ?").run(owner);
  db.prepare("DELETE FROM context_summaries WHERE chat_id = ?").run(owner);
  // #1928 M2: the retrieval projection is pruned and refilled in the same
  // forget transaction — suppression is synchronous with the forget barrier,
  // and redacted episode remainders are re-indexed, never resurrected.
  reconcileServingDocuments(db, owner);
}

function memoryDirectory(db: Database.Database, supplied?: string): string | undefined {
  const main = (db.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(x => x.name === "main");
  const directory = main?.file ? dirname(main.file) : supplied;
  if (supplied && directory && realpathSync(resolve(supplied)) !== realpathSync(resolve(directory))) throw new Error("forget directory does not belong to the personal database");
  return directory;
}
function cleanArtifacts(directory: string, owner: string, rawIds: ReadonlySet<number>): void {
  function walk(path: string, mode: "summary" | "sleep"): void {
    if (!existsSync(path)) return;
    if (lstatSync(path).isSymbolicLink()) throw new Error("refusing linked personal artifact directory");
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error("refusing linked personal artifact");
      if (entry.isDirectory()) { if (mode === "sleep") walk(file, mode); continue; }
      if (!entry.isFile()) continue;
      if (mode === "sleep" && entry.name.endsWith(".json")) {
        // Frozen extraction decisions contain source text. Keep run receipts/state.
        const match = /^\d+-(\d+)-/.exec(entry.name);
        if (match && rawIds.has(Number(match[1]))) unlinkSync(file);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const attributed = parseArtifactOwner(readFileSync(file, "utf8"));
      if (attributed && attributed !== owner) continue;
      unlinkSync(file);
    }
  }
  for (const tier of ["daily", "weekly", "quarterly"]) walk(join(directory, tier), "summary");
  walk(join(directory, "sleep"), "sleep");
  for (const name of ["user_profile.md", "agent_notes.md", "core_facts.md"]) {
    const file = join(directory, "core", name);
    if (!existsSync(file)) continue;
    if (lstatSync(file).isSymbolicLink()) throw new Error("refusing linked personal core artifact");
    unlinkSync(file);
  }
}
function completeOperation(db: Database.Database, operationId: string, owner: string, suppliedDir?: string): boolean {
  const directory = memoryDirectory(db, suppliedDir);
  if (!directory) return false;
  const roots = markers(db, owner).flatMap(m => links(m.lineage));
  db.transaction(() => enforceForgetMarkers(db, owner))();
  cleanArtifacts(directory, owner, new Set(roots.filter(l => l.kind === "raw").map(l => l.id)));
  db.prepare("UPDATE forget_operations SET state = 'complete', completed_at = ? WHERE id = ? AND owner = ? AND state = 'pending'").run(Date.now(), operationId, owner);
  // #1928 M2: the pending barrier above suppressed every serving document;
  // now that the barrier lifts, re-index the redacted survivors. A crash
  // before this line leaves the operation complete with an empty registry
  // (fail-closed); resume repeats completeOperation and heals it.
  reconcileServingDocuments(db, owner);
  return true;
}

export function forgetPersonal(db: Database.Database, opts: { owner: string; callerOwner: string; targets: ForgetTarget[]; memoryDir?: string; actorId: string }): { operationId: string; state: "pending" | "complete" } {
  if (!isPersonalReady(db)) throw new Error("personal serving refused: dataset not ready");
  if (!opts.owner || opts.owner !== opts.callerOwner || !opts.targets.length || opts.targets.length > 512) throw new Error("forgetting requires owned targets");
  memoryDirectory(db, opts.memoryDir);
  const replay = db.prepare("SELECT id, state FROM forget_operations WHERE owner = ? AND targets = ? ORDER BY created_at DESC LIMIT 1").get(opts.owner, JSON.stringify(opts.targets)) as { id: string; state: "pending" | "complete" } | undefined;
  if (replay) return { operationId: replay.id, state: replay.state };
  const operationId = randomUUID(), now = Date.now();
  // The ring key must exist before any digest below is computed, so lineage
  // and marker digests use the same generation key.
  ensureForgetRingKey(db, opts.owner);
  const allLinks: Link[] = [];
  const add = (link: Link): void => {
    if (!Number.isSafeInteger(link.id) || link.id < 1) throw new Error("invalid forget target");
    if (!allLinks.some(l => l.id === link.id && l.kind === link.kind)) allLinks.push(link);
  };
  const toMark: Array<{ kind: string; id: number; episodeId?: number; content: string }> = [];
  for (const target of opts.targets) {
    if (target.kind === "durable") {
      const row = db.prepare("SELECT content, evidence, provenance FROM long_term_memories WHERE id = ? AND user_id = ?").get(target.id, opts.owner) as { content: string; evidence: string; provenance: string } | undefined;
      if (!row) throw new Error("forget target missing or not owned");
      add({ kind: "durable", id: target.id });
      sourceLinks(JSON.parse(row.evidence)).forEach(add);
      const history = db.prepare("SELECT revision, content, evidence FROM long_term_revisions WHERE memory_id = ? AND user_id = ?").all(target.id, opts.owner) as Array<{ revision: number; content: string; evidence: string }>;
      for (const previous of history) {
        sourceLinks(JSON.parse(previous.evidence)).forEach(add);
        add({ kind: "durable_revision", id: previous.revision, digest: forgetDigest(opts.owner, previous.content, db) });
      }
      const provenance: unknown = JSON.parse(row.provenance);
      if (object(provenance) && Number.isSafeInteger(provenance["legacyId"])) add({ kind: "legacy", id: Number(provenance["legacyId"]) });
      toMark.push({ kind: "durable", id: target.id, content: row.content });
    } else if (target.kind === "episode") {
      const row = db.prepare("SELECT source_message_ids FROM short_term_memories WHERE id = ? AND user_id = ?").get(target.id, opts.owner) as { source_message_ids: string } | undefined;
      if (!row) throw new Error("forget target missing or not owned");
      add({ kind: "episode", id: target.id });
      const ids: unknown = JSON.parse(row.source_message_ids);
      if (!Array.isArray(ids)) throw new Error("invalid episode lineage");
      ids.forEach(id => add({ kind: "raw", id: Number(id) }));
      toMark.push({ kind: "episode", id: target.id, episodeId: target.id, content: "episode:" + target.id });
    } else if (target.kind === "raw" || target.kind === "episode-detail") {
      const ids = target.kind === "raw" ? target.messageIds : [target.excerptMessageId];
      if (!ids.length || ids.length > 512) throw new Error("invalid raw forget targets");
      for (const id of ids) {
        add({ kind: "raw", id });
        let row = db.prepare("SELECT content FROM messages WHERE id = ? AND user_id = ?").get(id, opts.owner) as { content: string } | undefined;
        if (target.kind === "episode-detail") {
          const episode = db.prepare("SELECT evidence_excerpts FROM short_term_memories WHERE id = ? AND user_id = ?").get(target.episodeId, opts.owner) as { evidence_excerpts: string } | undefined;
          if (!episode) throw new Error("forget episode not owned");
          const evidence: unknown = JSON.parse(episode.evidence_excerpts);
          const entry = Array.isArray(evidence) ? evidence.find(x => object(x) && x["messageId"] === id && typeof x["excerpt"] === "string") : undefined;
          if (!object(entry) || typeof entry["excerpt"] !== "string") throw new Error("forget detail not found");
          row = row ?? { content: entry["excerpt"] };
          toMark.push({ kind: "evidence", id, episodeId: target.episodeId, content: row.content });
        } else {
          if (!row) throw new Error("forget source missing or not owned");
          toMark.push({ kind: "raw", id, content: row.content });
        }
      }
    } else throw new Error("invalid forget target kind");
  }
  for (const link of [...allLinks]) if (link.kind === "legacy") {
    const row = db.prepare("SELECT source_message_ids FROM extracted_memories WHERE id = ? AND user_id = ?").get(link.id, opts.owner) as { source_message_ids: string | null } | undefined;
    const ids: unknown = JSON.parse(row?.source_message_ids ?? "[]");
    if (!Array.isArray(ids)) throw new Error("invalid legacy source lineage");
    ids.forEach(id => add({ kind: "raw", id: Number(id) }));
  }
  for (const link of allLinks) if (link.kind === "raw" && !toMark.some(m => m.kind === "raw" && m.id === link.id)) {
    const row = db.prepare("SELECT content FROM messages WHERE id = ? AND user_id = ?").get(link.id, opts.owner) as { content: string } | undefined;
    toMark.push({ kind: "raw", id: link.id, content: row?.content ?? "raw:" + link.id });
  }
  db.transaction(() => {
    db.prepare("INSERT INTO forget_operations (id, owner, state, targets, created_at) VALUES (?, ?, 'pending', ?, ?)").run(operationId, opts.owner, JSON.stringify(opts.targets), now);
    // The ring key for this generation must exist before any digest is
    // computed, so every marker carries a verifiable generation.
    ensureForgetRingKey(db, opts.owner);
    const generation = activeGeneration(db);
    for (const marker of toMark) db.prepare("INSERT OR IGNORE INTO forget_markers (owner, record_kind, record_id, episode_id, lineage, digest, key_generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(opts.owner, marker.kind, marker.id, marker.episodeId ?? null, JSON.stringify(allLinks), forgetDigest(opts.owner, marker.content, db), generation, now);
    enforceForgetMarkers(db, opts.owner);
  })();
  try {
    return { operationId, state: completeOperation(db, operationId, opts.owner, opts.memoryDir) ? "complete" : "pending" };
  } catch {
    // Committed pending state is truthful and blocks serving until resume succeeds.
    return { operationId, state: "pending" };
  }
}
export function resumePendingForgetCleanup(db: Database.Database, memoryDir?: string): { resumed: number; completed: number } {
  const operations = db.prepare("SELECT id, owner, targets FROM forget_operations WHERE state = 'pending'").all() as Array<{ id: string; owner: string; targets: string }>;
  let completed = 0;
  for (const operation of operations) {
    const targets: unknown = JSON.parse(operation.targets);
    if (!Array.isArray(targets) || targets.length === 0 || markers(db, operation.owner).length === 0) continue;
    try { if (completeOperation(db, operation.id, operation.owner, memoryDir)) completed++; } catch { /* keep pending and blocked */ }
  }
  return { resumed: operations.length, completed };
}
