/**
 * backup.ts — Encrypted backup/restore for abmind memory.
 * Format: plaintext header (salt, iv, version) + AES-256-GCM encrypted ZIP.
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, hkdfSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { deflateSync, inflateSync } from "node:zlib";
import type Database from "better-sqlite3";
import { logInfo } from "./mem-logger.js";

import { getBackupKey, deriveFromPassphrase } from "./crypto.js";

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

function collectMdFiles(baseDir: string, subDirs: string[]): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  for (const sub of subDirs) {
    const dir = join(baseDir, sub);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      files.push({ path: `${sub}/${f}`, content: readFileSync(join(dir, f), "utf-8") });
    }
  }
  return files;
}

// ── Backup ───────────────────────────────────────────────────────────────────

export function createBackup(db: Database.Database, memoryDir: string, passphrase: string | undefined, outputPath: string, opts?: { dbOnly?: boolean }): BackupResult {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = resolveKey(passphrase);

  // Export tables
  const memories = db.prepare("SELECT * FROM extracted_memories").all();
  const watermarks = db.prepare("SELECT * FROM extraction_watermarks").all();
  const entityGraph = db.prepare("SELECT * FROM entity_graph").all();
  const ingested = db.prepare("SELECT * FROM ingested_documents").all();
  const schemaVersion = 17; // current schema version

  // Export .md files
  const mdFiles = opts?.dbOnly ? [] : collectMdFiles(memoryDir, ["daily", "weekly", "quarterly", "retrospectives", "core"]);

  // Build ZIP-like JSON payload (using JSON for simplicity — ZIP adds dep)
  const manifest = {
    version: schemaVersion,
    createdAt: Date.now(),
    memoriesCount: memories.length,
    filesCount: mdFiles.length,
  };

  const payload = JSON.stringify({
    manifest,
    tables: {
      extracted_memories: memories,
      extraction_watermarks: watermarks,
      entity_graph: entityGraph,
      ingested_documents: ingested,
    },
    files: mdFiles,
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
    tables: { extracted_memories: any[]; extraction_watermarks: any[]; entity_graph: any[]; ingested_documents: any[] };
    files: Array<{ path: string; content: string }>;
  };

  let restored = 0;
  let skipped = 0;

  if (mode === "replace") {
    // Wipe existing data
    db.exec("DELETE FROM extracted_memories");
    db.exec("DELETE FROM extraction_watermarks");
    db.exec("DELETE FROM entity_graph");
    db.exec("DELETE FROM ingested_documents");
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

  // Restore entity_graph
  if (data.tables.entity_graph.length > 0) {
    const stmt = db.prepare(
      mode === "merge"
        ? "INSERT OR IGNORE INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
        : "INSERT INTO entity_graph (entity_a, entity_b, relation, source_memory_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
    );
    for (const row of data.tables.entity_graph) {
      stmt.run(row.entity_a, row.entity_b, row.relation, row.source_memory_id, row.created_at, row.last_seen_at);
    }
  }

  // Restore extraction_watermarks
  if (data.tables.extraction_watermarks.length > 0) {
    const stmt = db.prepare("INSERT OR REPLACE INTO extraction_watermarks (user_id, last_processed_timestamp) VALUES (?, ?)");
    for (const row of data.tables.extraction_watermarks) {
      stmt.run(row.user_id, row.last_processed_timestamp);
    }
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

  logInfo(TAG, `Restore complete (${mode}): ${restored} memories restored, ${skipped} skipped, ${filesRestored} files`);
  return { restored, skipped, files: filesRestored };
}

