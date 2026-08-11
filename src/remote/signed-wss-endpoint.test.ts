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
    handle: async (req) => {
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
