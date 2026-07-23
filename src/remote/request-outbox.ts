import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  WSS_OUTBOX_MAX_ENTRIES, WSS_OUTBOX_MAX_ENTRY_BYTES, WSS_OUTBOX_MAX_FILE_BYTES,
} from "./signed-wire.js";

export interface OutboxEntry {
  id: string;
  method: string;
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

  append(id: string, method: string, payload: unknown): boolean {
    if (this.entries.length >= WSS_OUTBOX_MAX_ENTRIES) return false;

    const entry: OutboxEntry = {
      id, method, payload, createdAt: new Date().toISOString(), attempts: 0,
    };
    const entryJson = JSON.stringify(entry);
    if (Buffer.byteLength(entryJson, "utf-8") > WSS_OUTBOX_MAX_ENTRY_BYTES) return false;

    this.entries.push(entry);
    return this.checkpoint();
  }

  peek(): OutboxEntry | null {
    return this.entries[0] ?? null;
  }

  acknowledge(id: string): boolean {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return true;
    this.entries.splice(idx, 1);
    return this.checkpoint();
  }

  recordAttempt(id: string, error?: string): boolean {
    const entry = this.entries.find(e => e.id === id);
    if (!entry) return false;
    entry.attempts++;
    entry.lastAttemptAt = new Date().toISOString();
    if (error) entry.lastError = error;
    return this.checkpoint();
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

function abmindHome(): string {
  return process.env.ABMIND_HOME ?? join(process.env.HOME ?? "/tmp", ".abmind");
}
