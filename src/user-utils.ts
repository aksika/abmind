import { getAbmindEnv } from "./env-schema.js";
/** User utilities — resolve master userId from users.json. */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Load master userId from users.json.
 * Falls back to "master" if file missing or no master found.
 */
export function loadMasterUserId(configDir?: string): string {
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
  return "master";
}
