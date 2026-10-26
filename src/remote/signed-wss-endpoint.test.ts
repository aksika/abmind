import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import { createServer as createHttpsServer, type Server } from "node:https";
import { SignedWssEndpoint } from "./signed-wss-endpoint.js";
import { SignedWssTransport } from "./signed-wss-transport.js";
import { RequestOutbox } from "./request-outbox.js";
import { AbmindClient } from "../abmind-client.js";
import type { AbmindService } from "../abmind-service.js";
import type { AbmindResponseV1 } from "../abmind-protocol.js";

let uidCounter = 0;

interface TestEnv {
  root: string;
  remoteDir: string;
  homeDir: string;
  certPath: string;
  keyPath: string;
  pin: string;
  peers: Map<string, { keyPath: string; pubPem: string }>;
}

function setupEnv(): TestEnv {
  const root = mkdtempSync(join(tmpdir(), `abmind-wss-test-${++uidCounter}-`));
  const remoteDir = join(root, "remote");
  const homeDir = join(root, "home");
  mkdirSync(remoteDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const keyPath = join(root, "tls-key.pem");
  const certPath = join(root, "tls-cert.pem");
  execSync(
    `openssl req -x509 -newkey ed25519 -nodes -keyout ${keyPath} -out ${certPath} -subj /CN=localhost -days 1 -addext subjectAltName=DNS:localhost,IP:127.0.0.1`,
    { stdio: "ignore" },
  );
  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o600);
  const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
  const pin = createHash("sha256").update(der).digest("hex");

  const peers = new Map<string, { keyPath: string; pubPem: string }>();
  return { root, remoteDir, homeDir, certPath, keyPath, pin, peers };
}

function addPeer(env: TestEnv, peerId: string): { keyPath: string; pubPem: string } {
  const { execSync: exec } = require("node:child_process") as typeof import("node:child_process");
  const keyPath = join(env.root, `${peerId}.pem`);
  const pubPem = exec(`openssl pkey -in ${keyPath} -pubout 2>/dev/null || true`).toString() || "";
  void pubPem;
  const kp = require("node:crypto").generateKeyPairSync("ed25519");
  const pub = kp.publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  writeFileSync(keyPath, kp.privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(keyPath, 0o600);
  const peer = { keyPath, pubPem: pub };
  env.peers.set(peerId, peer);
  return peer;
}

function writeRestricted(p: string, data: unknown): void {
  writeFileSync(p, JSON.stringify(data, null, 2));
  chmodSync(p, 0o600);
}

function writeDaemonConfig(env: TestEnv, port: number, grants: unknown[], enrollments: unknown[]): void {
  writeRestricted(join(env.remoteDir, "endpoint.json"), {
    enabled: true, host: "127.0.0.1", port,
    tlsCertPath: env.certPath, tlsKeyPath: env.keyPath,
  });
  writeRestricted(join(env.remoteDir, "enrollments.json"), enrollments);
  writeRestricted(join(env.remoteDir, "grants.json"), grants);
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createHttpsServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Minimal service stub — the endpoint only needs handle(). */
function stubService(): AbmindService {
  return {
    handle: async (req: { requestId: string; method?: string }) => {
      if (req.method === "system.negotiate") {
        return { ok: true, requestId: req.requestId, result: { version: 1, methods: [], features: {} } };
      }
      return { ok: false, requestId: req.requestId, error: { code: "internal_error", message: "stub" } };
    },
  } as unknown as AbmindService;
}

async function startEndpoint(env: TestEnv, port: number): Promise<SignedWssEndpoint> {
  process.env.ABMIND_REMOTE_DIR = env.remoteDir;
  process.env.ABMIND_HOME = join(env.homeDir, ".abmind");
  const endpoint = new SignedWssEndpoint(stubService());
  await endpoint.start();
  expect(endpoint.isStarted).toBe(true);
  return endpoint;
}

describe("signed-WSS response correlation", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    delete process.env.ABMIND_REMOTE_DIR;
    delete process.env.ABMIND_HOME;
    try { rmSync(env.root, { recursive: true, force: true }); } catch { }
  });

  it("surfaces a grant denial as unauthorized, not validation_error (#1518)", async () => {
    const peerA = addPeer(env, "peer-a");
    const peerNC = addPeer(env, "peer-nc");

    const port = await findFreePort();
    writeDaemonConfig(env, port,
      [
        {
          peerId: "peer-a", principalId: "principal-a",
          domains: ["system", "private"],
          methods: ["system.negotiate", "system.status", "private.recordMessage", "private.getRecentConversation"],
          capabilities: [],
        },
        {
          peerId: "peer-nc", principalId: "principal-nc",
          domains: ["system", "private"],
          methods: ["system.negotiate", "system.status"],
          capabilities: [],
        },
      ],
      [
        { peerId: "peer-a", verifyKey: peerA.pubPem, enrolledAt: new Date().toISOString() },
        { peerId: "peer-nc", verifyKey: peerNC.pubPem, enrolledAt: new Date().toISOString() },
      ],
    );
    const endpoint = await startEndpoint(env, port);

    const outbox = new RequestOutbox("peer-nc", join(env.root, "outbox-nc.json"));
    const transport = new SignedWssTransport({
      name: "peer-nc", url: `wss://127.0.0.1:${port}`,
      peerId: "peer-nc", signingKeyPath: peerNC.keyPath, serverCertSha256: env.pin,
    }, outbox);
    const client = new AbmindClient(transport);
    try {
      await client.negotiate();
      let denied = false;
      let code: string | undefined;
      try {
        await client.callRaw("private.recordMessage", {
          userId: "x", sessionId: "s", role: "user", content: "denied", timestamp: Date.now(),
        }, "deny-key");
      } catch (err) {
        denied = true;
        code = (err as Error & { code?: string }).code;
      }
      expect(denied).toBe(true);
      expect(code).toBe("unauthorized");
      expect(code).not.toBe("validation_error");
    } finally {
      await client.close();
      await endpoint.stop();
    }
  });

  it("does not settle a caller on an inner request-ID mismatch (outcome_unknown after budget)", async () => {
    const peer = addPeer(env, "peer-mismatch");
    const port = await findFreePort();

    const tls = {
      key: readFileSync(env.keyPath, "utf-8"), cert: readFileSync(env.certPath, "utf-8"),
      minVersion: "TLSv1.3" as const,
    };
    const server: Server = createHttpsServer(tls);
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "challenge", version: 1, connectionId: "conn-1", challenge: "ch-1", expiresAt: Date.now() + 30_000 }));
      socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
        const msg = JSON.parse(data.toString("utf-8")) as Record<string, unknown>;
        if (msg.type === "hello") {
          socket.send(JSON.stringify({ type: "hello_ack", version: 1, peerId: msg.peerId }));
          return;
        }
        if (msg.type === "request" && msg.version === 1) {
          const inner = JSON.parse(msg.body as string) as { requestId?: string; method?: string };
          if (inner.method === "system.negotiate") {
            const body = JSON.stringify({
              ok: true,
              requestId: inner.requestId,
              result: { version: 1, methods: [], features: {} },
            });
            socket.send(JSON.stringify({ type: "response", version: 1, id: msg.id, body }));
            return;
          }
          const body = JSON.stringify({
            ok: true,
            requestId: "deliberately-different-inner-id",
            result: { ok: true },
          } as unknown as AbmindResponseV1);
          socket.send(JSON.stringify({ type: "response", version: 1, id: msg.id, body }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));

    const outbox = new RequestOutbox("peer-mismatch", join(env.root, "outbox-mm.json"), { retryDeadlineMs: 5_000 });
    const transport = new SignedWssTransport({
      name: "peer-mismatch", url: `wss://127.0.0.1:${port}`,
      peerId: "peer-mismatch", signingKeyPath: peer.keyPath, serverCertSha256: env.pin,
    }, outbox, {
      requestTimeoutMs: 50,
      retryBaseMs: 1,
      retryMaxMs: 5,
      retryMaxAttempts: 1,
    });
    const client = new AbmindClient(transport);
    try {
      await client.negotiate();
      // A mismatched inner request ID is ambiguous and must not settle the
      // caller; the entry exhausts its budget and settles outcome_unknown.
      await expect(client.callRaw<{ ok: boolean }>("system.status", {})).rejects.toMatchObject({ code: "outcome_unknown" });
      expect(outbox.counts().terminalUnknown).toBe(1);
      expect(outbox.get("missing")).toBeNull();
    } finally {
      await client.close();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Silence unused-import warnings for helpers used only inside tests above.
void spawnSync;

// ── #1701: WSS quiesce/final-stop lifecycle ──────────────────────────────────

describe("SignedWssEndpoint quiesce/final-stop (#1701)", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    delete process.env.ABMIND_REMOTE_DIR;
    delete process.env.ABMIND_HOME;
    try { rmSync(env.root, { recursive: true, force: true }); } catch { }
  });

  it("quiesce refuses new peers while an established peer keeps being served; final stop is bounded", async () => {
    const peer = addPeer(env, "peer-quip");
    const port = await findFreePort();
    writeDaemonConfig(env, port,
      [{ peerId: "peer-quip", principalId: "principal-a", domains: ["system"], methods: ["system.negotiate", "system.status"], capabilities: [] }],
      [{ peerId: "peer-quip", verifyKey: peer.pubPem, enrolledAt: new Date().toISOString() }],
    );
    const endpoint = await startEndpoint(env, port);

    const outbox = new RequestOutbox("peer-quip", join(env.root, "outbox-quip.json"));
    const transport = new SignedWssTransport({
      name: "peer-quip", url: `wss://127.0.0.1:${port}`,
      peerId: "peer-quip", signingKeyPath: peer.keyPath, serverCertSha256: env.pin,
    }, outbox);
    const client = new AbmindClient(transport);
    await client.negotiate();

    endpoint.quiesce();

    // The established peer still completes a full round-trip: the stub
    // service answers every request with a typed error body, and receiving
    // THAT response proves the kept connection still delivers.
    await expect(client.callRaw("system.status", {}, "quip-status-1"))
      .rejects.toMatchObject({ code: "internal_error" });

    // A NEW connection cannot even reach the endpoint: the listener no
    // longer accepts. Raw socket error fires immediately (the client-side
    // transport would retry with backoff, so it is not used here).
    const late = new WebSocket(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false });
    await expect(new Promise<never>((_, reject) => { late.once("error", reject); }))
      .rejects.toThrow();

    // Final stop is bounded by the supplied budget and reports the outcome.
    const startedAt = Date.now();
    const result = await endpoint.stop(2_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.drained).toBe(true);
    expect(result.remainingRequests).toBe(0);

    await client.close().catch(() => {});
  });

  it("rejects established-socket frames after service admission closes without dispatching them", async () => {
    const peer = addPeer(env, "peer-closed");
    const port = await findFreePort();
    writeDaemonConfig(env, port,
      [{ peerId: "peer-closed", principalId: "principal-closed", domains: ["system"], methods: ["system.negotiate", "system.status"], capabilities: [] }],
      [{ peerId: "peer-closed", verifyKey: peer.pubPem, enrolledAt: new Date().toISOString() }],
    );

    let closed = false;
    let dispatched = 0;
    const service = {
      get isClosed(): boolean { return closed; },
handle: async (req: { requestId: string; method?: string }) => {
        dispatched++;
        return { ok: true, requestId: req.requestId, result: { version: 1, methods: [], features: {} } };
      },
    } as unknown as AbmindService;
    process.env.ABMIND_REMOTE_DIR = env.remoteDir;
    process.env.ABMIND_HOME = join(env.homeDir, ".abmind");
    const endpoint = new SignedWssEndpoint(service);
    await endpoint.start();

    const outbox = new RequestOutbox("peer-closed", join(env.root, "outbox-closed.json"));
    const transport = new SignedWssTransport({
      name: "peer-closed", url: `wss://127.0.0.1:${port}`,
      peerId: "peer-closed", signingKeyPath: peer.keyPath, serverCertSha256: env.pin,
    }, outbox);
    const client = new AbmindClient(transport);
    try {
      await client.negotiate();
      expect(dispatched).toBe(1);

      closed = true;
      endpoint.quiesce();
      await expect(client.callRaw("system.status", {}, "late-after-close"))
        .rejects.toMatchObject({ code: "unavailable" });
      expect(dispatched).toBe(1);

      const result = await endpoint.stop(2_000);
      expect(result.drained).toBe(true);
    } finally {
      await client.close().catch(() => {});
      await endpoint.stop(2_000);
    }
  });

  it("waits for an accepted response to be queued before final client close", async () => {
    const peer = addPeer(env, "peer-drain");
    const port = await findFreePort();
    writeDaemonConfig(env, port,
      [{ peerId: "peer-drain", principalId: "principal-drain", domains: ["system"], methods: ["system.negotiate", "system.status"], capabilities: [] }],
      [{ peerId: "peer-drain", verifyKey: peer.pubPem, enrolledAt: new Date().toISOString() }],
    );

    let releaseStatus!: () => void;
    let statusEntered!: () => void;
    const statusStarted = new Promise<void>((resolve) => { statusEntered = resolve; });
    const service = {
      isClosed: false,
      handle: async (req: { requestId: string; method?: string }) => {
        if (req.method === "system.negotiate") {
          return { ok: true, requestId: req.requestId, result: { version: 1, methods: [], features: {} } };
        }
        if (req.method === "system.status") {
          statusEntered();
          await new Promise<void>((resolve) => { releaseStatus = resolve; });
        }
        return { ok: false, requestId: req.requestId, error: { code: "internal_error", message: "stub" } };
      },
    } as unknown as AbmindService;

    process.env.ABMIND_REMOTE_DIR = env.remoteDir;
    process.env.ABMIND_HOME = join(env.homeDir, ".abmind");
    const endpoint = new SignedWssEndpoint(service);
    await endpoint.start();

    const outbox = new RequestOutbox("peer-drain", join(env.root, "outbox-drain.json"));
    const transport = new SignedWssTransport({
      name: "peer-drain", url: `wss://127.0.0.1:${port}`,
      peerId: "peer-drain", signingKeyPath: peer.keyPath, serverCertSha256: env.pin,
    }, outbox);
    const client = new AbmindClient(transport);
    try {
      await client.negotiate();
      const request = client.callRaw("system.status", {}, "drain-status");
      await statusStarted;

      endpoint.quiesce();
      const stopping = endpoint.stop(2_000);
      await new Promise((resolve) => setTimeout(resolve, 50));
      releaseStatus();

      await expect(request).rejects.toMatchObject({ code: "internal_error" });
      const result = await stopping;
      expect(result.drained).toBe(true);
      expect(result.remainingRequests).toBe(0);
    } finally {
      await client.close().catch(() => {});
      releaseStatus?.();
      await endpoint.stop(2_000);
    }
  });
});
