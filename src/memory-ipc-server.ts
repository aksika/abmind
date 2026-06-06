/**
 * Memory IPC server — keeps DB open, serves CLI tools over Unix socket.
 * Runs inside the bridge process. Protocol: newline-delimited JSON.
 */

import * as net from "node:net";
import * as fs from "node:fs";
import { join } from "node:path";
import { abmindHome } from "./mem-paths.js";
import { logInfo } from "./mem-logger.js";
import type { MemoryBackend } from "./memory-backend.js";

const TAG = "memory-ipc";

export function getSocketPath(): string {
  return join(abmindHome(), "memory.sock");
}

type Request = { id: number; method: string; params: unknown };
type Response = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };

export class MemoryIpcServer {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  private unknownMethodHandler?: (method: string, params: unknown) => Promise<unknown>;

  constructor(private readonly backend: MemoryBackend) {
    this.socketPath = getSocketPath();
  }

  /** Hook for host (abtars) to handle custom IPC methods (e.g. auth-request). */
  setUnknownMethodHandler(fn: (method: string, params: unknown) => Promise<unknown>): void {
    this.unknownMethodHandler = fn;
  }

  async start(): Promise<void> {
    try { fs.unlinkSync(this.socketPath); } catch { /* doesn't exist */ }

    this.server = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString();
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          this.handleRequest(line, conn);
        }
      });
      conn.on("error", () => {});
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(this.socketPath, () => resolve());
      this.server!.on("error", reject);
    });

    logInfo(TAG, `Listening on ${this.socketPath}`);
  }

  stop(): void {
    this.server?.close();
    try { fs.unlinkSync(this.socketPath); } catch { /* */ }
    this.server = null;
  }

  private handleRequest(line: string, conn: net.Socket): void {
    let req: Request;
    try {
      req = JSON.parse(line);
    } catch {
      conn.write(JSON.stringify({ id: 0, ok: false, error: "invalid JSON" }) + "\n");
      return;
    }

    this.dispatch(req).then(
      (result) => conn.write(JSON.stringify({ id: req.id, ok: true, result } as Response) + "\n"),
      (err) => conn.write(JSON.stringify({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) } as Response) + "\n"),
    );
  }

  private async dispatch(req: Request): Promise<unknown> {
    const p = req.params as Record<string, unknown>;
    switch (req.method) {
      case "store": return this.backend.instantStore(p as any);
      case "edit": return this.backend.editMemory(p as any);
      case "recall": return this.backend.recall(p as any);
      case "delete": return this.backend.cascadeDelete(p["ids"] as number[], p["userId"] as string);
      case "reclassify": { this.backend.reclassifyMemory(p["id"] as number, p["level"] as number, p["userOverride"] as boolean); return { ok: true }; }
      case "adjustRelevance": { this.backend.adjustRelevance(p["id"] as number, p["delta"] as number); return { ok: true }; }
      case "merge": return this.backend.mergeMemories(p["idA"] as number, p["idB"] as number);
      case "ping": return "pong";
      default:
        if (this.unknownMethodHandler) return this.unknownMethodHandler(req.method, p);
        throw new Error(`Unknown method: ${req.method}`);
    }
  }
}
