/**
 * native-loader — loads native Node addons from ~/.abmind/lib/node_modules/.
 * Survives abtars updates (persistent path, not in release node_modules).
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const LIB_DIR = join(process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind"), "lib", "node_modules");
const nativeRequire = createRequire(join(LIB_DIR, "_"));

/** Load a native addon from ~/.abmind/lib/node_modules/. Falls back to standard require. */
export function loadNative<T = unknown>(name: string): T {
  try {
    return nativeRequire(name) as T;
  } catch {
    // Fallback: require from package's own node_modules (dev/test)
    const localRequire = createRequire(import.meta.url);
    return localRequire(name) as T;
  }
}
