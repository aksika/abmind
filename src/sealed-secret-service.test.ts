import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeDatabase } from "./memory-db.js";
import {
  findSealedSecrets,
  resolveSealedSecret,
} from "./sealed-secret-service.js";
import { encrypt, _resetKeyCache } from "./crypto.js";
import { _resetAbmindEnv } from "./env-schema.js";
import { isMethodAllowed } from "./remote/remote-policy.js";
import type Database from "better-sqlite3";

describe("#1660 sealed search and local-only resolution", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    _resetKeyCache();
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "abmind-sealed-svc-"));
    process.env["ABMIND_KEY_FILE"] = join(tmpDir, "secret", "abmind.key");
    process.env.ABMIND_USER_ID = "test";
    _resetAbmindEnv();
    db = initializeDatabase(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    db.close();
    _resetKeyCache();
    delete process.env["ABMIND_KEY_FILE"];
    _resetAbmindEnv();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function insertSealedRow(overrides: {
    id: number;
    userId?: string;
    label?: string;
    keyword?: string;
    classification?: number;
    format?: number;
    encrypted?: number;
    createdAt?: number;
    value?: string;
    expired?: boolean;
  }): void {
    db.prepare(
      `INSERT INTO extracted_memories
         (id, user_id, content_original, content_en, memory_type, source_timestamp,
          created_at, classification, encrypted, sealed_format_version, preserved_keyword, semantic_revision, valid_to)
       VALUES (?, ?, ?, ?, 'secret', 1000, ?, ?, ?, ?, ?, 1, ?)`,
    ).run(
      overrides.id,
      overrides.userId ?? "test",
      encrypt(overrides.value ?? `secret-value-${overrides.id}`),
      overrides.label ?? `label-${overrides.id}`,
      overrides.createdAt ?? overrides.id * 1000,
      overrides.classification ?? 3,
      overrides.encrypted ?? 1,
      overrides.format ?? 1,
      overrides.keyword ?? null,
      overrides.expired ? "2020-01-01" : null,
    );
  }

  it("finds only owned version-1 rows by label with metadata-only projection", () => {
    insertSealedRow({ id: 1, label: "GitHub personal token", keyword: "github" });
    insertSealedRow({ id: 2, label: "GitHub org token", userId: "other" });
    insertSealedRow({ id: 3, label: "GitHub legacy token", format: 0, encrypted: 0, value: "plaintext" });
    insertSealedRow({ id: 4, label: "GitHub expired token", createdAt: 100, keyword: null, expired: true });

    const refs = findSealedSecrets(db, { userId: "test", query: "GitHub", limit: 10 });
    expect(refs.map((r) => r.memoryId)).toEqual([1]);
    expect(refs[0]).toEqual({
      memoryId: 1,
      semanticRevision: 1,
      label: "GitHub personal token",
      memoryType: "secret",
      createdAt: 1000,
    });
    // Projection contains no content columns.
    expect(JSON.stringify(refs)).not.toContain("secret-value");
    expect(JSON.stringify(refs)).not.toContain("content_original");
  });

  it("finds via trigram-only tokens and dedupes across FTS and trigram", () => {
    insertSealedRow({ id: 1, label: "ssh deployment passphrase" });
    insertSealedRow({ id: 2, label: "ssh passphrase vault" });

    const refs = findSealedSecrets(db, { userId: "test", query: "passphrase", limit: 10 });
    const ids = refs.map((r) => r.memoryId).sort();
    expect(ids).toEqual([1, 2]);
  });

  it("returns nothing for empty or unowned searches", () => {
    insertSealedRow({ id: 1, label: "ssh passphrase" });
    expect(findSealedSecrets(db, { userId: "other", query: "ssh", limit: 10 })).toEqual([]);
    expect(findSealedSecrets(db, { userId: "test", query: "   ", limit: 10 })).toEqual([]);
    // Limits are clamped to [1, 25]; a too-small limit still returns matches.
    const clamped = findSealedSecrets(db, { userId: "test", query: "ssh", limit: 0 });
    expect(clamped.length).toBe(1);
  });

  it("resolves only for the exact owner at the current revision of a version-1 sealed row", () => {
    insertSealedRow({ id: 1, userId: "test", value: "the-real-value" });

    const ok = resolveSealedSecret(db, { userId: "test", memoryId: 1, expectedRevision: 1 });
    expect(ok).toEqual({ ok: true, value: "the-real-value", semanticRevision: 1 });

    // Wrong owner — indistinguishable failure.
    expect(resolveSealedSecret(db, { userId: "other", memoryId: 1, expectedRevision: 1 })).toEqual({ ok: false, code: "sealed_resolution_failed" });
    // Stale revision.
    expect(resolveSealedSecret(db, { userId: "test", memoryId: 1, expectedRevision: 2 })).toEqual({ ok: false, code: "sealed_resolution_failed" });
    // Nonexistent id.
    expect(resolveSealedSecret(db, { userId: "test", memoryId: 999, expectedRevision: 1 })).toEqual({ ok: false, code: "sealed_resolution_failed" });
  });

  it("never resolves version-0 or plaintext legacy rows even for the owner", () => {
    insertSealedRow({ id: 1, format: 0, encrypted: 0, value: "plaintext-value" });
    insertSealedRow({ id: 2, format: 0, encrypted: 1, value: "legacy-cipher" });

    expect(resolveSealedSecret(db, { userId: "test", memoryId: 1, expectedRevision: 1 })).toEqual({ ok: false, code: "sealed_resolution_failed" });
    expect(resolveSealedSecret(db, { userId: "test", memoryId: 2, expectedRevision: 1 })).toEqual({ ok: false, code: "sealed_resolution_failed" });
  });
});

describe("#1660 policy gating", () => {
  it("isMethodAllowed hard-excludes sealed methods for signed peers", () => {
    const context = {
      principalId: "peer",
      role: "peer" as const,
      grantedDomains: new Set(["private", "system"]),
      allowedMethods: new Set(["private.resolveSealedSecret", "private.findSealedSecrets", "system.health"] as never),
      capabilities: new Set<string>(),
      authenticatedBy: "signed_peer" as const,
    };
    expect(isMethodAllowed("private.resolveSealedSecret", context)).toBe(false);
    expect(isMethodAllowed("private.findSealedSecrets", context)).toBe(false);
    // Ordinary signed-peer methods still work.
    expect(isMethodAllowed("system.health", context)).toBe(true);
  });
});
