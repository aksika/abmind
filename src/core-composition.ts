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

// ── #1859 agent_notes.md budgets ────────────────────────────────────────────
// One capped agent-curated file: the 8 KiB UTF-8 ceiling bounds both the
// file after every sleep edit (enforced at apply time in proposals.ts) and
// the default model-bound session injection here. A pre-existing oversized
// file is never destructively rewritten: injection carries a deterministic
// bounded excerpt at complete entry boundaries plus an explicit omission
// marker, and the overflow is reported so curation can reduce it.

/** Hard cap for agent_notes.md: file size after sleep edits and default
 *  session injection alike. */
export const AGENT_NOTES_BUDGET_BYTES = 8 * 1024;

/** Omission marker appended to a budgeted excerpt. Carries the withheld
 *  byte count so the omission is visible, never silent. */
export function notesOmissionMarker(omittedBytes: number): string {
  return `\n\n[…${omittedBytes} bytes of agent_notes.md omitted — over the 8 KiB session budget; the full file is preserved for curation…]`;
}

export interface NotesBudgetView {
  text: string;
  truncated: boolean;
  totalBytes: number;
  injectedBytes: number;
}

/** Split notes into blank-line-delimited entries for boundary-safe truncation. */
function splitNoteEntries(notes: string): string[] {
  return notes.split(/(\n[ \t]*\n)/g);
}

/** Model-bound view of agent_notes.md: at most 8 KiB, truncated only at
 *  complete entry boundaries, with an explicit omission marker. Pure. */
export function applyNotesReadBudget(notes: string): NotesBudgetView {
  const totalBytes = Buffer.byteLength(notes, "utf-8");
  if (totalBytes <= AGENT_NOTES_BUDGET_BYTES) {
    return { text: notes, truncated: false, totalBytes, injectedBytes: totalBytes };
  }
  const parts = splitNoteEntries(notes);
  let kept = "";
  let keptBytes = 0;
  for (let i = 0; i < parts.length; i += 2) {
    const block = parts[i] ?? "";
    const blockBytes = Buffer.byteLength(block, "utf-8");
    const separator = i === 0 ? "" : (parts[i - 1] ?? "");
    const separatorBytes = Buffer.byteLength(separator, "utf-8");
    if (keptBytes + separatorBytes + blockBytes > AGENT_NOTES_BUDGET_BYTES) break;
    kept += separator + block;
    keptBytes += separatorBytes + blockBytes;
  }
  const marker = notesOmissionMarker(totalBytes - keptBytes);
  return { text: kept + marker, truncated: true, totalBytes, injectedBytes: Buffer.byteLength(kept + marker, "utf-8") };
}
