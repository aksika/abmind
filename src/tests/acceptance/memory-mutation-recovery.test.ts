/**
 * #1659 acceptance: response-loss replay through the real local composition.
 *
 * A deterministic socket proxy forwards a mutation to a real
 * LocalEndpointServer, drops the first completed response while closing the
 * client side, then accepts the transport reconnect and forwards the exact
 * replay. The real ledger returns the cached completion: one store executes,
 * one row is committed, and the memory stays recallable. An invalid-input
 * journey proves a structured, never-`unknown` validation failure.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, createConnection, type Server, type Socket } from "node:net";
import type Database from "better-sqlite3";
import { AbmindService } from "../../abmind-service.js";
import { LocalEndpointServer } from "../../local-endpoint-server.js";
import { LocalTransport } from "../../local-transport.js";
import { AbmindClient, AbmindClientError } from "../../abmind-client.js";
import { MemoryManager, getMemoryDb } from "../../memory-manager.js";
import { makeMemoryTestConfig } from "../../test-helpers.js";
import { createFrameAccumulator, encodeFrame, type FrameAccumulator } from "../../abmind-frame-codec.js";
import type { InstantStoreParams } from "../../mem-types.js";

/**
 * Forwards bytes between transport clients and the real endpoint. The first
 * complete response frame is dropped and the client side destroyed, simulating
 * response loss after the daemon committed the mutation.
 */
class DroppingProxy {
  private readonly server: Server;
  private dropArmed = true;
  private drops = 0;

  constructor(
    private readonly proxyPath: string,
    private readonly realPath: string,
  ) {
    this.server = createServer((clientConn) => this.handleClient(clientConn));
  }

  get droppedCount(): number { return this.drops; }

  listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.server.listen(this.proxyPath, resolve);
      this.server.on("error", reject);
    });
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handleClient(clientConn: Socket): void {
    const serverConn = createConnection(this.realPath);
    const buffered: Buffer[] = [];
    let connected = false;

    clientConn.on("data", (chunk: Buffer) => {
      if (connected) serverConn.write(chunk);
      else buffered.push(chunk);
    });
    serverConn.on("connect", () => {
      connected = true;
      for (const chunk of buffered) serverConn.write(chunk);
      buffered.length = 0;
    });

    // Server → client: forward complete frames, dropping the first one.
    const acc: FrameAccumulator = createFrameAccumulator();
    serverConn.on("data", (chunk: Buffer) => {
      try {
        acc.push(chunk);
      } catch { return; }
      let frame: ReturnType<FrameAccumulator["readFrame"]>;
      while ((frame = acc.readFrame()) !== null) {
        if (this.dropArmed) {
          this.dropArmed = false;
          this.drops++;
          clientConn.destroy();
          continue;
        }
        clientConn.write(encodeFrame(frame.payload));
      }
    });

    clientConn.on("close", () => serverConn.destroy());
    serverConn.on("close", () => clientConn.destroy());
    clientConn.on("error", () => { /* destroyed mid-drop */ });
    serverConn.on("error", () => { /* endpoint restarts */ });
  }
}

const USER_ID = "local-user";

describe("#1659 memory-mutation recovery acceptance", () => {
  let dir: string;
  let manager: MemoryManager;
  let db: Database.Database;
  let service: AbmindService;
  let endpoint: LocalEndpointServer;
  let proxy: DroppingProxy;
  let realPath: string;
  let proxyPath: string;
  let client: AbmindClient;
  let transport: LocalTransport;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "recovery-acceptance-"));
    manager = new MemoryManager(makeMemoryTestConfig(dir));
    await manager.initialize({ skipEmbeddingCheck: true });
    db = getMemoryDb(manager)!;
    service = new AbmindService({
      serverInstanceId: "acceptance", mode: "daemon", manager, operational: null, requestLedgerDb: db,
    });
    realPath = join(dir, "real.sock");
    proxyPath = join(dir, "proxy.sock");
    endpoint = new LocalEndpointServer({ socketPath: realPath, service, principalMapping: "self" });
    await endpoint.start();
    proxy = new DroppingProxy(proxyPath, realPath);
    await proxy.listen();
    transport = new LocalTransport(proxyPath);
    client = new AbmindClient(transport);
    await client.negotiate();
  });

  afterAll(async () => {
    await client.close();
    await endpoint.stop();
    await proxy.close();
    manager.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("replays a response-lost committed store exactly once and leaves a recallable row", async () => {
    const spy = vi.spyOn(manager.editor, "instantStore");
    const key = "acceptance-recovery-key";
    const payload: InstantStoreParams = {
      userId: USER_ID,
      contentEn: `Recovery probe ${Date.now()}`,
      contentOriginal: `Recovery probe ${Date.now()}`,
      memoryType: "fact",
      emotionScore: 0,
    };

    const result = await client.privateMemory.instantStore(payload, key);

    expect(proxy.droppedCount).toBe(1);
    expect(result.stored).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    const rows = db.prepare("SELECT id, content_en FROM extracted_memories WHERE user_id = ?").all(USER_ID) as Array<{ id: number; content_en: string }>;
    const matches = rows.filter(r => r.content_en === payload.contentEn);
    expect(matches.length).toBe(1);
    const memoryId = matches[0]!.id;

    const recall = await client.privateMemory.recall({
      translated: [payload.contentEn], original: payload.contentEn, userId: USER_ID, limit: 10,
    });
    expect(recall.results.some((hit: { id: number }) => hit.id === memoryId)).toBe(true);
  });

  it("rejects invalid store input with a structured, never-unknown failure", async () => {
    const error = await client.privateMemory.instantStore({
      userId: USER_ID, contentEn: "", contentOriginal: "", memoryType: "fact",
    }, "acceptance-invalid-key").then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AbmindClientError);
    const clientError = error as AbmindClientError;
    expect(clientError.code).toBe("validation_error");
    expect(clientError.retryable).toBe(false);
    expect(clientError.action).toBe("fix_input");
    expect(clientError.stage).toBe("pre_dispatch");
    expect(clientError.requestId.length).toBeGreaterThan(0);
    expect(clientError.message).not.toContain("unknown");
  });
});
