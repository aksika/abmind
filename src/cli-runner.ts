/**
 * cli-runner — standard lifecycle for CLIs that operate on the memory backend.
 *
 * Wraps:
 *   - --help short-circuit
 *   - isDirectRun gate (so importing for tests is safe)
 *   - loadMemoryConfig() + createMemoryBackend() + finally close()
 *   - JSON-error envelope on throw
 *
 * Use `runCli` when the handler needs a MemoryBackend.
 * Use `runCliRaw` from ./cli-runner-raw.ts when the CLI opens its own DB
 * (expand, sleep-state, sleep-report) or runs its own process loop (mcp).
 */

import { parseFlags, FlagError, type FlagSpec, type FlagValues } from "./cli-flags.js";
import { loadMemoryConfig } from "./memory-config.js";
import { createMemoryBackend } from "./backend-factory.js";
import { isDirectRun } from "./cli-entry.js";
import type { MemoryBackend } from "./memory-backend.js";

export interface CliDef<F extends FlagValues = FlagValues> {
  readonly name: string;
  readonly help: string;
  readonly flags: readonly FlagSpec[];
  readonly handler: (ctx: { args: F; backend: MemoryBackend }) => Promise<void>;
}

export async function runCli<F extends FlagValues>(
  importMetaUrl: string,
  def: CliDef<F>,
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

  const config = loadMemoryConfig();
  const backend = await createMemoryBackend(config);

  try {
    await def.handler({ args, backend });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  } finally {
    backend.close();
  }
}
