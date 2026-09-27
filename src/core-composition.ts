/**
 * core-composition.ts — one owner for core-knowledge composition (#1869).
 *
 * abmind ships standalone with several harnesses (daemon RPC dispatch, the
 * `abmind bundle` CLI, hook wakeup, host plugins), and each of them used to
 * join its own subset of the core files with its own answer — the CLI
 * omitted `core_facts.md` entirely, the hook only presence-checked, the
 * plugin injected none. A harness assembling model-bound context consumes
 * this module instead of reading core files itself; a model-bound surface
 * that reads core content by any other route is a defect.
 *
 * Two layers, deliberately separate:
 * - `readCoreParts` is truthful: every file that exists, verbatim. Operator
 *   views (presence checks, `/facts`) read through it and never go blank.
 * - `getSessionParts` (via MemoryManager) is the model-bound view: under
 *   `MEMORY_TEST=ON` every memory-derived part is empty except
 *   `memoryTools`, so the agent still knows how to query.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAbmindEnv } from "./env-schema.js";

/** Addressable core parts. Key names match the RPC `parts` map and the
 *  legacy `soulBundle` shape so both projections carry identical content. */
export interface CoreParts {
  soul: string;
  profile: string;
  notes: string;
  memoryTools: string;
  coreFacts: string;
}

const CORE_FILES: Record<keyof CoreParts, string> = {
  soul: "SOUL.md",
  profile: "user_profile.md",
  notes: "agent_notes.md",
  memoryTools: "memory-tools.md",
  coreFacts: "core_facts.md",
};

/** The `abmind bundle` CLI order, preserved: pre-existing four parts in
 *  their historical order, `coreFacts` appended (it never reached that
 *  surface before #1869). */
export const CORE_CLI_ORDER: readonly (keyof CoreParts)[] =
  ["soul", "memoryTools", "profile", "notes", "coreFacts"];

/** Truthful read of every core file. No suppression, no env access — this
 *  is the file-read layer, not an assembly boundary. */
export function readCoreParts(memoryDir: string): CoreParts {
  const coreDir = join(memoryDir, "core");
  const read = (name: string): string => {
    try {
      const p = join(coreDir, name);
      return existsSync(p) ? readFileSync(p, "utf-8").trim() : "";
    } catch { return ""; }
  };
  return {
    soul: read(CORE_FILES.soul),
    profile: read(CORE_FILES.profile),
    notes: read(CORE_FILES.notes),
    memoryTools: read(CORE_FILES.memoryTools),
    coreFacts: read(CORE_FILES.coreFacts),
  };
}

/** Process-lifetime test-mode switch. Resolves through the memoized env
 *  like every other flag; toggling requires a restart, tests use
 *  `_resetAbmindEnv()`. */
export function isMemoryTestMode(): boolean {
  return getAbmindEnv().memoryTest;
}

/**
 * Model-bound view of the parts. Under `MEMORY_TEST=ON` the invariant is
 * "no memory-derived content enters the assembled context": identity, user
 * knowledge, standing rules and curated facts all drop out, while
 * `memory-tools.md` stays so the agent still knows how to query.
 */
export function suppressCoreParts(parts: CoreParts): CoreParts {
  return { soul: "", profile: "", notes: "", memoryTools: parts.memoryTools, coreFacts: "" };
}

/** Join non-empty parts in the given key order. An empty part is simply
 *  not injected; a fully empty selection joins to "". */
export function joinCoreParts(
  parts: CoreParts,
  keys: readonly (keyof CoreParts)[] = CORE_CLI_ORDER,
): string {
  return keys.map((k) => parts[k]).filter((p) => p.length > 0).join("\n\n---\n\n");
}
