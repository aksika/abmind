import { appendFileSync, mkdirSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const AUDIT_MAX_RECORD_BYTES = 4096;
export const AUDIT_MAX_FILE_BYTES = 10_000_000;
const AUDIT_ROTATION_SUFFIX = ".rotated";

export interface RemoteAuditRecordV1 {
  version: 1;
  auditId: string;
  phase: "decision" | "outcome";
  timestamp: string;
  peerId: string;
  principalId?: string;
  requestId: string;
  method?: string;
  allowed?: boolean;
  code?: string;
  durationMs?: number;
  requestBytes: number;
  responseBytes?: number;
}

export class RemoteAudit {
  private dir: string;
  private currentFile: string;
  private degraded = false;
  private bytesWritten = 0;

  constructor(dirPath?: string) {
    this.dir = dirPath ?? join(abmindHome(), "remote", "audit");
    mkdirSync(this.dir, { recursive: true });
    this.currentFile = join(this.dir, "audit.jsonl");
    this.bytesWritten = this.measureCurrentFile();
  }

  get isDegraded(): boolean { return this.degraded; }

  record(record: RemoteAuditRecordV1): boolean {
    if (this.degraded) return false;

    const line = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(line, "utf-8") > AUDIT_MAX_RECORD_BYTES) return false;

    if (this.bytesWritten + Buffer.byteLength(line, "utf-8") > AUDIT_MAX_FILE_BYTES) {
      if (!this.rotate()) return false;
    }

    try {
      appendFileSync(this.currentFile, line, "utf-8");
      this.bytesWritten += Buffer.byteLength(line, "utf-8");
      return true;
    } catch {
      this.degraded = true;
      return false;
    }
  }

  private rotate(): boolean {
    try {
      const rotated = this.currentFile + AUDIT_ROTATION_SUFFIX + "." + Date.now();
      renameSync(this.currentFile, rotated);
      this.bytesWritten = 0;
      return true;
    } catch {
      this.degraded = true;
      return false;
    }
  }

  private measureCurrentFile(): number {
    try {
      const stat = readFileSync(this.currentFile);
      return stat.length;
    } catch {
      return 0;
    }
  }

  makeDecisionRecord(
    peerId: string, principalId: string | undefined,
    requestId: string, method: string | undefined,
    allowed: boolean, requestBytes: number,
  ): RemoteAuditRecordV1 {
    return {
      version: 1, auditId: randomUUID().slice(0, 12),
      phase: "decision", timestamp: new Date().toISOString(),
      peerId, principalId, requestId, method,
      allowed, requestBytes, responseBytes: undefined,
    };
  }

  makeOutcomeRecord(
    auditId: string, peerId: string, principalId: string | undefined,
    requestId: string, method: string | undefined,
    code: string, durationMs: number, requestBytes: number, responseBytes?: number,
  ): RemoteAuditRecordV1 {
    return {
      version: 1, auditId,
      phase: "outcome", timestamp: new Date().toISOString(),
      peerId, principalId, requestId, method,
      code, durationMs, requestBytes, responseBytes,
    };
  }
}

function abmindHome(): string {
  return process.env.ABMIND_HOME ?? join(process.env.HOME ?? "/tmp", ".abmind");
}
