/**
 * gc-codec.ts — the single strict codec for the GC artifact
 * (`<memoryDir>/garbage.json`, #1807 R4).
 *
 * Canonical shape: a JSON object mapping canonical positive decimal message
 * IDs to ISO instants marking when they were classified as garbage:
 * `{"123":"2026-09-20T01:00:00.000Z"}`.
 *
 * Compatibility is deliberately conservative: missing files, `{}`, `[]`, and
 * an empty `messages` wrapper are empty state. Nonempty alternate shapes are
 * preserved untouched and reported as incompatible — never converted, never
 * granted deletion authority, never overwritten by this path.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type GcMarks = Map<number, string>;

export type GcFileStatus =
  | { kind: "ok"; marks: GcMarks }
  | { kind: "empty" }
  | { kind: "incompatible"; detail: string };

function isCanonicalIdText(text: string): boolean {
  if (!/^[1-9]\d*$/.test(text)) return false;
  const n = Number(text);
  return Number.isSafeInteger(n);
}

function isIsoInstant(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  const t = Date.parse(text);
  return Number.isFinite(t);
}

/** Strictly decode an already-parsed JSON value. Never throws. */
export function decodeGcFile(raw: unknown): GcFileStatus {
  if (raw === null || raw === undefined) return { kind: "empty" };
  if (Array.isArray(raw)) {
    if (raw.length === 0) return { kind: "empty" };
    return { kind: "incompatible", detail: `nonempty array with ${raw.length} entries` };
  }
  if (typeof raw !== "object") {
    return { kind: "incompatible", detail: `top-level ${typeof raw}` };
  }
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj["messages"])) {
    const messages = obj["messages"] as unknown[];
    if (messages.length === 0) return { kind: "empty" };
    return { kind: "incompatible", detail: `nonempty messages wrapper with ${messages.length} entries` };
  }
  const entries = Object.entries(obj);
  if (entries.length === 0) return { kind: "empty" };
  const marks: GcMarks = new Map();
  for (const [key, value] of entries) {
    if (key === "messages") {
      return { kind: "incompatible", detail: "messages field is not an array" };
    }
    if (!isCanonicalIdText(key)) {
      return { kind: "incompatible", detail: `non-canonical id key ${JSON.stringify(key)}` };
    }
    if (!isIsoInstant(value as string)) {
      return { kind: "incompatible", detail: `non-ISO timestamp for id ${key}` };
    }
    marks.set(Number(key), value as string);
  }
  return { kind: "ok", marks };
}

/** Encode marks canonically. Key order is numeric for stable output. */
export function encodeGcFile(marks: GcMarks): string {
  const sorted = [...marks.entries()].sort((a, b) => a[0] - b[0]);
  const obj: Record<string, string> = {};
  for (const [id, ts] of sorted) obj[String(id)] = ts;
  return JSON.stringify(obj);
}

export function garbagePath(memoryDir: string): string {
  return join(memoryDir, "garbage.json");
}

/** Read and strictly classify the artifact. Missing file is empty state. */
export function readGcMarks(memoryDir: string): GcFileStatus {
  const path = garbagePath(memoryDir);
  if (!existsSync(path)) return { kind: "empty" };
  try {
    return decodeGcFile(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    return { kind: "incompatible", detail: `unparseable file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Atomically replace the artifact (tmp file + rename). */
export function writeGcMarks(memoryDir: string, marks: GcMarks): void {
  const path = garbagePath(memoryDir);
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, encodeGcFile(marks), "utf-8");
  renameSync(tmp, path);
}

// ── Same-process mutation serialization ────────────────────────────────────
// Cross-process exclusion comes from the existing sleep/maintenance ownership
// boundary. Within this process, async interleaving between the pre-sleep
// purge, step marking, and settlement flush is serialized through this chain
// so concurrent readers never observe a torn write.
const chains = new Map<string, Promise<void>>();

/** Run `fn` after all previously queued mutations for this memoryDir. */
export function withGcLock<T>(memoryDir: string, fn: () => T | Promise<T>): Promise<T> {
  const prev = chains.get(memoryDir) ?? Promise.resolve();
  let release!: () => void;
  const slot = new Promise<void>((resolve) => { release = resolve; });
  chains.set(memoryDir, prev.then(() => slot));
  return prev.then(fn).finally(() => {
    release();
    if (chains.get(memoryDir) === slot) chains.delete(memoryDir);
  });
}

// ── Model selection persistence (#1807 R4) ─────────────────────────────────
// The model returns a JSON array (possibly `[]`); abmind validates the whole
// selection against the supplied ID set and persists. Any malformed,
// non-integer, or out-of-set ID rejects the whole selection. Model prose is
// never success evidence and the step cannot complete before persistence.

export type GcSelectionOutcome =
  | { ok: true; ids: number[] }
  | { ok: false; detail: string };

/**
 * Validate a model response and merge it into the artifact. Fails closed on
 * an incompatible existing file (fail-closed, diagnostic via callback).
 */
export async function persistGcSelection(
  memoryDir: string,
  response: string,
  validIds: Set<number>,
  clockMs: number,
  onIncompatible: (detail: string) => void,
): Promise<GcSelectionOutcome> {
  const match = response.match(/\[[\s\d,]*\]/);
  if (!match) {
    return { ok: false, detail: "gc-noise returned no JSON ID array" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { ok: false, detail: "gc-noise returned a malformed ID array" };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, detail: "gc-noise selection is not an array" };
  }
  const ids = [...new Set(parsed)];
  for (const id of ids) {
    if (typeof id !== "number" || !Number.isInteger(id)) {
      return { ok: false, detail: "gc-noise selection contains a non-integer ID" };
    }
    if (!validIds.has(id)) {
      return { ok: false, detail: `gc-noise selected ID ${id} outside the supplied set` };
    }
  }
  return withGcLock(memoryDir, () => {
    const status = readGcMarks(memoryDir);
    if (status.kind === "incompatible") {
      onIncompatible(status.detail);
      return { ok: false, detail: `GC artifact incompatible (${status.detail}) — left unchanged, operator reconciliation required` } as GcSelectionOutcome;
    }
    const marks: GcMarks = status.kind === "ok" ? status.marks : new Map();
    const stamp = new Date(clockMs).toISOString();
    for (const id of ids as number[]) {
      if (!marks.has(id)) marks.set(id, stamp);
    }
    writeGcMarks(memoryDir, marks);
    return { ok: true, ids: ids as number[] };
  });
}
