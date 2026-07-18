/**
 * Memory IPC client — kept for backward compat during #1380 cutover.
 * @deprecated Removed in #1380. Use LocalTransport + AbmindClient instead.
 */

import * as net from "node:net";
import type { InstantStoreParams, InstantStoreResult, EditMemoryParams, EditMemoryResult, ForgetResult } from "./mem-types.js";
import type { RecallParams, RecallResult } from "./recall-engine.js";
import type { MergeResult, MemoryBackend } from "./memory-backend.js";
import { getSocketPath } from "./memory-ipc-server.js";

let nextId = 1;

function call(socketPath: string, method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(socketPath);
    const id = nextId++;
    let buffer = "";

    conn.on("connect", () => {
      conn.write(JSON.stringify({ id, method, params }) + "\n");
    });

    conn.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      conn.end();
      try {
        const res = JSON.parse(buffer.slice(0, nl));
        if (res.ok) resolve(res.result);
        else reject(new Error(res.error));
      } catch (e) { reject(e); }
    });

    conn.on("error", reject);
    conn.setTimeout(timeoutMs, () => { conn.destroy(); reject(new Error("IPC timeout")); });
  });
}

export class IpcBackend implements MemoryBackend {
  private readonly socketPath = getSocketPath();

  async initialize(): Promise<void> {
    await call(this.socketPath, "ping", {});
  }

  close(): void { /* no-op — server owns the DB */ }

  async instantStore(params: InstantStoreParams): Promise<InstantStoreResult> {
    return call(this.socketPath, "store", params) as Promise<InstantStoreResult>;
  }

  async editMemory(params: EditMemoryParams): Promise<EditMemoryResult> {
    return call(this.socketPath, "edit", params) as Promise<EditMemoryResult>;
  }

  async reclassifyMemory(id: number, level: number, userOverride: boolean): Promise<void> {
    await call(this.socketPath, "reclassify", { id, level, userOverride });
  }

  async adjustRelevance(id: number, delta: number): Promise<void> {
    await call(this.socketPath, "adjustRelevance", { id, delta });
  }

  async mergeMemories(idA: number, idB: number): Promise<MergeResult> {
    return call(this.socketPath, "merge", { idA, idB }) as Promise<MergeResult>;
  }

  async cascadeDelete(ids: number[], userId: string): Promise<ForgetResult> {
    return call(this.socketPath, "delete", { ids, userId }) as Promise<ForgetResult>;
  }

  async recall(params: RecallParams): Promise<RecallResult> {
    return call(this.socketPath, "recall", params) as Promise<RecallResult>;
  }

  rebuildFtsIndexes(): { rebuilt: string[] } {
    // IPC backend: FTS rebuild not supported over IPC — return empty (in-process backend handles it)
    return { rebuilt: [] };
  }

  /** Request authorization from bridge's ActionGate (130s timeout for Telegram flow). */
  async requestAuth(category: string, detail: string): Promise<boolean> {
    try {
      const result = await call(this.socketPath, "auth-request", { category, detail }, 130_000) as { granted: boolean };
      return result?.granted === true;
    } catch {
      return false;
    }
  }
}

/** Check if the IPC socket is available. */
export async function isIpcAvailable(): Promise<boolean> {
  try {
    await call(getSocketPath(), "ping", {});
    return true;
  } catch {
    return false;
  }
}
