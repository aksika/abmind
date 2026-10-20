/**
 * backup.ts — Encrypted backup/restore for abmind memory.
 * Format: plaintext header (salt, iv, version) + AES-256-GCM encrypted ZIP.
 */

import { createCipheriv, createDecipheriv, randomBytes, randomUUID, pbkdf2Sync, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { deflateSync, inflateSync } from "node:zlib";
import type Database from "better-sqlite3";
import { logInfo } from "./mem-logger.js";
import {
  computeContentHash,
  validateCreateDraftInput,
  validateRejectDraftInput,
  validateReviseInput,
  ValidationError,
} from "./operational-memory-types.js";
import type { EvidenceEntry, NormalizedScope, ProvenanceMap, ScopeLevel } from "./operational-memory-types.js";

import { getBackupKey, deriveFromPassphrase } from "./crypto.js";
import { resolveSavedUserIdOrNull } from "./user-utils.js";
import { enforceForgetMarkers, forgetDigest, resumePendingForgetCleanup } from "./personal-forget.js";
import { PERSONAL_MODEL_VERSION, setPersonalState } from "./personal-schema.js";
import { invalidateRecallProjections } from "./recall-projection-build.js";

const TAG = "backup";
const MAGIC = Buffer.from("ABMIND\x00\x01");
const HEADER_SIZE = 54; // 8 magic + 2 version + 32 salt + 12 iv

export interface BackupResult {
  path: string;
  memories: number;
  files: number;
  sizeBytes: number;
}

export interface RestoreResult {
  restored: number;
  skipped: number;
  files: number;
  /** Distinct durable/message owners present after restore (preserved exactly). */
  restoredOwners: string[];
  /** Backup-embedded salt username from the .abm header (`abmind:<user>`); null for legacy headers. */
  encryptionUser: string | null;
}

function resolveKey(passphrase?: string, username?: string): Buffer {
  if (passphrase) {
    const user = username ?? resolveEncryptionUser();
    const master = deriveFromPassphrase(passphrase, user);
    return Buffer.from(hkdfSync("sha256", master, "", "abmind-backup-v1", 32));
  }
  return getBackupKey();
}

function resolveEncryptionUser(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(homedir(), ".abmind", "manifest.json"), "utf-8"));
    if (manifest.encryptionUser) return manifest.encryptionUser;
  } catch { /* fall through */ }
  return process.env["USER"] ?? "default";
}

function encrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([encrypted, authTag]); // tag appended (16 bytes)
}

function decrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const authTag = data.subarray(data.length - 16);
  const encrypted = data.subarray(0, data.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

const BACKUP_EXCLUDE_DIRS = new Set(["working"]);

function collectFiles(baseDir: string): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  if (!existsSync(baseDir)) return files;
  for (const sub of readdirSync(baseDir, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    if (BACKUP_EXCLUDE_DIRS.has(sub.name)) continue;
    const dir = join(baseDir, sub.name);
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md") && !f.endsWith(".json")) continue;
      files.push({ path: `${sub.name}/${f}`, content: readFileSync(join(dir, f), "utf-8") });
    }
  }
  return files;
}

type OperationalRow = Record<string, any>;

const OPERATIONAL_SCOPE_LEVELS = new Set<ScopeLevel>([
  "global", "platform", "host", "workspace", "repository", "task_environment",
]);

function invalidOperationalBackup(message: string): Error {
  return new Error(`Invalid operational backup: ${message}`);
}

function parseOperationalJson(raw: unknown, label: string): unknown {
  if (typeof raw !== "string") throw invalidOperationalBackup(`${label} must be JSON text`);
  try {
    return JSON.parse(raw);
  } catch {
    throw invalidOperationalBackup(`${label} is not valid JSON`);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function readOperationalScope(row: OperationalRow, label: string): NormalizedScope {
  const level = row.scope_level as ScopeLevel;
  if (!OPERATIONAL_SCOPE_LEVELS.has(level)) throw invalidOperationalBackup(`${label} has invalid scope level`);

  const values = {
    platform: row.platform ?? null,
    host: row.host ?? null,
    workspace: row.workspace ?? null,
    repository: row.repository ?? null,
    taskEnvironment: row.task_environment ?? null,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== null && typeof value !== "string") throw invalidOperationalBackup(`${label}.${key} must be text or null`);
  }
  const populated = Object.entries(values).filter(([, value]) => value !== null).map(([key]) => key);
  if (level === "global") {
    if (populated.length !== 0) throw invalidOperationalBackup(`${label} global scope has a value`);
  } else if (populated.length !== 1 || populated[0] !== level) {
    throw invalidOperationalBackup(`${label} has inconsistent scope columns`);
  }

  return {
    scopeLevel: level,
    platform: values.platform,
    host: values.host,
    workspace: values.workspace,
    repository: values.repository,
    taskEnvironment: values.taskEnvironment,
  };
}

function validateOperationalTables(tables: {
  operational_lesson_drafts?: any[];
  operational_memories?: any[];
  operational_memory_versions?: any[];
}): void {
  const draftRows = tables.operational_lesson_drafts ?? [];
  const memoryRows = tables.operational_memories ?? [];
  const versionRows = tables.operational_memory_versions ?? [];
  const memories = new Map<string, OperationalRow>();
  const versionsByMemory = new Map<string, Map<string, OperationalRow>>();

  for (const row of memoryRows) {
    if (typeof row.id !== "string" || memories.has(row.id)) throw invalidOperationalBackup("duplicate or invalid memory id");
    if (row.status !== "active" && row.status !== "retired") throw invalidOperationalBackup(`memory ${row.id} has invalid status`);
    const scope = readOperationalScope(row, `memory ${row.id}`);
    if (!Number.isInteger(row.confidence) || row.confidence < 0 || row.confidence > 100) throw invalidOperationalBackup(`memory ${row.id} has invalid confidence`);
    const provenance = parseOperationalJson(row.provenance_json, `memory ${row.id}.provenance_json`);
    if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) throw invalidOperationalBackup(`memory ${row.id} provenance must be an object`);
    row.__scope = scope;
    row.__provenance = provenance;
    memories.set(row.id, row);
  }

  for (const row of versionRows) {
    if (typeof row.id !== "string" || typeof row.memory_id !== "string") throw invalidOperationalBackup("version has invalid identity");
    const memory = memories.get(row.memory_id);
    if (!memory) throw invalidOperationalBackup(`version ${row.id} references a missing memory`);
    const versions = versionsByMemory.get(row.memory_id) ?? new Map<string, OperationalRow>();
    if (versions.has(row.id)) throw invalidOperationalBackup(`duplicate version ${row.id}`);
    if (row.status !== "active" && row.status !== "retired") throw invalidOperationalBackup(`version ${row.id} has invalid status`);
    const scope = readOperationalScope(row, `version ${row.id}`);
    const provenance = parseOperationalJson(row.provenance_json, `version ${row.id}.provenance_json`);
    const evidence = parseOperationalJson(row.evidence_json, `version ${row.id}.evidence_json`);
    if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) throw invalidOperationalBackup(`version ${row.id} provenance must be an object`);
    try {
      validateReviseInput({
        memoryId: row.memory_id,
        expectedContentHash: row.content_hash,
        content: row.content,
        scopeLevel: scope.scopeLevel,
        platform: scope.platform,
        host: scope.host,
        workspace: scope.workspace,
        repository: scope.repository,
        taskEnvironment: scope.taskEnvironment,
        confidence: row.confidence,
        provenance: provenance as ProvenanceMap,
        evidence: evidence as EvidenceEntry[],
        mutationReason: row.mutation_reason,
        actorId: row.actor_id,
      });
    } catch (err) {
      if (err instanceof ValidationError || err instanceof TypeError) throw invalidOperationalBackup(`version ${row.id} failed validation`);
      throw err;
    }
    const expectedHash = computeContentHash({
      content: row.content,
      status: row.status,
      scope,
      confidence: row.confidence,
      provenance: provenance as ProvenanceMap,
      evidence: evidence as EvidenceEntry[],
    });
    if (row.content_hash !== expectedHash) throw invalidOperationalBackup(`version ${row.id} has an invalid content hash`);
    row.__scope = scope;
    row.__provenance = provenance;
    row.__evidence = evidence;
    versions.set(row.id, row);
    versionsByMemory.set(row.memory_id, versions);
  }

  for (const [memoryId, memory] of memories) {
    if (typeof memory.current_version_id !== "string") throw invalidOperationalBackup(`memory ${memoryId} has no current version`);
    const versions = versionsByMemory.get(memoryId) ?? new Map<string, OperationalRow>();
    const current = versions.get(memory.current_version_id);
    if (!current) throw invalidOperationalBackup(`memory ${memoryId} points to a missing current version`);
    if (memory.content_hash !== current.content_hash || memory.status !== current.status || memory.confidence !== current.confidence) {
      throw invalidOperationalBackup(`memory ${memoryId} projection does not match its current version`);
    }
    const memoryScope = memory.__scope as NormalizedScope;
    const currentScope = current.__scope as NormalizedScope;
    if (stableJson(memoryScope) !== stableJson(currentScope) || stableJson(memory.__provenance) !== stableJson(current.__provenance)) {
      throw invalidOperationalBackup(`memory ${memoryId} projection scope/provenance does not match its current version`);
    }

    const reachable = new Set<string>();
    let cursor: OperationalRow | undefined = current;
    while (cursor) {
      if (reachable.has(cursor.id)) throw invalidOperationalBackup(`memory ${memoryId} has a cyclic version lineage`);
      reachable.add(cursor.id);
      if (cursor.previous_version_id === null || cursor.previous_version_id === undefined) break;
      cursor = versions.get(cursor.previous_version_id);
      if (!cursor) throw invalidOperationalBackup(`memory ${memoryId} has a broken version lineage`);
    }
    if (reachable.size !== versions.size) throw invalidOperationalBackup(`memory ${memoryId} has unreachable versions`);
  }

  for (const row of draftRows) {
    if (typeof row.id !== "string") throw invalidOperationalBackup("draft has invalid identity");
    const evidence = parseOperationalJson(row.evidence_json, `draft ${row.id}.evidence_json`);
    const provenance = parseOperationalJson(row.provenance_json, `draft ${row.id}.provenance_json`);
    if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)) throw invalidOperationalBackup(`draft ${row.id} provenance must be an object`);
    try {
      validateCreateDraftInput({
        lesson: row.lesson,
        problem: row.problem ?? undefined,
        recommendation: row.recommendation ?? undefined,
        evidence: evidence as EvidenceEntry[],
        suggestedScopeLevel: row.suggested_scope_level,
        suggestedPlatform: row.suggested_platform ?? undefined,
        suggestedHost: row.suggested_host ?? undefined,
        suggestedWorkspace: row.suggested_workspace ?? undefined,
        suggestedRepository: row.suggested_repository ?? undefined,
        suggestedTaskEnvironment: row.suggested_task_environment ?? undefined,
        confidence: row.confidence,
        sourceTaskId: row.source_task_id ?? undefined,
        sourceSessionId: row.source_session_id ?? undefined,
        sourceExecutor: row.source_executor ?? undefined,
        sourceHost: row.source_host ?? undefined,
        provenance: provenance as ProvenanceMap,
      });
    } catch (err) {
      if (err instanceof ValidationError || err instanceof TypeError) throw invalidOperationalBackup(`draft ${row.id} failed validation`);
      throw err;
    }
    if (row.status !== "draft" && row.status !== "promoted" && row.status !== "rejected") throw invalidOperationalBackup(`draft ${row.id} has invalid status`);
    if (row.status === "draft" && (row.promoted_memory_id !== null || row.rejected_by !== null || row.rejected_at !== null || row.rejection_reason !== null)) {
      throw invalidOperationalBackup(`draft ${row.id} has invalid draft audit fields`);
    }
    if (row.status === "promoted" && (!row.promoted_memory_id || !memories.has(row.promoted_memory_id))) {
      throw invalidOperationalBackup(`draft ${row.id} points to a missing promoted memory`);
    }
    if (row.status === "promoted" && (row.rejected_by !== null || row.rejected_at !== null || row.rejection_reason !== null)) {
      throw invalidOperationalBackup(`draft ${row.id} has invalid promoted audit fields`);
    }
    if (row.status === "rejected") {
      if (row.promoted_memory_id !== null || typeof row.rejected_by !== "string" || row.rejected_at === null || typeof row.rejection_reason !== "string") {
        throw invalidOperationalBackup(`draft ${row.id} has invalid rejection fields`);
      }
      try {
        validateRejectDraftInput({ draftId: row.id, rejectedBy: row.rejected_by, rejectionReason: row.rejection_reason });
      } catch (err) {
        if (err instanceof ValidationError || err instanceof TypeError) throw invalidOperationalBackup(`draft ${row.id} failed rejection validation`);
        throw err;
      }
    }
  }
}

// ── Backup ───────────────────────────────────────────────────────────────────

export function createBackup(db: Database.Database, memoryDir: string, passphrase: string | undefined, outputPath: string, opts?: { dbOnly?: boolean }): BackupResult {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = resolveKey(passphrase);

  const safeAll = (table: string): unknown[] => {
    try {
      return db.prepare(`SELECT * FROM ${table}`).all() as unknown[];
    } catch {
      return [];
    }
  };
  // Export tables (strip embeddings — derived data, regenerated after restore).
  // #1939 stage 3: legacy extracted_memories/entity_graph/ingested_documents
  // are dropped and no longer exported. Old backups carrying them restore
  // only the keys below; legacy keys are ignored, never read.
  const watermarks = db.prepare("SELECT * FROM extraction_watermarks").all();
  const messages = db.prepare("SELECT * FROM messages").all();
  const secretKeyState = db.prepare("SELECT singleton, active_generation FROM secret_key_state").all();
  const operationalDrafts = db.prepare("SELECT * FROM operational_lesson_drafts").all();
  const operationalMemories = db.prepare("SELECT * FROM operational_memories").all();
  const operationalVersions = db.prepare("SELECT * FROM operational_memory_versions").all();
  // #1930: new-model personal tables + forgetting/readiness state travel with
  // the backup so restore can enforce the forget barrier. Embeddings in the
  // durable layer are stripped like the legacy layer (derived data).
  const shortTerm = safeAll("short_term_memories").map((r: any) => ({ ...r }));
  const longTerm = safeAll("long_term_memories").map((r: any) => ({ ...r, embedding: null }));
  const longTermRevisions = safeAll("long_term_revisions");
  const personalState = safeAll("personal_model_state");
  const forgetMarkers = safeAll("forget_markers");
  const forgetKeyChecks = Object.fromEntries([...new Set((forgetMarkers as Array<{ owner: string }>).map(m => m.owner))]
    .map(owner => [owner, forgetDigest(owner, "abmind-personal-forget-key-check", db)]));
  const forgetRing = safeAll("forget_key_ring");
  const forgetOps = safeAll("forget_operations");
  const groupingLedger = safeAll("personal_grouping_ledger");
  const schemaVersion = 19; // current schema version (#1939 stage 3: legacy tables dropped from the shape)

  // Export .md files (full mode: walk all subdirs except excluded)
  const mdFiles = opts?.dbOnly ? [] : collectFiles(memoryDir);

  // Build ZIP-like JSON payload (using JSON for simplicity — ZIP adds dep)
  const manifest = {
    version: schemaVersion,
    createdAt: Date.now(),
    memoriesCount: longTerm.length,
    messagesCount: messages.length,
    filesCount: mdFiles.length,
    operationalDraftCount: operationalDrafts.length,
    operationalMemoryCount: operationalMemories.length,
    operationalVersionCount: operationalVersions.length,
  };

  // Read key.verify for inclusion in backup
  const keyVerifyPath = join(dirname(memoryDir), "secret", "key.verify");
  const keyVerify = existsSync(keyVerifyPath) ? readFileSync(keyVerifyPath, "utf-8") : null;

  const payload = JSON.stringify({
    manifest,
    tables: {
      extraction_watermarks: watermarks,
      messages,
      secret_key_state: secretKeyState,
      operational_lesson_drafts: operationalDrafts,
      operational_memories: operationalMemories,
      operational_memory_versions: operationalVersions,
      short_term_memories: shortTerm,
      long_term_memories: longTerm,
      long_term_revisions: longTermRevisions,
      personal_model_state: personalState,
      forget_markers: forgetMarkers,
      forget_key_ring: forgetRing,
      forget_operations: forgetOps,
      personal_grouping_ledger: groupingLedger,
    },
    files: mdFiles,
    keyVerify,
    forgetKeyChecks,
  });

  // Compress then encrypt
  const compressed = deflateSync(Buffer.from(payload, "utf-8"));
  const encrypted = encrypt(key, iv, compressed);

  // Write header + body (format v2: magic + formatVersion + metaLen + meta + salt + iv + encrypted)
  const encUser = resolveEncryptionUser();
  const meta = JSON.stringify({ v: 1, salt: `abmind:${encUser}`, kdf: "scrypt-16384-8-1", hkdf: "sha256/abmind-backup-v1" });
  const metaBuf = Buffer.from(meta, "utf-8");
  const headerSize = 8 + 2 + 2 + metaBuf.length + 32 + 12;
  const header = Buffer.alloc(headerSize);
  let offset = 0;
  MAGIC.copy(header, offset); offset += 8;
  header.writeUInt16LE(2, offset); offset += 2; // format version 2
  header.writeUInt16LE(metaBuf.length, offset); offset += 2;
  metaBuf.copy(header, offset); offset += metaBuf.length;
  salt.copy(header, offset); offset += 32;
  iv.copy(header, offset);

  const output = Buffer.concat([header, encrypted]);
  mkdirSync(join(outputPath, ".."), { recursive: true });
  writeFileSync(outputPath, output);

  // Record backup timestamp (#447)
  try { import("./meta-store.js").then(({ metaSet }) => metaSet(db, "last_backup_ts", Date.now())).catch(() => {}); } catch {}

  logInfo(TAG, `Backup complete: ${longTerm.length} durables, ${mdFiles.length} files → ${outputPath} (${output.length} bytes)`);
  return { path: outputPath, memories: longTerm.length, files: mdFiles.length, sizeBytes: output.length };
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Verify an encrypted backup file decrypts with the current backup key and
 * parses. Used as the apply gate for the reviewed sealed-row migration
 * (#1660). Returns true only for a readable, decryptable, JSON-parsable file.
 */
export function verifyBackupFile(inputPath: string): boolean {
  try {
    const raw = readFileSync(inputPath);
    if (!raw.subarray(0, 8).equals(MAGIC)) return false;
    const formatVersion = raw.readUInt16LE(8);
    let iv: Buffer;
    let body: Buffer;
    if (formatVersion >= 2) {
      const metaLen = raw.readUInt16LE(10);
      const headerEnd = 12 + metaLen;
      iv = raw.subarray(headerEnd + 32, headerEnd + 44);
      body = raw.subarray(headerEnd + 44);
    } else {
      iv = raw.subarray(42, 54);
      body = raw.subarray(HEADER_SIZE);
    }
    const decrypted = decrypt(resolveKey(), iv, body);
    const payload = inflateSync(decrypted).toString("utf-8");
    const data = JSON.parse(payload) as { manifest?: { version?: number } };
    return typeof data?.manifest?.version === "number";
  } catch {
    return false;
  }
}

export function restoreBackup(db: Database.Database, memoryDir: string, passphrase: string | undefined, inputPath: string, mode: "merge" | "replace", username?: string): RestoreResult {
  const raw = readFileSync(inputPath);

  // Parse header
  const magic = raw.subarray(0, 8);
  if (!magic.equals(MAGIC)) throw new Error("Invalid backup file (bad magic)");
  const formatVersion = raw.readUInt16LE(8);

  let iv: Buffer;
  let body: Buffer;
  let metaUsername: string | undefined;

  if (formatVersion >= 2) {
    // v2 format: magic(8) + formatVersion(2) + metaLen(2) + meta + salt(32) + iv(12) + body
    const metaLen = raw.readUInt16LE(10);
    const metaJson = JSON.parse(raw.subarray(12, 12 + metaLen).toString("utf-8"));
    // Extract username from salt field: "abmind:<username>" → "<username>"
    if (metaJson.salt && metaJson.salt.startsWith("abmind:")) {
      metaUsername = metaJson.salt.slice("abmind:".length);
    }
    const headerEnd = 12 + metaLen;
    iv = raw.subarray(headerEnd + 32, headerEnd + 44);
    body = raw.subarray(headerEnd + 44);
  } else {
    // Legacy format: magic(8) + schemaVersion(2) + salt(32) + iv(12) + body (54 bytes fixed)
    iv = raw.subarray(42, 54);
    body = raw.subarray(HEADER_SIZE);
  }

  // Decrypt + decompress
  const effectiveUsername = username ?? metaUsername;
  const key = resolveKey(passphrase, effectiveUsername);
  let decrypted: Buffer;
  try {
    decrypted = decrypt(key, iv, body);
  } catch {
    throw new Error("Decryption failed — wrong passphrase or corrupted file");
  }

  const decompressed = inflateSync(decrypted).toString("utf-8");
  const data = JSON.parse(decompressed) as {
    manifest: { version: number; createdAt: number; memoriesCount: number; filesCount: number };
    tables: {
      extraction_watermarks: any[]; messages?: any[];
      secret_key_state?: Array<{ singleton: number; active_generation: number }>;
      operational_lesson_drafts?: any[]; operational_memories?: any[]; operational_memory_versions?: any[];
      short_term_memories?: any[]; long_term_memories?: any[]; long_term_revisions?: any[];
      personal_model_state?: any[]; forget_markers?: any[]; forget_key_ring?: any[]; forget_operations?: any[];
      personal_grouping_ledger?: any[];
    };
    files: Array<{ path: string; content: string }>;
    keyVerify?: string | null;
    forgetKeyChecks?: Record<string, string>;
  };

  // #1930 C4/C5: stage personal restore behind the owner barrier. A partially
  // restored database or Markdown set is never visible. Capture live
  // forgetting state before any delete so replace cannot roll it backward;
  // recheck concurrent forgets before activation. Externally archived backup
  // files are not rewritten; that limitation is stated to the owner instead.
  const liveForgetMarkers: any[] = (() => {
    try { return db.prepare("SELECT * FROM forget_markers").all() as any[]; } catch { return []; }
  })();
  const liveForgetRing: any[] = (() => {
    try { return db.prepare("SELECT * FROM forget_key_ring").all() as any[]; } catch { return []; }
  })();
  const liveForgetOpsPending: any[] = (() => {
    try { return db.prepare("SELECT * FROM forget_operations WHERE state = 'pending'").all() as any[]; } catch { return []; }
  })();
  const liveKeyGeneration: number | null = (() => {
    try {
      const row = db.prepare("SELECT active_generation FROM secret_key_state WHERE singleton = 1").get() as { active_generation: number } | undefined;
      return row?.active_generation ?? null;
    } catch { return null; }
  })();
  try {
    db.prepare("INSERT INTO personal_model_state (singleton, state, expected_version, actual_version, reason, progress, updated_at) VALUES (1, 'interrupted', 1, 0, ?, '{}', ?) ON CONFLICT(singleton) DO UPDATE SET state='interrupted', reason=excluded.reason, updated_at=excluded.updated_at").run("restore in progress: staged behind owner barrier", Date.now());
  } catch { /* bookkeeping may predate structural migration */ }

  for (const { owner } of data.tables.forget_markers ?? []) {
    if (data.forgetKeyChecks?.[owner] !== forgetDigest(owner, "abmind-personal-forget-key-check", db)) {
      throw new Error("restore refused: trusted personal forgetting key is unavailable or mismatched");
    }
  }

  validateOperationalTables(data.tables);

  let restored = 0;
  let skipped = 0;

  const memoryGraphTx = db.transaction(() => {
    // #1939 stage 3: legacy extracted_memories/entity_graph/vec_memories/
    // ingested_documents are dropped. The #1939 boot migration drops any
    // surviving legacy tables before restore runs; old backups carrying
    // legacy keys restore only the new-model tables below.
    if (mode === "replace") {
      db.exec("DELETE FROM extraction_watermarks");
      db.exec("DELETE FROM messages");
    }
  });
  memoryGraphTx();

  // Restore extraction_watermarks
  if (data.tables.extraction_watermarks.length > 0) {
    const stmt = db.prepare("INSERT OR REPLACE INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)");
    for (const row of data.tables.extraction_watermarks) {
      stmt.run(row.user_id, row.last_processed_timestamp);
    }
  }

  // #1660: restore the secrets key-generation ledger. A backup without the
  // table supplies the safe default generation; the generation mismatch is a
  // reported inconsistency for the operator, never something restore
  // auto-repairs.
  const backupKeyState = data.tables.secret_key_state ?? [];
  const backupHasKeyState = backupKeyState.length > 0;
  if (backupHasKeyState) {
    db.prepare("INSERT OR REPLACE INTO secret_key_state (singleton, active_generation) VALUES (1, ?)").run(backupKeyState[0]!.active_generation);
  } else {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secret_key_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        active_generation INTEGER NOT NULL
      );
    `);
    db.prepare("INSERT OR IGNORE INTO secret_key_state (singleton, active_generation) VALUES (1, 1)").run();
  }

  // Restore messages (#861)
  if (data.tables.messages && data.tables.messages.length > 0) {
    const msgCols = Object.keys(data.tables.messages[0]);
    const tableInfo = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    const validCols = new Set(tableInfo.map(c => c.name));
    const useCols = msgCols.filter(c => validCols.has(c));
    const placeholders = useCols.map(() => "?").join(",");
    const insertSql = mode === "merge"
      ? `INSERT OR IGNORE INTO messages (${useCols.join(",")}) VALUES (${placeholders})`
      : `INSERT INTO messages (${useCols.join(",")}) VALUES (${placeholders})`;
    const stmt = db.prepare(insertSql);
    const tx = db.transaction(() => {
      for (const row of data.tables.messages!) {
        const values = useCols.map(c => row[c] ?? null);
        const info = stmt.run(values);
        if (info.changes > 0) restored++;
        else skipped++;
      }
    });
    tx();
  }

  // ── Restore operational tables (#1371) ──────────────────────────────────
  // These tables have cyclic FK dependencies (memory→version, version→memory).
  // The memory→version FK is DEFERRABLE INITIALLY DEFERRED; the version→memory
  // FK is immediate. To satisfy both, we insert memories (deferred FK passes
  // at stmt time) then versions (immediate FK checks memory exists — it does).
  // The entire block is a single transaction for atomicity.
  const opTx = db.transaction(() => {
    if (mode === "replace") {
      db.exec("DELETE FROM operational_lesson_drafts");
      db.exec("DELETE FROM operational_memory_versions");
      db.exec("DELETE FROM operational_memories");
    }

    // Determine which memories to accept (aggregate-level merge)
    const ACCEPT_ALL = "accept_all";
    let memoryPlan: Map<string, "accept" | "reject"> | typeof ACCEPT_ALL;

    if (mode === "merge" && data.tables.operational_memories && data.tables.operational_memories.length > 0) {
      memoryPlan = new Map();
      const existing = new Map<string, string>();
      const existingRows = db.prepare("SELECT id, content_hash FROM operational_memories").all() as Array<{ id: string; content_hash: string }>;
      for (const row of existingRows) existing.set(row.id, row.content_hash);

      for (const mem of data.tables.operational_memories) {
        const currentHash = existing.get(mem.id);
        if (currentHash === undefined) {
          memoryPlan.set(mem.id, "accept");
        } else if (currentHash === mem.content_hash) {
          memoryPlan.set(mem.id, "reject");
        } else {
          memoryPlan.set(mem.id, "reject");
        }
      }
    } else {
      memoryPlan = ACCEPT_ALL;
    }

    // 1. Insert memories (the current-version FK is deferred until commit)
    if (data.tables.operational_memories && data.tables.operational_memories.length > 0) {
      const memStmt = db.prepare(mode === "merge"
        ? "INSERT OR IGNORE INTO operational_memories (id, status, scope_level, platform, host, workspace, repository, task_environment, content_hash, current_version_id, confidence, provenance_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO operational_memories (id, status, scope_level, platform, host, workspace, repository, task_environment, content_hash, current_version_id, confidence, provenance_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of data.tables.operational_memories) {
        if (memoryPlan !== ACCEPT_ALL && memoryPlan.get(row.id) === "reject") continue;
        memStmt.run(row.id, row.status, row.scope_level, row.platform, row.host, row.workspace,
          row.repository, row.task_environment, row.content_hash, row.current_version_id,
          row.confidence, row.provenance_json, row.created_at, row.updated_at);
      }
    }

    // 2. Insert versions (immediate FK to memories — memories must exist)
    if (data.tables.operational_memory_versions && data.tables.operational_memory_versions.length > 0) {
      const verStmt = db.prepare(mode === "merge"
        ? "INSERT OR IGNORE INTO operational_memory_versions (id, memory_id, previous_version_id, status, scope_level, platform, host, workspace, repository, task_environment, content, content_hash, confidence, provenance_json, evidence_json, mutation_reason, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO operational_memory_versions (id, memory_id, previous_version_id, status, scope_level, platform, host, workspace, repository, task_environment, content, content_hash, confidence, provenance_json, evidence_json, mutation_reason, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of data.tables.operational_memory_versions) {
        // Skip versions whose memory was rejected
        if (memoryPlan !== ACCEPT_ALL && memoryPlan.get(row.memory_id) === "reject") continue;
        verStmt.run(row.id, row.memory_id, row.previous_version_id, row.status,
          row.scope_level, row.platform, row.host, row.workspace, row.repository,
          row.task_environment, row.content, row.content_hash, row.confidence,
          row.provenance_json, row.evidence_json, row.mutation_reason, row.actor_id, row.created_at);
      }
    }

    // 3. Insert drafts after promoted-memory targets exist.
    if (data.tables.operational_lesson_drafts && data.tables.operational_lesson_drafts.length > 0) {
      const draftStmt = db.prepare(mode === "merge"
        ? "INSERT OR IGNORE INTO operational_lesson_drafts (id, status, lesson, problem, recommendation, evidence_json, suggested_scope_level, suggested_platform, suggested_host, suggested_workspace, suggested_repository, suggested_task_environment, confidence, source_task_id, source_session_id, source_executor, source_host, provenance_json, created_at, updated_at, promoted_memory_id, rejected_by, rejected_at, rejection_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO operational_lesson_drafts (id, status, lesson, problem, recommendation, evidence_json, suggested_scope_level, suggested_platform, suggested_host, suggested_workspace, suggested_repository, suggested_task_environment, confidence, source_task_id, source_session_id, source_executor, source_host, provenance_json, created_at, updated_at, promoted_memory_id, rejected_by, rejected_at, rejection_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const row of data.tables.operational_lesson_drafts) {
        // Skip promoted drafts whose memory aggregate was rejected in merge.
        if (row.promoted_memory_id && memoryPlan !== ACCEPT_ALL && memoryPlan.get(row.promoted_memory_id) === "reject") continue;
        draftStmt.run(row.id, row.status, row.lesson, row.problem, row.recommendation, row.evidence_json,
          row.suggested_scope_level, row.suggested_platform, row.suggested_host, row.suggested_workspace,
          row.suggested_repository, row.suggested_task_environment, row.confidence,
          row.source_task_id, row.source_session_id, row.source_executor, row.source_host,
          row.provenance_json, row.created_at, row.updated_at,
          row.promoted_memory_id, row.rejected_by, row.rejected_at, row.rejection_reason);
      }
    }
  });
  opTx();

  // ── Restore personal new-model tables (#1930 C4/C5) ──────────────────────
  // Both merge and replace apply the authoritative forget markers before
  // restored content becomes visible; replace unions live markers so it never
  // rolls forgetting state backward. Missing/untrustworthy current forgetting
  // state refuses personal serving with an observable reason.
  {
    const backupMarkers = data.tables.forget_markers ?? [];
    const backupOps = data.tables.forget_operations ?? [];
    const personalTx = db.transaction(() => {
      if (mode === "replace") {
        // Order matters under foreign_keys=ON: dependents before parents.
        db.exec("DELETE FROM personal_grouping_ledger");
        db.exec("DELETE FROM long_term_revisions");
        db.exec("DELETE FROM long_term_memories");
        db.exec("DELETE FROM short_term_memories");
        // Forget markers/ops are unioned below, never wholesale replaced.
      }
      const restoreTable = (table: string, cols: string[], rows: any[]): void => {
        if (!rows || rows.length === 0) return;
        let validCols: Set<string>;
        try {
          const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
          validCols = new Set(info.map((c) => c.name));
        } catch { return; }
        const useCols = cols.filter((c) => validCols.has(c));
        if (useCols.length === 0) return;
        const placeholders = useCols.map(() => "?").join(",");
        const stmt = db.prepare(mode === "merge"
          ? `INSERT OR IGNORE INTO ${table} (${useCols.join(",")}) VALUES (${placeholders})`
          : `INSERT INTO ${table} (${useCols.join(",")}) VALUES (${placeholders})`);
        for (const row of rows) {
          // Restore the graph, then remove forgotten roots and dependents
          // together. Skipping only parents violates foreign keys.
          // JSON encodes Buffer columns as objects. Derived search artifacts
          // are invalidated on restore rather than bound as objects or trusted.
          const values = useCols.map((c) => (c === "embedding" || c === "signature" || row[c] === undefined ? null : row[c]));
          const info = stmt.run(values);
          if (info.changes > 0) restored++;
          else skipped++;
        }
      };
      restoreTable("short_term_memories",
        ["id","user_id","topic","start_ts","end_ts","session_ids","source_message_ids","grouping_hash","outcomes","unresolved","evidence_excerpts","prominence","prev_episode_id","next_episode_id","classification","encrypted","created_at","updated_at"],
        data.tables.short_term_memories ?? []);
      restoreTable("long_term_memories",
        ["id","user_id","memory_type","content","content_original","authority","applicability_scope","valid_from","valid_to","revision","supersedes_id","superseded_by_id","provenance","evidence","classification","encrypted","sealed_format_version","embedding","signature","semantic_revision","created_at","updated_at"],
        data.tables.long_term_memories ?? []);
      restoreTable("long_term_revisions",
        ["id","memory_id","user_id","revision","content","content_original","authority","applicability_scope","valid_from","valid_to","supersedes_id","provenance","evidence","classification","created_at"],
        data.tables.long_term_revisions ?? []);
      restoreTable("personal_grouping_ledger", ["user_id","grouping_hash","episode_id","created_at"], data.tables.personal_grouping_ledger ?? []);
      // Forget markers: union of live + backup (replace never regresses).
      const markerStmt = db.prepare("INSERT OR IGNORE INTO forget_markers (owner, record_kind, record_id, episode_id, lineage, digest, key_generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const m of backupMarkers) {
        markerStmt.run(m.owner, m.record_kind, m.record_id, m.episode_id ?? null, typeof m.lineage === "string" ? m.lineage : JSON.stringify(m.lineage ?? []), m.digest, m.key_generation ?? 1, m.created_at ?? Date.now());
      }
      for (const m of liveForgetMarkers) {
        markerStmt.run(m.owner, m.record_kind, m.record_id, m.episode_id ?? null, typeof m.lineage === "string" ? m.lineage : JSON.stringify(m.lineage ?? []), m.digest, m.key_generation ?? 1, m.created_at ?? Date.now());
      }
      // Forget ring: union of live + backup (replace never regresses).
      // Without the ring entries matching restored markers, digests are
      // unverifiable and the key check below refuses activation.
      // JSON serializes Buffers as {type:"Buffer",data:[...]}; normalize
      // every binary shape before binding (a raw object is never a BLOB).
      const toBlob = (value: unknown): Buffer | null => {
        if (value === null || value === undefined) return null;
        if (Buffer.isBuffer(value)) return value;
        if (value instanceof Uint8Array) return Buffer.from(value);
        if (typeof value === "string" && value.length > 0) return Buffer.from(value, "base64");
        if (typeof value === "object") {
          const shaped = value as { type?: unknown; data?: unknown };
          if (shaped.type === "Buffer" && Array.isArray(shaped.data)) return Buffer.from(shaped.data as number[]);
        }
        return null;
      };
      const ringStmt = db.prepare("INSERT OR IGNORE INTO forget_key_ring (owner, generation, wrapped_key, nonce, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const r of [...(data.tables.forget_key_ring ?? []), ...liveForgetRing]) {
        const wrappedKey = toBlob(r.wrapped_key);
        const nonce = toBlob(r.nonce);
        // A ring row that cannot normalize is skipped; the marker key check
        // below then refuses activation with an observable reason.
        if (!wrappedKey || !nonce) continue;
        ringStmt.run(r.owner, r.generation, wrappedKey, nonce, r.created_at ?? Date.now());
      }
      // Forget operations: preserve live pending + backup pending; live keys win.
      const opStmt = db.prepare("INSERT OR IGNORE INTO forget_operations (id, owner, state, targets, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?)");
      for (const o of [...backupOps, ...liveForgetOpsPending]) {
        opStmt.run(o.id, o.owner, o.state, typeof o.targets === "string" ? o.targets : JSON.stringify(o.targets ?? []), o.created_at ?? Date.now(), o.completed_at ?? null);
      }
      const owners = db.prepare("SELECT DISTINCT owner FROM forget_markers").all() as Array<{ owner: string }>;
      for (const { owner } of owners) {
        // Validate access to the protected key before activation. Table
        // existence alone cannot establish trustworthy forgetting state.
        forgetDigest(owner, "restore-key-check", db);
        enforceForgetMarkers(db, owner);
        const targets = db.prepare("SELECT record_kind, record_id FROM forget_markers WHERE owner = ?").all(owner);
        db.prepare("INSERT INTO forget_operations (id, owner, state, targets, created_at) VALUES (?, ?, 'pending', ?, ?)")
          .run(randomUUID(), owner, JSON.stringify(targets), Date.now());
      }
      if (liveKeyGeneration !== null) {
        db.prepare("UPDATE secret_key_state SET active_generation = MAX(active_generation, ?) WHERE singleton = 1").run(liveKeyGeneration);
      }
    });
    personalTx();
  }

  // Readiness stays interrupted while files land and marker cleanup resumes.
  let filesRestored = 0;
  for (const file of data.files) {
    const target = join(memoryDir, file.path);
    if (mode === "merge" && existsSync(target)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content, "utf-8");
    filesRestored++;
  }

  // Embeddings from backups are unreliable (different provider, dimensions, or corrupt).
  // Null durable embeddings so the projection rebuilds them from source text.
  // (The recall projection is invalidated below and rebuilt on demand.)
  db.exec("UPDATE long_term_memories SET embedding = NULL");

  // Save key.verify from backup (enables passphrase verification on fresh installs)
  if (data.keyVerify && liveForgetMarkers.length === 0) {
    const secretDir = join(dirname(memoryDir), "secret");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "key.verify"), data.keyVerify, "utf-8");
  }


  // Files can contain pre-forget payloads even after DB reconciliation. Keep
  // readiness blocked until those artifacts are cleaned and every operation
  // has actually completed. Any exception leaves the interrupted barrier.
  resumePendingForgetCleanup(db, memoryDir);
  const backupPersonal = data.tables.personal_model_state?.[0] as { state?: string; expected_version?: number; actual_version?: number } | undefined;
  if (backupPersonal?.state === "ready" && backupPersonal.expected_version === PERSONAL_MODEL_VERSION && backupPersonal.actual_version === PERSONAL_MODEL_VERSION &&
    !db.prepare("SELECT 1 FROM forget_operations WHERE state = 'pending' LIMIT 1").get()) {
    setPersonalState(db, "ready", { reason: "restore complete: database and artifact forgetting reconciled" });
  }
  // #1928 M2: restored index metadata cannot assert readiness, and
  // pre-restore generations may hide post-backup forgetting. Clear every
  // projection surface; recall is unavailable/index-required until a
  // reviewed rebuild publishes again. Derived data is never restored as
  // serving truth.
  invalidateRecallProjections(db);

  logInfo(TAG, `Restore complete (${mode}): ${restored} memories restored, ${skipped} skipped, ${filesRestored} files`);

  // Report the distinct restored owners: owners are preserved exactly and are
  // never silently relabeled. Restored owners span the new-model personal layers.
  const restoredOwnerSet = new Set<string>();
  for (const table of ["long_term_memories", "short_term_memories", "messages"]) {
    try {
      const rows = db.prepare(`SELECT DISTINCT user_id FROM ${table} ORDER BY user_id`).all() as Array<{ user_id: string }>;
      for (const r of rows) restoredOwnerSet.add(r.user_id);
    } catch { /* table may predate */ }
  }
  const restoredOwners = [...restoredOwnerSet].sort();

  return { restored, skipped, files: filesRestored, restoredOwners, encryptionUser: metaUsername ?? null };
}
