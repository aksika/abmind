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
