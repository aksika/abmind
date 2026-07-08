/**
 * abmind update — CLI argument parsing (#1308).
 *
 * Extracted from abmind-update.ts into a side-effect-free module so it can be
 * unit-tested. abmind-update.ts is dispatched via import-side-effects (the
 * abmind dispatcher does a bare `await load(file)`), so the main module cannot
 * be imported in a test without firing run()/process.exit. This module has no
 * side effects and no path resolution — `localDir` is the raw token; the caller
 * resolves it to an absolute path.
 */

export type Channel = "dev" | "alpha" | "stable";

export interface ParsedArgs {
  readonly channel: Channel;
  /** Raw `<DIR>` token for `--dev <DIR>` (may be relative). Undefined → pull mode. */
  readonly localDir?: string;
}

/**
 * Parse `abmind update` argv.
 *
 * - `--dev` with no dir (or followed by another flag) → pull mode (localDir undefined).
 * - `--dev <DIR>` → manual mode (build that tree as-is, no git fetch).
 * - Multiple channels → "error" (keeps strictness: `--dev --alpha` is rejected,
 *   not silently reinterpreted as an alpha install).
 */
export function parseArgs(argv: readonly string[]): ParsedArgs | "help" | "error" {
  let channel: Channel | null = null;
  let localDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dev") {
      if (channel) return "error";                   // multiple channels → error
      channel = "dev";
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {          // explicit dir → manual mode
        localDir = next;
        i++;
      }
      // no dir (or next is a flag) → localDir stays undefined → pull mode
    } else if (a === "--alpha") {
      if (channel) return "error";                   // e.g. `--dev --alpha` → error
      channel = "alpha";
    } else if (a === "--stable") {
      if (channel) return "error";
      channel = "stable";
    } else if (a === "--help" || a === "-h") {
      return "help";
    } else {
      return "error";
    }
  }
  if (!channel) return "error";
  return { channel, localDir };
}
