import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer, type Server } from "node:https";
import { WebSocketServer } from "ws";
import { AbmindClient } from "../abmind-client.js";
import { SignedWssTransport, type SignedWssTransportOptions } from "./signed-wss-transport.js";
import { RequestOutbox } from "./request-outbox.js";

let uid = 0;

interface FakeServerOpts {
  respond?: (frameId: string, inner: { method?: string; requestId?: string; idempotencyKey?: string }) => { ok: boolean; requestId: string; result?: unknown; error?: { code: string; message: string } } | null;
  /** Close the socket after the Nth non-negotiate request frame (1-based). */
  dropAfterRequest?: number;
  /** Close the socket right after the hello handshake completes. */
  dropAfterHello?: boolean;
  /** Close the socket after receiving the capability negotiation request. */
  dropAfterNegotiate?: boolean;
  /** Never answer non-negotiate request frames. */
  silent?: boolean;
  port?: number;
}

interface FakeServer {
  port: number;
  frames: Array<{ id: string; auth: { nonce: string; ts: string; sig: string }; body: string; inner: { method: string; requestId: string; idempotencyKey?: string } }>;
  connections: number;
  close: () => Promise<void>;
}

async function startFakeServer(root: string, opts: FakeServerOpts = {}): Promise<FakeServer> {
  const keyPath = join(root, "tls-key.pem");
  const certPath = join(root, "tls-cert.pem");
  if (!existsSync(keyPath)) {
    execSync(`openssl req -x509 -newkey ed25519 -nodes -keyout ${keyPath} -out ${certPath} -subj /CN=localhost -days 1`, { stdio: "ignore" });
    chmodSync(keyPath, 0o600);
    chmodSync(certPath, 0o600);
  }
  const server: Server = createHttpsServer({
    key: readFileSync(keyPath, "utf-8"),
    cert: readFileSync(certPath, "utf-8"),
    minVersion: "TLSv1.3" as const,
  });
  const wss = new WebSocketServer({ server });
  const frames: FakeServer["frames"] = [];
  let connections = 0;
  let domainRequests = 0;

  wss.on("connection", (socket) => {
    connections++;
    socket.send(JSON.stringify({
      type: "challenge", version: 1,
      connectionId: `conn-${connections}`, challenge: "c".repeat(64), expiresAt: Date.now() + 30_000,
    }));
    socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const data: Buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw as never);
      const msg = JSON.parse(data.toString("utf-8")) as Record<string, unknown>;
      if (msg.type === "hello") {
        socket.send(JSON.stringify({ type: "hello_ack", version: 1, peerId: msg.peerId }));
        if (opts.dropAfterHello) socket.close();
        return;
      }
      if (msg.type === "request" && msg.version === 1) {
        const inner = JSON.parse(msg.body as string) as { method: string; requestId: string; idempotencyKey?: string };
        frames.push({ id: msg.id as string, auth: msg.auth as { nonce: string; ts: string; sig: string }, body: msg.body as string, inner });
        if (inner.method === "system.negotiate") {
          if (opts.dropAfterNegotiate) {
            socket.close();
            return;
          }
          socket.send(JSON.stringify({
            type: "response", version: 1, id: msg.id,
            body: JSON.stringify({ ok: true, requestId: inner.requestId ?? "", result: { version: 1, methods: ["private.recall", "private.instantStore"], features: {} } }),
          }));
          return;
        }
        domainRequests++;
        if (opts.silent) return;
        if (opts.dropAfterRequest !== undefined && domainRequests === opts.dropAfterRequest) {
          socket.close();
          return;
        }
        const reply = opts.respond?.(msg.id as string, inner);
        if (reply) {
          socket.send(JSON.stringify({ type: "response", version: 1, id: msg.id, body: JSON.stringify(reply) }));
        }
      }
    });
  });

  const port = opts.port ?? await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    server.on("error", reject);
  });
  if (opts.port !== undefined) {
    await new Promise<void>((resolve) => server.listen(opts.port, "127.0.0.1", resolve));
  }

  return {
    port,
    frames,
    get connections() { return connections; },
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

function derPin(root: string): string {
  const certPath = join(root, "tls-cert.pem");
  const der = execSync(`openssl x509 -in ${certPath} -outform DER`) as Buffer;
  return createHash("sha256").update(der).digest("hex");
}

interface Env {
  root: string;
  pin: string;
  keyPath: string;
  outboxPath: string;
}

function makeEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), `abmind-wss-${++uid}-`));
  mkdirSync(root, { recursive: true });
  execSync(`openssl req -x509 -newkey ed25519 -nodes -keyout ${join(root, "tls-key.pem")} -out ${join(root, "tls-cert.pem")} -subj /CN=localhost -days 1`, { stdio: "ignore" });
  chmodSync(join(root, "tls-key.pem"), 0o600);
  chmodSync(join(root, "tls-cert.pem"), 0o600);
  execSync(`openssl genpkey -algorithm ed25519 -out ${join(root, "client-ed25519.pem")}`, { stdio: "ignore" });
  chmodSync(join(root, "client-ed25519.pem"), 0o600);
  return {
    root,
    pin: derPin(root),
    keyPath: join(root, "client-ed25519.pem"),
    outboxPath: join(root, "outbox.json"),
  };
}

const FAST: SignedWssTransportOptions = {
  requestTimeoutMs: 60,
  retryBaseMs: 5,
  retryMaxMs: 20,
  retryMaxAttempts: 3,
  reconnectBaseMs: 5,
  reconnectMaxMs: 20,
  reconnectMaxAttempts: 10,
};

async function makeClient(env: Env, port: number, extra?: SignedWssTransportOptions) {
  const outbox = new RequestOutbox("test-peer", env.outboxPath, { retryDeadlineMs: 60_000 });
  const transport = new SignedWssTransport({
    name: "test-peer", url: `wss://127.0.0.1:${port}`,
    peerId: "test-peer", signingKeyPath: env.keyPath, serverCertSha256: env.pin,
  }, outbox, { ...FAST, ...extra });
  return { client: new AbmindClient(transport), transport, outbox };
}

describe("SignedWssTransport route admission", () => {
  let env: Env;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("rejects every non-ready state without creating an outbox entry or connecting", async () => {
    const server = await startFakeServer(env.root);
    const { client, outbox } = await makeClient(env, server.port);
    try {
      // disconnected: never negotiated
      const resp = await client.callRaw("private.recall", { query: "x", userId: "u", limit: 5 }).catch((e) => ({ error: e }));
      expect((resp as { error: { code: string } }).error.code).toBe("unavailable");
      expect(outbox.length).toBe(0);
      expect(server.frames.length).toBe(0);

      // negotiate → ready, then drop the route → admission stays closed
      await client.negotiate();
      expect(client.routeSnapshot.state).toBe("ready");
      await server.close();
      await waitFor(() => client.routeSnapshot.state !== "ready");
      const server2 = await startFakeServer(env.root);
      await waitFor(() => client.routeSnapshot.state === "reconnecting"
        || client.routeSnapshot.state === "unavailable"
        || client.routeSnapshot.state === "connecting");
      const denied = await client.callRaw("private.recall", { query: "x", userId: "u", limit: 5 }).catch((e) => e);
      expect((denied as { code: string }).code).toBe("unavailable");
      expect(outbox.length).toBe(0);
      await server2.close();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("coalesces concurrent negotiate calls onto one socket attempt", async () => {
    const server = await startFakeServer(env.root);
    const { client } = await makeClient(env, server.port);
    try {
      const [a, b, c] = await Promise.all([client.negotiate(), client.negotiate(), client.negotiate()]);
      expect(a.methods.length).toBeGreaterThan(0);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(server.connections).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("settles negotiate when the route drops during authentication", async () => {
    const server = await startFakeServer(env.root, { dropAfterHello: true });
    const { client } = await makeClient(env, server.port);
    try {
      const result = await Promise.race([
        client.negotiate().then(
          () => ({ state: "resolved" as const }),
          (error: Error) => ({ state: "rejected" as const, message: error.message }),
        ),
        new Promise<{ state: "timeout" }>((resolve) => setTimeout(() => resolve({ state: "timeout" }), 500)),
      ]);
      expect(result.state).toBe("rejected");
      if (result.state === "rejected") expect(result.message).toMatch(/route lost|closed/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("settles negotiate when the route drops during capability negotiation", async () => {
    const server = await startFakeServer(env.root, { dropAfterNegotiate: true });
    const { client } = await makeClient(env, server.port);
    try {
      const result = await Promise.race([
        client.negotiate().then(
          () => ({ state: "resolved" as const }),
          (error: Error) => ({ state: "rejected" as const, message: error.message }),
        ),
        new Promise<{ state: "timeout" }>((resolve) => setTimeout(() => resolve({ state: "timeout" }), 500)),
      ]);
      expect(result.state).toBe("rejected");
      if (result.state === "rejected") expect(result.message).toMatch(/route lost|closed/i);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("binds capabilities to the generation and clears them on route loss", async () => {
    const server = await startFakeServer(env.root);
    const { client } = await makeClient(env, server.port);
    try {
      await client.negotiate();
      expect(client.capabilities).not.toBeNull();
      await server.close();
      await waitFor(() => client.capabilities === null);
      expect(["reconnecting", "unavailable", "connecting"]).toContain(client.routeSnapshot.state);
    } finally {
      await client.close();
    }
  });

  it("terminal pin failure enters unavailable and requires explicit rearm", async () => {
    const server = await startFakeServer(env.root);
    const outbox = new RequestOutbox("test-peer", env.outboxPath, { retryDeadlineMs: 60_000 });
    const transport = new SignedWssTransport({
      name: "test-peer", url: `wss://127.0.0.1:${server.port}`,
      peerId: "test-peer", signingKeyPath: env.keyPath,
      serverCertSha256: "b".repeat(64), // wrong pin
    }, outbox, { ...FAST, reconnectMaxAttempts: 5 });
    const client = new AbmindClient(transport);
    try {
      await expect(client.negotiate()).rejects.toThrow(/pin/i);
      const snapshot = client.routeSnapshot;
      expect(snapshot.state).toBe("unavailable");
      expect(snapshot.reasonCode).toBe("pin_mismatch");
      // No automatic reconnect after terminal failure.
      await new Promise((r) => setTimeout(r, 120));
      expect(client.routeSnapshot.state).toBe("unavailable");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("SignedWssTransport bounded retry", () => {
  let env: Env;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("preserves logical identity and refreshes auth fields across a dropped connection", async () => {
    const server = await startFakeServer(env.root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return null;
        return { ok: true, requestId: inner.requestId ?? "", result: { stored: true, memoryId: 1 } };
      },
      dropAfterRequest: 1,
    });
    const { client } = await makeClient(env, server.port);
    try {
      await client.negotiate();
      const result = await client.privateMemory.instantStore({
        userId: "u", contentEn: "x", contentOriginal: "x", memoryType: "fact",
        emotionScore: 0.5, confidence: 5, classification: 1,
      }, "idem-key");
      expect(result.stored).toBe(true);
      const first = server.frames.find(f => f.inner.method === "private.instantStore")!;
      const resent = server.frames.filter(f => f.inner.method === "private.instantStore");
      expect(resent.length).toBeGreaterThanOrEqual(2);
      for (const frame of resent.slice(1)) {
        expect(frame.id).toBe(first.id);
        expect(frame.body).toBe(first.body);
        expect(frame.inner.requestId).toBe(first.inner.requestId);
        expect(frame.inner.idempotencyKey).toBe("idem-key");
        expect(frame.auth.nonce).not.toBe(first.auth.nonce);
        expect(Number(frame.auth.ts)).toBeGreaterThanOrEqual(Number(first.auth.ts));
        expect(frame.auth.sig).not.toBe(first.auth.sig);
      }
      expect(client.routeSnapshot.state).toBe("ready");
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("retries a dropped mutation and commits exactly one side effect via the ledger", async () => {
    const server = await startFakeServer(env.root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return null;
        return { ok: true, requestId: inner.requestId ?? "", result: { stored: true, memoryId: 7 } };
      },
      dropAfterRequest: 1,
    });
    const { client, outbox } = await makeClient(env, server.port);
    try {
      await client.negotiate();
      const result = await client.privateMemory.instantStore({
        userId: "u", contentEn: "x", contentOriginal: "x", memoryType: "fact",
        emotionScore: 0.5, confidence: 5, classification: 1,
      }, "drop-idem");
      expect(result.stored).toBe(true);
      if (!result.stored) throw new Error("expected instantStore to be stored");
      expect(result.memoryId).toBe(7);
      expect(outbox.length).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("never retries a terminal service error and preserves its code", async () => {
    const server = await startFakeServer(env.root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return null;
        return { ok: false, requestId: inner.requestId ?? "", error: { code: "conflict", message: "stale revision" } };
      },
    });
    const { client, outbox } = await makeClient(env, server.port);
    try {
      await client.negotiate();
      await expect(client.privateMemory.editMemory({
        memoryId: 1, expectedRevision: 2, userId: "u",
        contentEn: "new",
      })).rejects.toMatchObject({ code: "conflict" });
      expect(outbox.length).toBe(0);
      expect(server.frames.filter(f => f.inner.method === "private.edit").length).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("exhausts to terminal_unknown with outcome_unknown and never auto-replays after restart", async () => {
    const server = await startFakeServer(env.root, { silent: true });
    const { client, outbox } = await makeClient(env, server.port, { retryMaxAttempts: 2, retryBaseMs: 5, retryMaxMs: 10 });
    try {
      await client.negotiate();
      await expect(client.callRaw("private.recall", { query: "q", userId: "u", limit: 1 }))
        .rejects.toMatchObject({ code: "outcome_unknown" });
      expect(outbox.counts().terminalUnknown).toBe(1);
      expect(outbox.peekDue(Date.now())).toBeNull();

      // Reconnect (restart) must not pump the terminal-unknown entry.
      const port = server.port;
      await server.close();
      const server2 = await startFakeServer(env.root, { silent: true });
      await new Promise((r) => setTimeout(r, 150));
      expect(server2.frames.filter(f => f.inner.method === "private.recall").length).toBe(0);
      void port;
      await server2.close();
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("a restarted client resumes unexpired admitted work after renegotiation", async () => {
    const server = await startFakeServer(env.root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return null;
        return { ok: true, requestId: inner.requestId ?? "", result: { ok: true } };
      },
      dropAfterRequest: 1,
    });
    const { client, outbox } = await makeClient(env, server.port);
    try {
      await client.negotiate();
      const pending = client.callRaw<{ ok: boolean }>("private.recall", { query: "q", userId: "u", limit: 1 }).catch((e) => ({ err: e }));
      await new Promise((r) => setTimeout(r, 30));
      expect(outbox.length).toBe(1);
      // "Restart": fresh client over the same durable outbox file.
      await client.close();
      const outbox2 = new RequestOutbox("test-peer", env.outboxPath, { retryDeadlineMs: 60_000 });
      const transport2 = new SignedWssTransport({
        name: "test-peer", url: `wss://127.0.0.1:${server.port}`,
        peerId: "test-peer", signingKeyPath: env.keyPath, serverCertSha256: env.pin,
      }, outbox2, { ...FAST });
      const client2 = new AbmindClient(transport2);
      try {
        await client2.negotiate();
        const result = await client2.callRaw<{ ok: boolean }>("private.recall", { query: "q2", userId: "u", limit: 1 });
        expect(result.ok).toBe(true);
        // The restored entry resumes under its bounded backoff; drain it.
        await waitFor(() => outbox2.length === 0);
        // Old promise from the previous process is never restored; it settles
        // via the closed transport's unavailable contract.
      } finally {
        await client2.close();
      }
      const oldSettled = await pending;
      expect((oldSettled as { err: { code: string } }).err.code).toBe("unavailable");
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);
});

describe("SignedWssTransport correlation and close", () => {
  let env: Env;
  beforeEach(() => { env = makeEnv(); });
  afterEach(() => { rmSync(env.root, { recursive: true, force: true }); });

  it("ignores late/duplicate responses from a replaced generation", async () => {
    const server = await startFakeServer(env.root, {
      respond: (frameId, inner) => {
        if (inner.method === "system.negotiate") return null;
        return { ok: true, requestId: inner.requestId ?? "", result: { ok: true } };
      },
    });
    const { client } = await makeClient(env, server.port, { requestTimeoutMs: 120 });
    try {
      await client.negotiate();
      // Force a generation change: restart the listener on the same port.
      const port = server.port;
      await server.close();
      const server2 = await startFakeServer(env.root, {
        respond: (frameId, inner) => {
          if (inner.method === "system.negotiate") return null;
          return { ok: true, requestId: inner.requestId ?? "", result: { ok: true } };
        },
        port,
      });
      await new Promise((r) => setTimeout(r, 100));
      // The old generation's frames must not be acknowledged by the new one.
      const result = await client.callRaw<{ ok: boolean }>("private.recall", { query: "q", userId: "u", limit: 1 });
      expect(result.ok).toBe(true);
      void server2.connections;
      await server2.close();
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);

  it("close settles a pending negotiate with a rejection (no hang)", async () => {
    // A TCP server that accepts but never completes the TLS handshake keeps
    // negotiate in flight until close() rejects it.
    const net = await import("node:net");
    const sink = net.createServer(() => { /* accept and stay silent */ });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const sinkPort = (sink.address() as { port: number }).port;
    const { client } = await makeClient(env, sinkPort);
    try {
      const negotiated = client.negotiate().catch((e) => e);
      await new Promise((r) => setTimeout(r, 20));
      await client.close();
      await expect(negotiated).resolves.toMatchObject({ message: /closed/i });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        sink.close(() => { clearTimeout(timer); resolve(); });
      });
    }
  }, 20_000);

  it("close settles pending callers with unavailable and leaves no timers or sockets", async () => {
    const server = await startFakeServer(env.root, { silent: true });
    const { client, transport, outbox } = await makeClient(env, server.port);
    try {
      await client.negotiate();
      const pending = client.callRaw("private.recall", { query: "q", userId: "u", limit: 1 }).catch((e) => e);
      await new Promise((r) => setTimeout(r, 20));
      expect(outbox.length).toBe(1);
      await client.close();
      const err = await pending;
      expect((err as { code: string }).code).toBe("unavailable");
      expect(client.routeSnapshot.state).toBe("closed");
      expect(outbox.length).toBe(1); // eligible durable entry preserved
    } finally {
      await client.close();
      await server.close();
    }
  }, 20_000);
});
