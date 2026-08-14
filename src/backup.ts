/**
 * backup.ts — Encrypted backup/restore for abmind memory.
 * Format: plaintext header (salt, iv, version) + AES-256-GCM encrypted ZIP.
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, hkdfSync } from "node:crypto";
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
  /** Distinct extracted-memory owners present after restore (preserved exactly). */
  restoredOwners: string[];
  /** True when restored owners include a non-primary owner (legacy repair needed). */
  attributionRepairRequired: boolean;
  /** True when the backup lacked sealed-row metadata (#1660): class-3 rows are format 0 or key state is absent. */
  sealedRepairRequired: boolean;
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

  // Export tables (strip embeddings — derived data, regenerated after restore)
  const memories = db.prepare("SELECT * FROM extracted_memories").all().map((r: any) => ({ ...r, embedding: null }));
  const watermarks = db.prepare("SELECT * FROM extraction_watermarks").all();
  const entityGraph = db.prepare("SELECT * FROM entity_graph").all();
  const ingested = db.prepare("SELECT * FROM ingested_documents").all();
  const messages = db.prepare("SELECT * FROM messages").all();
  const secretKeyState = db.prepare("SELECT singleton, active_generation FROM secret_key_state").all();
  const operationalDrafts = db.prepare("SELECT * FROM operational_lesson_drafts").all();
  const operationalMemories = db.prepare("SELECT * FROM operational_memories").all();
  const operationalVersions = db.prepare("SELECT * FROM operational_memory_versions").all();
  const schemaVersion = 17; // current schema version

  // Export .md files (full mode: walk all subdirs except excluded)
  const mdFiles = opts?.dbOnly ? [] : collectFiles(memoryDir);

  // Build ZIP-like JSON payload (using JSON for simplicity — ZIP adds dep)
  const manifest = {
    version: schemaVersion,
    createdAt: Date.now(),
    memoriesCount: memories.length,
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
      extracted_memories: memories,
      extraction_watermarks: watermarks,
      entity_graph: entityGraph,
      ingested_documents: ingested,
      messages,
      secret_key_state: secretKeyState,
      operational_lesson_drafts: operationalDrafts,
      operational_memories: operationalMemories,
      operational_memory_versions: operationalVersions,
    },
    files: mdFiles,
    keyVerify,
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

  logInfo(TAG, `Backup complete: ${memories.length} memories, ${mdFiles.length} files → ${outputPath} (${output.length} bytes)`);
  return { path: outputPath, memories: memories.length, files: mdFiles.length, sizeBytes: output.length };
}

// ── Restore ──────────────────────────────────────────────────────────────────

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
      extracted_memories: any[]; extraction_watermarks: any[]; entity_graph: any[];
      ingested_documents: any[]; messages?: any[];
      secret_key_state?: Array<{ singleton: number; active_generation: number }>;
      operational_lesson_drafts?: any[]; operational_memories?: any[]; operational_memory_versions?: any[];
    };
    files: Array<{ path: string; content: string }>;
    keyVerify?: string | null;
  };

  validateOperationalTables(data.tables);

  let restored = 0;
  let skipped = 0;

  if (mode === "replace") {
    db.exec("DELETE FROM extracted_memories");
    db.exec("DELETE FROM extraction_watermarks");
    db.exec("DELETE FROM entity_graph");
    db.exec("DELETE FROM ingested_documents");
    db.exec("DELETE FROM messages");
  }

  // Restore extracted_memories
  const memCols = Object.keys(data.tables.extracted_memories[0] ?? {});
  if (memCols.length > 0 && data.tables.extracted_memories.length > 0) {
    // Get current table columns for forward-compat
    const tableInfo = db.prepare("PRAGMA table_info(extracted_memories)").all() as Array<{ name: string }>;
    const validCols = new Set(tableInfo.map(c => c.name));
    const useCols = memCols.filter(c => validCols.has(c));

    const placeholders = useCols.map(() => "?").join(",");
    const insertSql = mode === "merge"
      ? `INSERT OR IGNORE INTO extracted_memories (${useCols.join(",")}) VALUES (${placeholders})`
      : `INSERT INTO extracted_memories (${useCols.join(",")}) VALUES (${placeholders})`;
    const stmt = db.prepare(insertSql);

    const tx = db.transaction(() => {
      for (const row of data.tables.extracted_memories) {
        const values = useCols.map(c => {
          const v = row[c];
          if (v === null || v === undefined) return null;
          if (typeof v === "object") return JSON.stringify(v);
          return v;
        });
        const result = stmt.run(values);
        if (result.changes > 0) restored++;
        else skipped++;
      }
    });
    tx();
  }

  // Restore entity_graph (#1658 owner-scoped). New backups carry user_id;
  // legacy rows without it derive an owner from their restored source memory
  // and are skipped when the source is missing or ambiguous. Source-backed
  // edges validate that the source belongs to the edge owner. The whole graph
  // restore runs in one transaction so a failure cannot leave mixed schemas/data.
  if (data.tables.entity_graph.length > 0) {
    const graphTx = db.transaction(() => {
      const insert = db.prepare(
        mode === "merge"
          ? "INSERT OR IGNORE INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
          : "INSERT INTO entity_graph (user_id, entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      );
      for (const row of data.tables.entity_graph) {
        const userId = typeof row.user_id === "string" && row.user_id.trim() !== "" ? row.user_id : null;
        let owner = userId;
        if (!owner) {
          // Legacy shape: derive the owner from the restored source memory.
          const source = row.source_memory_id != null
            ? db.prepare("SELECT user_id FROM extracted_memories WHERE id = ?").get(row.source_memory_id) as { user_id: string } | undefined
            : undefined;
          if (!source) continue; // unattributable legacy edge — discard
          owner = source.user_id;
        }
        // Validate source ownership for source-backed edges.
        if (row.source_memory_id != null) {
          const source = db.prepare("SELECT user_id FROM extracted_memories WHERE id = ?").get(row.source_memory_id) as { user_id: string } | undefined;
          if (!source || source.user_id !== owner) continue;
        }
        insert.run(owner, row.entity_a, row.entity_b, row.relation, row.source_memory_id ?? null, row.created_at, row.last_seen_at);
      }
    });
    graphTx();
  }

  // Restore extraction_watermarks
  if (data.tables.extraction_watermarks.length > 0) {
    const stmt = db.prepare("INSERT OR REPLACE INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)");
    for (const row of data.tables.extraction_watermarks) {
      stmt.run(row.user_id, row.last_processed_timestamp);
    }
  }

  // #1660: restore the secrets key-generation ledger. A backup without the
  // table supplies the safe default generation and is reported as legacy
  // sealed repair required — the generation mismatch is a reported
  // inconsistency for the operator, never something restore auto-repairs.
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

  // Restore ingested_documents
  if (data.tables.ingested_documents.length > 0) {
    const stmt = db.prepare(
      mode === "merge"
        ? "INSERT OR IGNORE INTO ingested_documents (user_id, source_type, identifier, chunk_count, ingested_at) VALUES (?, ?, ?, ?, ?)"
        : "INSERT INTO ingested_documents (user_id, source_type, identifier, chunk_count, ingested_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const row of data.tables.ingested_documents) {
      stmt.run(row.user_id, row.source_type, row.identifier, row.chunk_count, row.ingested_at);
    }
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
        stmt.run(values);
      }
    });
    tx();
    restored += data.tables.messages.length;
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

  // Restore .md files
  let filesRestored = 0;
  for (const file of data.files) {
    const target = join(memoryDir, file.path);
    if (mode === "merge" && existsSync(target)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, file.content, "utf-8");
    filesRestored++;
  }

  // FTS rebuild (replace only — merge uses INSERT triggers)
  if (mode === "replace") {
    try {
      db.exec("INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('rebuild')");
      db.exec("INSERT INTO content_en_trigram(content_en_trigram) VALUES('rebuild')");
      db.exec("INSERT INTO content_original_trigram(content_original_trigram) VALUES('rebuild')");
    } catch { /* FTS rebuild best-effort */ }
  }

  // Embeddings from backups are unreliable (different provider, dimensions, or corrupt).
  // Null them so they regenerate cleanly on next use.
  db.exec("UPDATE extracted_memories SET embedding = NULL");

  // Save key.verify from backup (enables passphrase verification on fresh installs)
  if (data.keyVerify) {
    const secretDir = join(dirname(memoryDir), "secret");
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(secretDir, "key.verify"), data.keyVerify, "utf-8");
  }

  // #1660: any restored class-3 row that is not sealed format 1 (legacy
  // encrypted/plaintext rows from pre-#1660 backups) needs the reviewed
  // migration; a backup without key state is reported the same way.
  const unsealedClass3 = (db.prepare(
    "SELECT COUNT(*) as c FROM extracted_memories WHERE classification >= 3 AND (sealed_format_version IS NULL OR sealed_format_version != 1)",
  ).get() as { c: number }).c;
  const sealedRepairRequired = unsealedClass3 > 0 || !backupHasKeyState;

  logInfo(TAG, `Restore complete (${mode}): ${restored} memories restored, ${skipped} skipped, ${filesRestored} files`);

  // Report the distinct restored owners: owners are preserved exactly and are
  // never silently relabeled. When a non-primary owner is present, the
  // operator must run the attribution-repair gate before strict-owner code
  // starts against this database.
  const restoredOwners = (db.prepare(
    "SELECT DISTINCT user_id FROM extracted_memories ORDER BY user_id",
  ).all() as Array<{ user_id: string }>).map((row) => row.user_id);
  const primary = resolveSavedUserIdOrNull(dirname(memoryDir));
  const attributionRepairRequired = primary !== null && restoredOwners.some((owner) => owner !== primary);

  return { restored, skipped, files: filesRestored, restoredOwners, attributionRepairRequired, sealedRepairRequired };
}
