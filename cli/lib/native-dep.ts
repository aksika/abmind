/**
 * cli/lib/native-dep.ts — shared resolution helper for native deps.
 *
 * Per #1245 + #1266: better-sqlite3 and sqlite-vec are NOT bundled with abmind.
 * They're installed once at ~/.local/lib/node_modules/ (shared with abtars)
 * via `abmind deps install`. Both products resolve from that shared location
 * at runtime.
 *
 * This helper centralizes the resolution so the 5 CLI sites that touch the
 * DB don't each inline their own createRequire dance. Mirrors abtars's
 * `resolveNativeDep()` in src/utils/lazy-require.ts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);
const SHARED_NM = join(homedir(), ".local", "lib", "node_modules");

export type NativeDepName = "better-sqlite3" | "sqlite-vec";

export function requireNativeDep(name: NativeDepName): any {
  const sharedPath = join(SHARED_NM, name);
  if (existsSync(sharedPath)) return _require(sharedPath);
  return _require(name);
}
