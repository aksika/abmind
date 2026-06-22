/**
 * cli-runner-raw — lifecycle for CLIs that don't use MemoryBackend.
 *
 * Same shape as runCli but without backend open/close. For CLIs that:
 *   - open their own read-only DB (sleep-state, sleep-report, expand)
 *   - open their own sqlite for encryption ops (secrets)
 *   - run their own process loop (mcp) or long-running orchestrator (sleep)
 *
 * Handler owns all resource lifecycle.
 */

import { parseFlags, FlagError, type FlagSpec, type FlagValues } from "./cli-flags.js";
import { isDirectRun } from "./cli-entry.js";

export interface CliDefRaw<F extends FlagValues = FlagValues> {
  readonly name: string;
  readonly help: string;
  readonly flags: readonly FlagSpec[];
  /** If set, prints "abmind <banner>\nVersion: X (SHA)\n\n" before handler. */
  readonly banner?: string;
  readonly handler: (ctx: { args: F }) => Promise<void> | void;
}

export async function runCliRaw<F extends FlagValues>(
  importMetaUrl: string,
  def: CliDefRaw<F>,
): Promise<void> {
  if (!isDirectRun(importMetaUrl)) return;

  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(def.help);
    return;
  }

  let args: F;
  try {
    args = parseFlags(argv, def.flags) as F;
  } catch (err) {
    if (err instanceof FlagError) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
      process.exit(1);
    }
    throw err;
  }

  try {
    if (def.banner) {
      const { printBanner } = await import("../cli/banner.js");
      await printBanner(def.banner);
    }
    await def.handler({ args });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
}
