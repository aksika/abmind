import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { abmindHome } from "../mem-paths.js";
import {
  WSS_OUTBOX_MAX_ENTRIES, WSS_OUTBOX_MAX_ENTRY_BYTES, WSS_OUTBOX_MAX_FILE_BYTES,
} from "./signed-wire.js";

export const OUTBOX_MAX_ATTEMPTS = 5;

export interface OutboxEntry {
  id: string;
  method: string;
  requestId: string;
  idempotencyKey: string | undefined;
  body: string;
  version: number;
  payload: unknown;
  createdAt: string;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
}

export interface OutboxFileV1 {
  version: 1;
  peer: string;
  entries: OutboxEntry[];
}

export class RequestOutbox {
  private filePath: string;
  private entries: OutboxEntry[] = [];
  private degraded = false;
  private peerName: string;

  constructor(peerName: string, filePath?: string) {
    this.peerName = peerName;
    const dir = filePath ? dirname(filePath) : join(abmindHome(), "remote", "outbox");
    mkdirSync(dir, { recursive: true });
    this.filePath = filePath ?? join(dir, `${peerName}.json`);
    this.entries = this.load();
  }

  get isDegraded(): boolean { return this.degraded; }

  append(
    id: string, method: string, requestId: string,
    idempotencyKey: string | undefined, body: string, version: number, payload: unknown,
  ): boolean {
    if (this.entries.length >= WSS_OUTBOX_MAX_ENTRIES) return false;

    const entry: OutboxEntry = {
      id, method, requestId, idempotencyKey, body, version, payload,
      createdAt: new Date().toISOString(), attempts: 0,
    };
    const entryJson = JSON.stringify(entry);
    if (Buffer.byteLength(entryJson, "utf-8") > WSS_OUTBOX_MAX_ENTRY_BYTES) return false;

    this.entries.push(entry);
    if (this.checkpoint()) return true;
    this.entries.pop();
    return false;
  }

  peek(): OutboxEntry | null {
    return this.entries[0] ?? null;
  }

  get(id: string): OutboxEntry | null {
    return this.entries.find(e => e.id === id) ?? null;
  }

  acknowledge(id: string): boolean {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return true;
    const [removed] = this.entries.splice(idx, 1);
    if (this.checkpoint()) return true;
    this.entries.splice(idx, 0, removed!);
    return false;
  }

  recordAttempt(id: string, error?: string): number | null {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return null;
    const previous = { attempts: entry.attempts, lastAttemptAt: entry.lastAttemptAt, lastError: entry.lastError };
    entry.attempts++;
    entry.lastAttemptAt = new Date().toISOString();
    if (error) entry.lastError = error;
    if (!this.checkpoint()) {
      entry.attempts = previous.attempts;
      entry.lastAttemptAt = previous.lastAttemptAt;
      entry.lastError = previous.lastError;
    }
    return entry.attempts;
  }

  get length(): number { return this.entries.length; }

  private load(): OutboxEntry[] {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as OutboxFileV1;
      if (parsed.version !== 1 || parsed.peer !== this.peerName) return [];
      if (!Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter(e =>
        e && typeof e.id === "string" && typeof e.method === "string"
        && typeof e.requestId === "string" && typeof e.body === "string"
      );
    } catch {
      return [];
    }
  }

  private checkpoint(): boolean {
    try {
      const data: OutboxFileV1 = {
        version: 1, peer: this.peerName, entries: this.entries,
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
