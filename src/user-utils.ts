import { getAbmindEnv } from "./env-schema.js";
/** User utilities — resolve the saved abmind user identity. */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** Resolve master userId from users.json (legacy adapter config), or null when none is saved. */
export function resolveMasterUserIdOrNull(configDir?: string): string | null {
  const paths = [
    configDir ? join(configDir, "users.json") : null,
    join(getAbmindEnv().abmindHome, "config", "users.json"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const data = JSON.parse(readFileSync(p, "utf-8"));
      const master = data.users?.find((u: { role: string }) => u.role === "master");
      if (master?.userId) return master.userId;
    } catch { /* invalid json */ }
  }
  return null;
}

/**
 * Load master userId from users.json.
 * Falls back to "master" if file missing or no master found.
 */
export function loadMasterUserId(configDir?: string): string {
  return resolveMasterUserIdOrNull(configDir) ?? "master";
}

/**
 * #1608: the saved abmind user identity is `encryptionUser` in the abmind
 * home manifest.json — persisted by `abmind install` (seeded once from the
 * host's users.json master at install time; see cli/abmind-install.ts).
 * This is the identity abmind itself owns; the sleep pipeline must never
 * reach into host configs.
 */
export function resolveSavedUserIdOrNull(homeDir?: string): string | null {
  const manifestPath = join(homeDir ?? getAbmindEnv().abmindHome, "manifest.json");
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const saved = manifest?.encryptionUser;
    if (typeof saved === "string" && saved.trim() !== "") return saved;
  } catch { /* malformed manifest */ }
  return null;
}

/**
 * #1608: canonical sleep identity bootstrap.
 *
 * ABMIND_USER_ID is the only canonical primary-user identity. This helper
 * returns it when explicitly supplied (never overwriting it). When the
 * variable is absent, it is initialized from the saved identity in
 * manifest.json (encryptionUser) — the user persisted by setup/install.
 * Returns null when no identity is configured at all; callers must then
 * fail with a clear configuration error instead of guessing a user.
 */
export function ensurePrimaryUserId(homeDir?: string): string | null {
  const explicit = process.env["ABMIND_USER_ID"];
  if (explicit && explicit.trim() !== "") return explicit;
  const saved = resolveSavedUserIdOrNull(homeDir);
  if (saved) process.env["ABMIND_USER_ID"] = saved;
  return saved;
}

/** Typed configuration/ownership failure for the canonical primary identity. */
export type PrimaryIdentityErrorCode =
  | "primary_identity_missing"
  | "non_primary_memory_owner";

export class PrimaryIdentityError extends Error {
  readonly code: PrimaryIdentityErrorCode;
  constructor(code: PrimaryIdentityErrorCode, message: string) {
    super(message);
    this.name = "PrimaryIdentityError";
    this.code = code;
  }
}

/**
 * Resolve the canonical primary identity or fail with a typed configuration
 * error. Never substitutes "master", "default", "unknown" or any placeholder.
 */
export function requirePrimaryUserId(homeDir?: string): string {
  const resolved = ensurePrimaryUserId(homeDir);
  if (!resolved) {
    throw new PrimaryIdentityError(
      "primary_identity_missing",
      "no primary user identity configured (ABMIND_USER_ID or manifest.json encryptionUser)",
    );
  }
  return resolved;
}

/**
 * Return the canonical primary identity only when it exactly equals
 * `requestedUserId`. Never rewrites the request; a foreign request is a
 * configuration/ownership error, not a fallback.
 */
export function assertPrimaryMemoryOwner(requestedUserId: string, homeDir?: string): string {
  const canonical = requirePrimaryUserId(homeDir);
  if (canonical !== requestedUserId) {
    throw new PrimaryIdentityError(
      "non_primary_memory_owner",
      `requested owner "${requestedUserId}" is not the primary memory owner "${canonical}"`,
    );
  }
  return canonical;
}

/**
 * #1863 Step 0: resolve the owner's immutable primary-identity snapshot.
 * Manifest-only: reads the saved `encryptionUser` once at owner startup and
 * never consults ambient `ABMIND_USER_ID`, so a stale or foreign export
 * cannot become the authority. Throws when no identity is saved — the owner
 * must not serve ownership-sensitive work without one. A null return is
 * never used: callers that cannot resolve fail, they do not fall back.
 */
export function resolveOwnerSnapshot(homeDir?: string): string {
  const saved = resolveSavedUserIdOrNull(homeDir);
  if (!saved) {
    throw new PrimaryIdentityError(
      "primary_identity_missing",
      "no primary user identity saved (manifest.json encryptionUser missing) — re-run abmind install to persist the identity before serving ownership-sensitive work",
    );
  }
  return saved;
}

/**
 * #1863 Step 0: assert a request/run principal against the startup snapshot.
 * Equivalent of `assertPrimaryMemoryOwner()` with an explicit canonical side,
 * so owner checks never re-read `process.env`. Exact equality; a foreign
 * principal is an ownership error, not a fallback.
 */
export function assertSnapshotOwner(requestedUserId: string, snapshot: string): string {
  if (snapshot !== requestedUserId) {
    throw new PrimaryIdentityError(
      "non_primary_memory_owner",
      `requested owner "${requestedUserId}" is not the primary memory owner "${snapshot}"`,
    );
  }
  return snapshot;
}
