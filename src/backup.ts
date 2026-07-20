/**
 * backup.ts — Encrypted backup/restore for abmind memory.
 * Format: plaintext header (salt, iv, version) + AES-256-GCM encrypted ZIP.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, pbkdf2Sync, hkdfSync } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
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

export type PrincipalTransferValue =
  | null
  | number
  | string
  | { blobBase64: string }
  | { integerDecimal: string };

export interface PrincipalTransferTable {
  name: string;
  columns: string[];
  rows: PrincipalTransferValue[][];
}

export interface PrincipalTransferFile {
  path: string;
  dataBase64: string;
  mode: number;
}

export interface PrincipalTransferPacket {
  format: "abmind-principal-transfer";
  version: 1;
  principalId: string;
  scope: "principal" | "exclusive-store";
  tables: PrincipalTransferTable[];
  files: PrincipalTransferFile[];
  manifest: {
    schemaDigest: string;
    digest: string;
    tableCounts: Record<string, number>;
  };
}

export interface PrincipalImportResult {
  status: "imported";
  principalId: string;
  digest: string;
  tableCounts: Record<string, number>;
}

export interface PrincipalVerificationResult {
  principalId: string;
  digest: string;
  tableCounts: Record<string, number>;
}

interface PrincipalTransferReceipt {
  format: "abmind-principal-transfer-receipt";
  version: 1;
  principalId: string;
  digest: string;
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

interface PrincipalTableSpec {
  name: string;
  predicate: string;
  orderBy: string;
}

const PRINCIPAL_TABLES: readonly PrincipalTableSpec[] = [
  { name: "messages", predicate: "user_id = ?", orderBy: "id" },
  { name: "ingested_documents", predicate: "user_id = ?", orderBy: "id" },
  { name: "extracted_memories", predicate: "user_id = ?", orderBy: "id" },
  {
    name: "entity_graph",
    predicate: "source_memory_id IN (SELECT id FROM extracted_memories WHERE user_id = ?)",
    orderBy: "id",
  },
  { name: "extraction_watermarks", predicate: "user_id = ?", orderBy: "user_id" },
  {
    name: "context_watermarks",
    predicate: "chat_id IN (SELECT session_id FROM messages WHERE user_id = ?)",
    orderBy: "chat_id",
  },
  {
    name: "context_summaries",
    predicate: "chat_id IN (SELECT session_id FROM messages WHERE user_id = ?)",
    orderBy: "id",
  },
  {
    name: "context_checkpoints",
    predicate: "chat_id IN (SELECT session_id FROM messages WHERE user_id = ?)",
    orderBy: "id",
  },
  {
    name: "active_context_checkpoint",
    predicate: "chat_id IN (SELECT session_id FROM messages WHERE user_id = ?)",
    orderBy: "chat_id",
  },
  { name: "abmind_service_requests", predicate: "principal_id = ?", orderBy: "principal_id, idempotency_key" },
];

const EXCLUSIVE_STORE_TABLES: readonly PrincipalTableSpec[] = [
  { name: "operational_memories", predicate: "1 = 1", orderBy: "id" },
  { name: "operational_memory_versions", predicate: "1 = 1", orderBy: "id" },
  { name: "operational_lesson_drafts", predicate: "1 = 1", orderBy: "id" },
];

const PRINCIPAL_TRANSFER_FILE_EXCLUDES = new Set(["backups", "memory.db", "memory.db-wal", "memory.db-shm"]);

function collectPrincipalTransferFiles(
  root: string,
  current = root,
  prefix = "",
  excludedTopLevelPaths: ReadonlySet<string> = new Set(),
): PrincipalTransferFile[] {
  if (!existsSync(current)) return [];
  const files: PrincipalTransferFile[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!prefix && (PRINCIPAL_TRANSFER_FILE_EXCLUDES.has(entry.name) || excludedTopLevelPaths.has(entry.name))) continue;
    if (entry.isSymbolicLink()) throw new Error(`Principal transfer refuses symbolic link: ${prefix}${entry.name}`);
    const absolute = join(current, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...collectPrincipalTransferFiles(root, absolute, relative, excludedTopLevelPaths));
    else if (entry.isFile() && !entry.name.endsWith(".lock")) {
      files.push({
        path: relative,
        dataBase64: readFileSync(absolute).toString("base64"),
        mode: statSync(absolute).mode & 0o777,
      });
    }
  }
  return files;
}

function encodeTransferValue(value: unknown): PrincipalTransferValue {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return { integerDecimal: value.toString(10) };
  if (Buffer.isBuffer(value)) return { blobBase64: value.toString("base64") };
  throw new Error(`Unsupported SQLite value in principal transfer: ${typeof value}`);
}

function decodeTransferValue(value: PrincipalTransferValue): null | number | string | bigint | Buffer {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (Object.keys(value).length !== 1) throw new Error("Invalid tagged value in principal transfer");
  if ("blobBase64" in value && typeof value.blobBase64 === "string") {
    return Buffer.from(value.blobBase64, "base64");
  }
  if ("integerDecimal" in value && /^-?(0|[1-9][0-9]*)$/.test(value.integerDecimal)) {
    return BigInt(value.integerDecimal);
  }
  throw new Error("Invalid tagged value in principal transfer");
}

function tableColumns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name);
}

function schemaDescriptor(db: Database.Database, tables: readonly PrincipalTransferTable[]): unknown {
  const schemaVersion = (db.prepare("SELECT value FROM _meta WHERE key = 'schema_version'").get() as { value?: unknown } | undefined)?.value;
  return {
    schemaVersion: schemaVersion === undefined ? null : String(schemaVersion),
    tables: tables.map(table => {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table.name) as
        | { sql: string | null }
        | undefined;
      return { name: table.name, columns: table.columns, sql: row?.sql ?? null };
    }),
  };
}

function transferPayload(packet: Pick<PrincipalTransferPacket, "format" | "version" | "principalId" | "scope" | "tables" | "files">): string {
  return stableJson({
    format: packet.format,
    version: packet.version,
    principalId: packet.principalId,
    scope: packet.scope,
    tables: packet.tables,
    files: packet.files,
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function principalTransferReceiptKey(principalId: string): string {
  return `principal_transfer_receipt:${sha256(principalId)}`;
}

function principalTransferReceipt(packet: PrincipalTransferPacket): PrincipalTransferReceipt {
  return {
    format: "abmind-principal-transfer-receipt",
    version: 1,
    principalId: packet.principalId,
    digest: packet.manifest.digest,
  };
}

function assertExclusivePrincipalStore(db: Database.Database, principalId: string): void {
  const ids = db.prepare(`
    SELECT user_id AS id FROM messages
    UNION SELECT user_id FROM ingested_documents
    UNION SELECT user_id FROM extracted_memories
    UNION SELECT user_id FROM extraction_watermarks
    UNION SELECT principal_id FROM abmind_service_requests
  `).all() as Array<{ id: string }>;
  const foreign = ids.map(row => row.id).filter(id => id !== principalId);
  if (foreign.length > 0) {
    throw new Error(`Exclusive principal transfer refused: store contains other principals (${foreign.join(", ")})`);
  }
}

function buildPrincipalTransfer(
  db: Database.Database,
  principalId: string,
  options: {
    scope: "principal" | "exclusive-store";
    memoryDir?: string;
    excludedTopLevelPaths?: readonly string[];
    skipFileCollection?: boolean;
  },
): PrincipalTransferPacket {
  if (principalId.length === 0) throw new Error("principalId must not be empty");
  if (options.scope === "exclusive-store") assertExclusivePrincipalStore(db, principalId);
  const specs = options.scope === "exclusive-store"
    ? [
        ...PRINCIPAL_TABLES.map(spec => ({ ...spec, predicate: "1 = 1" })),
        ...EXCLUSIVE_STORE_TABLES,
      ]
    : [...PRINCIPAL_TABLES];
  const tables = specs.map(spec => {
    const columns = tableColumns(db, spec.name);
    if (columns.length === 0) throw new Error(`Principal transfer table is missing: ${spec.name}`);
    const statement = db.prepare(`SELECT * FROM ${spec.name} WHERE ${spec.predicate} ORDER BY ${spec.orderBy}`);
    statement.safeIntegers(true);
    const rawRows = (spec.predicate === "1 = 1" ? statement.all() : statement.all(principalId)) as Array<Record<string, unknown>>;
    return {
      name: spec.name,
      columns,
      rows: rawRows.map(row => columns.map(column => encodeTransferValue(row[column]))),
    };
  });
  if (options.scope === "exclusive-store" && !options.memoryDir) {
    throw new Error("Exclusive principal transfer requires memoryDir");
  }
  const files = options.scope === "exclusive-store" && !options.skipFileCollection
    ? collectPrincipalTransferFiles(
        options.memoryDir!,
        options.memoryDir!,
        "",
        new Set(options.excludedTopLevelPaths ?? []),
      )
    : [];
  const core = {
    format: "abmind-principal-transfer" as const,
    version: 1 as const,
    principalId,
    scope: options.scope,
    tables,
    files,
  };
  const tableCounts = Object.fromEntries(tables.map(table => [table.name, table.rows.length]));
  return {
    ...core,
    manifest: {
      schemaDigest: sha256(stableJson(schemaDescriptor(db, tables))),
      digest: sha256(transferPayload(core)),
      tableCounts,
    },
  };
}

function assertDatabaseIntegrity(db: Database.Database): void {
  const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity check failed: ${rows.map(row => row.integrity_check).join(", ")}`);
  }
}

/**
 * Export state attributable to one principal. Exclusive-store mode additionally
 * includes store-scoped operational memory and files after proving that no
 * second principal is present. Derived search indexes rebuild through triggers.
 */
export function exportPrincipalTransfer(
  db: Database.Database,
  principalId: string,
  options: {
    scope?: "principal" | "exclusive-store";
    memoryDir?: string;
    excludedTopLevelPaths?: readonly string[];
  } = {},
): PrincipalTransferPacket {
  const checkpoint = db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
  if (checkpoint[0]?.busy !== 0) throw new Error("Cannot export principal while the WAL checkpoint is busy");
  assertDatabaseIntegrity(db);
  return db.transaction(() =>
    buildPrincipalTransfer(db, principalId, {
      scope: options.scope ?? "principal",
      memoryDir: options.memoryDir,
      excludedTopLevelPaths: options.excludedTopLevelPaths,
    }),
  )();
}

function validatePrincipalPacket(db: Database.Database, packet: PrincipalTransferPacket): void {
  if (packet.format !== "abmind-principal-transfer" || packet.version !== 1) {
    throw new Error("Unsupported principal transfer format or version");
  }
  if (!packet.principalId) throw new Error("Principal transfer packet has an empty principalId");
  if (packet.scope !== "principal" && packet.scope !== "exclusive-store") {
    throw new Error("Unsupported principal transfer scope");
  }
  const expectedNames = (packet.scope === "exclusive-store"
    ? [...PRINCIPAL_TABLES, ...EXCLUSIVE_STORE_TABLES]
    : [...PRINCIPAL_TABLES]).map(spec => spec.name);
  if (stableJson(packet.tables.map(table => table.name)) !== stableJson(expectedNames)) {
    throw new Error("Principal transfer table set or order does not match the contract");
  }
  for (const table of packet.tables) {
    const expectedColumns = tableColumns(db, table.name);
    if (stableJson(table.columns) !== stableJson(expectedColumns)) {
      throw new Error(`Principal transfer schema mismatch for ${table.name}`);
    }
    if (table.rows.some(row => row.length !== table.columns.length)) {
      throw new Error(`Principal transfer row width mismatch for ${table.name}`);
    }
  }
  const schemaDigest = sha256(stableJson(schemaDescriptor(db, packet.tables)));
  if (schemaDigest !== packet.manifest.schemaDigest) throw new Error("Principal transfer schema digest mismatch");
  const digest = sha256(transferPayload(packet));
  if (digest !== packet.manifest.digest) throw new Error("Principal transfer digest mismatch");
  const counts = Object.fromEntries(packet.tables.map(table => [table.name, table.rows.length]));
  if (stableJson(counts) !== stableJson(packet.manifest.tableCounts)) {
    throw new Error("Principal transfer table counts do not match the manifest");
  }
  const filePaths = new Set<string>();
  for (const file of packet.files) {
    if (!file.path || file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error("Principal transfer contains an unsafe file path");
    }
    if (file.path.includes("\\") || filePaths.has(file.path)) {
      throw new Error("Principal transfer contains a duplicate or unsafe file path");
    }
    filePaths.add(file.path);
    if (Buffer.from(file.dataBase64, "base64").toString("base64") !== file.dataBase64) {
      throw new Error(`Principal transfer contains invalid base64 data: ${file.path}`);
    }
    if (!Number.isInteger(file.mode) || file.mode < 0 || file.mode > 0o777) {
      throw new Error(`Principal transfer contains an invalid file mode: ${file.path}`);
    }
  }
  if (packet.scope === "principal" && packet.files.length > 0) {
    throw new Error("Principal-only transfer must not contain store files");
  }
}

function assertPrincipalOwnership(packet: PrincipalTransferPacket): void {
  const byName = new Map(packet.tables.map(table => [table.name, table]));
  const assertColumn = (tableName: string, columnName: string): void => {
    const table = byName.get(tableName)!;
    const index = table.columns.indexOf(columnName);
    if (index < 0) throw new Error(`Principal identity column is missing from ${tableName}`);
    for (const row of table.rows) {
      if (row[index] !== packet.principalId) throw new Error(`Principal ownership mismatch in ${tableName}`);
    }
  };
  for (const table of ["messages", "ingested_documents", "extracted_memories", "extraction_watermarks"]) {
    assertColumn(table, "user_id");
  }
  assertColumn("abmind_service_requests", "principal_id");
  const memories = byName.get("extracted_memories")!;
  const memoryIdIndex = memories.columns.indexOf("id");
  const memoryIds = new Set(memories.rows.map(row => stableJson(row[memoryIdIndex])));
  const graph = byName.get("entity_graph")!;
  const graphSourceIndex = graph.columns.indexOf("source_memory_id");
  if (packet.scope === "principal") {
    if (graph.rows.some(row => !memoryIds.has(stableJson(row[graphSourceIndex])))) {
      throw new Error("Principal ownership mismatch in entity_graph");
    }
    const messages = byName.get("messages")!;
    const sessionIdIndex = messages.columns.indexOf("session_id");
    const sessionIds = new Set(messages.rows.map(row => stableJson(row[sessionIdIndex])));
    for (const tableName of [
      "context_watermarks",
      "context_summaries",
      "context_checkpoints",
      "active_context_checkpoint",
    ]) {
      const table = byName.get(tableName)!;
      const chatIdIndex = table.columns.indexOf("chat_id");
      if (chatIdIndex < 0 || table.rows.some(row => !sessionIds.has(stableJson(row[chatIdIndex])))) {
        throw new Error(`Principal ownership mismatch in ${tableName}`);
      }
    }
  }

  const checkpoints = byName.get("context_checkpoints")!;
  const checkpointIdIndex = checkpoints.columns.indexOf("id");
  const previousIndex = checkpoints.columns.indexOf("previous_checkpoint_id");
  const checkpointIds = new Set(checkpoints.rows.map(row => stableJson(row[checkpointIdIndex])));
  if (checkpoints.rows.some(row => row[previousIndex] !== null && !checkpointIds.has(stableJson(row[previousIndex])))) {
    throw new Error("Principal transfer contains a checkpoint with a missing parent");
  }
  const active = byName.get("active_context_checkpoint")!;
  const activeCheckpointIndex = active.columns.indexOf("checkpoint_id");
  if (active.rows.some(row => !checkpointIds.has(stableJson(row[activeCheckpointIndex])))) {
    throw new Error("Principal transfer contains an active pointer to a missing checkpoint");
  }
}

function safeTransferTarget(memoryDir: string, relativePath: string): string {
  if (relativePath.includes("\\")) throw new Error("Principal transfer contains an unsafe file path");
  const root = resolve(memoryDir);
  const target = resolve(root, ...relativePath.split("/"));
  if (target === root || !target.startsWith(`${root}${sep}`)) {
    throw new Error("Principal transfer contains an unsafe file path");
  }
  let current = root;
  for (const segment of relativePath.split("/").slice(0, -1)) {
    current = join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error(`Principal transfer refuses symbolic-link parent: ${relativePath}`);
    }
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error(`Principal transfer refuses symbolic-link target: ${relativePath}`);
  }
  return target;
}

function verifyImportedPrincipalState(
  db: Database.Database,
  packet: PrincipalTransferPacket,
  memoryDir?: string,
): void {
  const imported = buildPrincipalTransfer(db, packet.principalId, {
    scope: packet.scope,
    memoryDir,
    skipFileCollection: true,
  });
  if (stableJson(imported.tables) !== stableJson(packet.tables)) {
    throw new Error("Principal transfer verification failed: relational state differs");
  }
  if (packet.files.length > 0 && !memoryDir) {
    throw new Error("Principal transfer verification with files requires memoryDir");
  }
  for (const file of packet.files) {
    const target = safeTransferTarget(memoryDir!, file.path);
    if (!existsSync(target) || !readFileSync(target).equals(Buffer.from(file.dataBase64, "base64"))) {
      throw new Error(`Principal transfer verification failed: file differs (${file.path})`);
    }
    if ((statSync(target).mode & 0o777) !== file.mode) {
      throw new Error(`Principal transfer verification failed: file mode differs (${file.path})`);
    }
  }
}

/** Verify a previously exported packet against an imported destination. */
export function verifyPrincipalTransfer(
  db: Database.Database,
  packet: PrincipalTransferPacket,
  options: { memoryDir?: string } = {},
): PrincipalVerificationResult {
  validatePrincipalPacket(db, packet);
  assertPrincipalOwnership(packet);
  assertDatabaseIntegrity(db);
  verifyImportedPrincipalState(db, packet, options.memoryDir);
  return {
    principalId: packet.principalId,
    digest: packet.manifest.digest,
    tableCounts: { ...packet.manifest.tableCounts },
  };
}

/** Verify that this database atomically committed a specific principal transfer. */
export function verifyPrincipalTransferReceipt(
  db: Database.Database,
  packet: PrincipalTransferPacket,
): PrincipalVerificationResult {
  validatePrincipalPacket(db, packet);
  assertPrincipalOwnership(packet);
  assertDatabaseIntegrity(db);
  const row = db.prepare("SELECT value FROM _meta WHERE key = ?").get(principalTransferReceiptKey(packet.principalId)) as
    | { value: unknown }
    | undefined;
  if (!row || typeof row.value !== "string") {
    throw new Error("Principal transfer receipt is missing");
  }
  let receipt: unknown;
  try {
    receipt = JSON.parse(row.value);
  } catch {
    throw new Error("Principal transfer receipt is invalid");
  }
  if (stableJson(receipt) !== stableJson(principalTransferReceipt(packet))) {
    throw new Error("Principal transfer receipt does not match the packet");
  }
  return {
    principalId: packet.principalId,
    digest: packet.manifest.digest,
    tableCounts: { ...packet.manifest.tableCounts },
  };
}

/** Import into an empty isolated database, preserving all IDs and BLOB bytes. */
export function importPrincipalTransfer(
  db: Database.Database,
  packet: PrincipalTransferPacket,
  options: { memoryDir?: string } = {},
): PrincipalImportResult {
  validatePrincipalPacket(db, packet);
  assertPrincipalOwnership(packet);
  assertDatabaseIntegrity(db);

  if (packet.files.length > 0 && !options.memoryDir) {
    throw new Error("Principal transfer with files requires memoryDir");
  }
  const createdFiles: string[] = [];
  const replacedFiles = new Map<string, { data: Buffer; mode: number }>();
  const transaction = db.transaction(() => {
    for (const table of packet.tables) {
      const count = (db.prepare(`SELECT COUNT(*) AS count FROM ${table.name}`).get() as { count: number }).count;
      if (count !== 0) throw new Error(`Principal transfer destination is not empty: ${table.name}`);
    }

    for (const table of packet.tables) {
      if (table.rows.length === 0) continue;
      const columns = table.columns.map(column => `"${column}"`).join(", ");
      const placeholders = table.columns.map(() => "?").join(", ");
      const insert = db.prepare(`INSERT INTO ${table.name} (${columns}) VALUES (${placeholders})`);
      for (const row of table.rows) insert.run(...row.map(decodeTransferValue));
    }

    for (const file of packet.files) {
      const target = safeTransferTarget(options.memoryDir!, file.path);
      if (existsSync(target)) {
        replacedFiles.set(target, { data: readFileSync(target), mode: statSync(target).mode & 0o777 });
      } else {
        createdFiles.push(target);
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(file.dataBase64, "base64"), { mode: file.mode });
      chmodSync(target, file.mode);
      if (!readFileSync(target).equals(Buffer.from(file.dataBase64, "base64"))) {
        throw new Error(`Principal transfer file verification failed: ${file.path}`);
      }
    }

    verifyImportedPrincipalState(db, packet, options.memoryDir);
    db.prepare("INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)").run(
      principalTransferReceiptKey(packet.principalId),
      stableJson(principalTransferReceipt(packet)),
    );
    assertDatabaseIntegrity(db);
  });
  try {
    transaction();
  } catch (error) {
    for (const path of createdFiles) rmSync(path, { force: true });
    for (const [path, original] of replacedFiles) {
      writeFileSync(path, original.data, { mode: original.mode });
      chmodSync(path, original.mode);
    }
    throw error;
  }
  return {
    status: "imported",
    principalId: packet.principalId,
    digest: packet.manifest.digest,
    tableCounts: { ...packet.manifest.tableCounts },
  };
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

  logInfo(TAG, `Restore complete (${mode}): ${restored} memories restored, ${skipped} skipped, ${filesRestored} files`);
  return { restored, skipped, files: filesRestored };
}
