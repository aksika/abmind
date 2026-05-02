import { pathToFileURL } from "node:url";

/**
 * True when the module at `importMetaUrl` is being executed directly:
 *   - as a script (node dist/cli/abmind-<x>.js or tsx src/... .ts)
 *   - via the unified `abmind` dispatcher (argv[1] ends /abmind or \abmind)
 *
 * Returns false when imported (e.g. for unit tests that import pure helpers).
 * Replaces the hand-rolled isDirectRun blocks in abmind-store/edit/retro-extract/expand.
 */
export function isDirectRun(importMetaUrl: string): boolean {
  const entry = process.argv[1] ?? "";
  if (!entry) return false;
  // Unified dispatcher bin path (symlink) OR compiled / source dispatcher invoked via direct node path.
  if (entry.endsWith("/abmind") || entry.endsWith("\\abmind")) return true;
  if (entry.endsWith("/abmind.js") || entry.endsWith("\\abmind.js")) return true;
  if (entry.endsWith("/abmind.ts") || entry.endsWith("\\abmind.ts")) return true;
  // Direct script execution: argv[1] IS this module's file path.
  try {
    return importMetaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
