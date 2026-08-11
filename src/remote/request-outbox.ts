import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { abmindHome } from "../mem-paths.js";
import {
  WSS_OUTBOX_MAX_ENTRIES, WSS_OUTBOX_MAX_ENTRY_BYTES, WSS_OUTBOX_MAX_FILE_BYTES,
} from "./signed-wire.js";
import {
  ROUTE_RETRY_DEADLINE_MS,
  ROUTE_TERMINAL_UNKNOWN_MAX_ENTRIES, ROUTE_TERMINAL_UNKNOWN_RETENTION_MS,
  ROUTE_METHOD_MAX_BYTES,
  type AbmindDeliveryState, type RetryFailureClass,
} from "./route-contract.js";

export const OUTBOX_MAX_ATTEMPTS = 5;

/** Version 2 durable delivery entry (#1382). */
export interface OutboxEntryV2 {
  id: string;
  method: string;
  requestId: string;
  idempotencyKey: string | undefined;
  body: string;
  version: number;
  payload?: unknown;
  state: AbmindDeliveryState;
  createdAt: string;
  deadlineAt: string;
  attempts: number;
  lastAttemptAt?: string;
  nextAttemptAt?: string;
  lastFailure?: RetryFailureClass;
}

/** Legacy version 1 entry shape (admitted work, no delivery state). */
export interface OutboxEntryV1 {
  id: string;
  method: string;
  requestId: string;
  idempotencyKey?: string;
  body: string;
  version: number;
  payload?: unknown;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export type OutboxFile =
  | { version: 1; peer: string; entries: OutboxEntryV1[] }
  | { version: 2; peer: string; entries: OutboxEntryV2[] };

/** Bounded diagnostic projection of a terminal-unknown record (no payloads). */
export interface TerminalUnknownRecord {
  id: string;
  method: string;
  requestId: string;
  createdAt: string;
  deadlineAt: string;
  attempts: number;
  lastFailure?: RetryFailureClass;
}

const KNOWN_STATES: ReadonlySet<string> = new Set(["admitted", "in_flight", "retry_wait", "terminal_unknown"]);
const KNOWN_FAILURES: ReadonlySet<string> = new Set(["timeout", "send_failed", "socket_lost", "generation_lost", "connection_refused"]);

function parseIso(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isValidV1Entry(value: unknown): value is OutboxEntryV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return typeof e.id === "string" && e.id.length > 0
    && typeof e.method === "string" && e.method.length > 0 && e.method.length <= ROUTE_METHOD_MAX_BYTES
    && typeof e.requestId === "string" && e.requestId.length > 0
    && typeof e.body === "string"
    && typeof e.version === "number"
    && parseIso(e.createdAt) !== null
    && typeof e.attempts === "number" && e.attempts >= 0;
}

function isValidV2Entry(value: unknown): value is OutboxEntryV2 {
  if (!isValidV1Entry(value)) return false;
  const e = value as unknown as Record<string, unknown>;
  if (typeof e.state !== "string" || !KNOWN_STATES.has(e.state)) return false;
  const createdAt = parseIso(e.createdAt)!;
  const deadlineAt = parseIso(e.deadlineAt);
  if (deadlineAt === null || deadlineAt < createdAt) return false;
  if (e.lastFailure !== undefined && (typeof e.lastFailure !== "string" || !KNOWN_FAILURES.has(e.lastFailure))) return false;
  if (e.nextAttemptAt !== undefined && parseIso(e.nextAttemptAt) === null) return false;
  if (e.lastAttemptAt !== undefined && parseIso(e.lastAttemptAt) === null) return false;
  return true;
}

function entryBytes(entry: unknown): number {
  return Buffer.byteLength(JSON.stringify(entry), "utf-8");
}

export class RequestOutbox {
  private filePath: string;
  private entries: OutboxEntryV2[] = [];
  private degraded = false;
  private quarantined = false;
  private peerName: string;
  private retryDeadlineMs: number;

  constructor(peerName: string, filePath?: string, options?: { retryDeadlineMs?: number }) {
    this.peerName = peerName;
    this.retryDeadlineMs = options?.retryDeadlineMs ?? ROUTE_RETRY_DEADLINE_MS;
    const dir = filePath ? dirname(filePath) : join(abmindHome(), "remote", "outbox");
    mkdirSync(dir, { recursive: true });
    this.filePath = filePath ?? join(dir, `${peerName}.json`);
    this.entries = this.load();
  }

  get isDegraded(): boolean { return this.degraded; }

  /** True when the on-disk state was corrupt and was quarantined, never silently replaced. */
  get isQuarantined(): boolean { return this.quarantined; }

  append(
    id: string, method: string, requestId: string,
    idempotencyKey: string | undefined, body: string, version: number, payload: unknown,
  ): boolean {
    if (this.quarantined || this.degraded) return false;
    if (this.entries.length >= WSS_OUTBOX_MAX_ENTRIES) return false;

    const now = new Date();
    const entry: OutboxEntryV2 = {
      id, method, requestId, idempotencyKey, body, version, payload,
      state: "admitted",
      createdAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + this.retryDeadlineMs).toISOString(),
      attempts: 0,
    };
    if (entryBytes(entry) > WSS_OUTBOX_MAX_ENTRY_BYTES) return false;

    this.entries.push(entry);
    if (this.checkpoint()) return true;
    this.entries.pop();
    return false;
  }

  get(id: string): OutboxEntryV2 | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  /** Oldest due retry-eligible entry, or null. `now` in epoch ms. */
  peekDue(now: number): OutboxEntryV2 | null {
    let best: OutboxEntryV2 | null = null;
    for (const e of this.entries) {
      if (e.state !== "admitted" && e.state !== "retry_wait") continue;
      if (e.state === "retry_wait" && e.nextAttemptAt !== undefined && Date.parse(e.nextAttemptAt) > now) continue;
      if (Date.parse(e.deadlineAt) <= now) continue;
      if (best === null || e.createdAt < best.createdAt) best = e;
    }
    return best;
  }

  /** Transition an entry to in_flight (durably) before its send. */
  markInFlight(id: string): boolean {
    const entry = this.entries.find(e => e.id === id);
    if (!entry || entry.state === "in_flight" || entry.state === "terminal_unknown") return false;
    const previous = entry.state;
    entry.state = "in_flight";
    entry.lastAttemptAt = new Date().toISOString();
    if (this.checkpoint()) return true;
    entry.state = previous;
    entry.lastAttemptAt = undefined;
    return false;
  }

  /** Record an uncertain failure: retry_wait with a bounded next-attempt time. */
  markRetryWait(id: string, failure: RetryFailureClass, nextAttemptAt: number): boolean {
    const entry = this.entries.find(e => e.id === id);
    if (!entry || entry.state === "terminal_unknown") return false;
    const previous = { state: entry.state, attempts: entry.attempts, lastAttemptAt: entry.lastAttemptAt, nextAttemptAt: entry.nextAttemptAt, lastFailure: entry.lastFailure };
    entry.state = "retry_wait";
    entry.attempts++;
    entry.lastAttemptAt = new Date().toISOString();
    entry.nextAttemptAt = new Date(nextAttemptAt).toISOString();
    entry.lastFailure = failure;
    if (this.checkpoint()) return true;
    Object.assign(entry, previous);
    return false;
  }

  /** Transition exhausted ambiguous work to terminal_unknown (never pumped). */
  markTerminalUnknown(id: string, failure: RetryFailureClass): boolean {
    const entry = this.entries.find(e => e.id === id);
    if (!entry || entry.state === "terminal_unknown") return false;
    const previous = entry.state;
    entry.state = "terminal_unknown";
    entry.lastFailure = failure;
    if (this.checkpoint()) return true;
    entry.state = previous;
    entry.lastFailure = undefined;
    return false;
  }

  /** Terminal delivery: durably remove the entry. */
  acknowledge(id: string): boolean {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return true;
    const [removed] = this.entries.splice(idx, 1);
    if (this.checkpoint()) return true;
    this.entries.splice(idx, 0, removed!);
    return false;
  }

  /** True when the entry is exhausted: over attempts or past its wall-clock deadline. */
  isExhausted(entry: OutboxEntryV2, now: number): boolean {
    return entry.attempts >= OUTBOX_MAX_ATTEMPTS || Date.parse(entry.deadlineAt) <= now;
  }

  /** Bounded diagnostics: eligible (non-terminal) and terminal-unknown counts. */
  counts(): { retryEligible: number; terminalUnknown: number; nextAttemptAt?: number } {
    let retryEligible = 0;
    let terminalUnknown = 0;
    let nextAttemptAt: number | undefined;
    for (const e of this.entries) {
      if (e.state === "terminal_unknown") {
        terminalUnknown++;
        continue;
      }
      retryEligible++;
      if (e.nextAttemptAt !== undefined) {
        const at = Date.parse(e.nextAttemptAt);
        if (nextAttemptAt === undefined || at < nextAttemptAt) nextAttemptAt = at;
      }
    }
    return { retryEligible, terminalUnknown, nextAttemptAt };
  }

  /** Bounded diagnostic records for terminal-unknown entries (no payload/body). */
  terminalUnknownRecords(): TerminalUnknownRecord[] {
    return this.entries
      .filter(e => e.state === "terminal_unknown")
      .map(e => ({
        id: e.id,
        method: e.method,
        requestId: e.requestId,
        createdAt: e.createdAt,
        deadlineAt: e.deadlineAt,
        attempts: e.attempts,
        lastFailure: e.lastFailure,
      }));
  }

  /** Explicit bounded cleanup of old terminal-unknown records; never reactivates. */
  pruneTerminalUnknown(now: number): boolean {
    const before = this.entries.length;
    const terminal = this.entries.filter(e => e.state === "terminal_unknown");
    const retentionCutoff = now - ROUTE_TERMINAL_UNKNOWN_RETENTION_MS;
    const keep: OutboxEntryV2[] = [];
    const drop: OutboxEntryV2[] = [];
    for (const e of terminal) {
      if (Date.parse(e.createdAt) < retentionCutoff || keep.length >= ROUTE_TERMINAL_UNKNOWN_MAX_ENTRIES) {
        drop.push(e);
      } else {
        keep.push(e);
      }
    }
    if (drop.length === 0) return true;
    const ids = new Set(drop.map(e => e.id));
    const next = this.entries.filter(e => !ids.has(e.id));
    const previous = this.entries;
    this.entries = next;
    if (this.checkpoint()) return true;
    this.entries = previous;
    return false;
  }

  get length(): number { return this.entries.length; }

  private load(): OutboxEntryV2[] {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.quarantine();
      return [];
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.quarantine();
      return [];
    }
    const file = parsed as Record<string, unknown>;
    if (file.peer !== this.peerName || !Array.isArray(file.entries)) {
      this.quarantine();
      return [];
    }

    const version = file.version;
    if (version === 1) {
      return this.migrateV1(file.entries as unknown[]);
    }
    if (version === 2) {
      return this.validateV2(file.entries as unknown[]);
    }
    this.quarantine();
    return [];
  }

  private migrateV1(entries: unknown[]): OutboxEntryV2[] {
    if (entries.length > WSS_OUTBOX_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(entries), "utf-8") > WSS_OUTBOX_MAX_FILE_BYTES) {
      this.quarantine();
      return [];
    }
    const seen = new Set<string>();
    const now = Date.now();
    const migrated: OutboxEntryV2[] = [];
    for (const value of entries) {
      if (!isValidV1Entry(value)) {
        this.quarantine();
        return [];
      }
      if (seen.has(value.id)) {
        this.quarantine();
        return [];
      }
      seen.add(value.id);
      if (entryBytes(value) > WSS_OUTBOX_MAX_ENTRY_BYTES) {
        this.quarantine();
        return [];
      }
      const createdAtMs = Date.parse(value.createdAt);
      const deadlineAtMs = createdAtMs + ROUTE_RETRY_DEADLINE_MS;
      // Deadline derives from original age and is never refreshed.
      migrated.push({
        id: value.id,
        method: value.method,
        requestId: value.requestId,
        idempotencyKey: value.idempotencyKey,
        body: value.body,
        version: value.version,
        payload: value.payload,
        state: deadlineAtMs <= now ? "terminal_unknown" : "admitted",
        createdAt: value.createdAt,
        deadlineAt: new Date(deadlineAtMs).toISOString(),
        attempts: value.attempts,
        lastAttemptAt: value.lastAttemptAt,
        lastFailure: deadlineAtMs <= now ? "timeout" : undefined,
      });
    }
    // Persist the migrated V2 file once; failure quarantines rather than silently
    // retrying migration on every load.
    const saved = this.entries;
    this.entries = migrated;
    if (this.checkpoint()) return migrated;
    this.entries = saved;
    this.quarantine();
    return [];
  }

  private validateV2(entries: unknown[]): OutboxEntryV2[] {
    if (entries.length > WSS_OUTBOX_MAX_ENTRIES || Buffer.byteLength(JSON.stringify(entries), "utf-8") > WSS_OUTBOX_MAX_FILE_BYTES) {
      this.quarantine();
      return [];
    }
    const seen = new Set<string>();
    for (const value of entries) {
      if (!isValidV2Entry(value)) {
        this.quarantine();
        return [];
      }
      if (seen.has(value.id)) {
        this.quarantine();
        return [];
      }
      seen.add(value.id);
      if (entryBytes(value) > WSS_OUTBOX_MAX_ENTRY_BYTES) {
        this.quarantine();
        return [];
      }
    }
    const loaded = entries as OutboxEntryV2[];
    // A previous process may have died mid-send: an in_flight entry is
    // ambiguous, not in progress. Downgrade it to retry_wait (due
    // immediately) so a restarted process replays it under idempotency.
    const normalized = loaded.map(e =>
      e.state === "in_flight"
        ? { ...e, state: "retry_wait" as const, nextAttemptAt: undefined }
        : e,
    );
    if (normalized.some((e, i) => e !== loaded[i])) {
      const saved = this.entries;
      this.entries = normalized;
      if (!this.checkpoint()) {
        this.entries = saved;
      }
    }
    return normalized;
  }

  /** Preserve the corrupt file under a bounded name and empty the in-memory view. */
  private quarantine(): void {
    this.quarantined = true;
    try {
      const target = `${this.filePath}.quarantine-${Date.now()}`;
      renameSync(this.filePath, target);
    } catch { /* file may already be gone */ }
  }

  private checkpoint(): boolean {
    try {
      const data: OutboxFile = {
        version: 2, peer: this.peerName, entries: this.entries,
      };
      const json = JSON.stringify(data);
      if (Buffer.byteLength(json, "utf-8") > WSS_OUTBOX_MAX_FILE_BYTES) {
        this.degraded = true;
        return false;
      }
      const tmp = this.filePath + ".tmp";
      writeFileSync(tmp, json, "utf-8");
      renameSync(tmp, this.filePath);
      return true;
    } catch {
      this.degraded = true;
      return false;
    }
  }
}
