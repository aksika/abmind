import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { WebSocketServer } from "ws";
import { checkWssEndpoint } from "./doctor-wss.js";

let tmpRoot: string;
let remoteDir: string;

function writeRestricted(name: string, data: unknown): void {
  const p = join(remoteDir, name);
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  chmodSync(p, 0o600);
}

function writeEndpoint(port: number, opts?: { enabled?: boolean; certPath?: string; keyPath?: string }): void {
  writeRestricted("endpoint.json", {
    enabled: opts?.enabled ?? true,
    host: "127.0.0.1",
    port,
    tlsCertPath: opts?.certPath ?? join(remoteDir, "tls-cert.pem"),
    tlsKeyPath: opts?.keyPath ?? join(remoteDir, "tls-key.pem"),
  });
}

function writeDummyTls(): { certPath: string; keyPath: string } {
  const certPath = join(remoteDir, "tls-cert.pem");
  const keyPath = join(remoteDir, "tls-key.pem");
  writeRestricted("tls-cert.pem", "dummy-cert");
  writeRestricted("tls-key.pem", "dummy-key");
  return { certPath, keyPath };
}

function writeRealTls(): { certPath: string; keyPath: string } {
  const certPath = join(remoteDir, "tls-cert.pem");
  const keyPath = join(remoteDir, "tls-key.pem");
  execSync(
    `openssl req -x509 -newkey ed25519 -nodes -keyout ${keyPath} -out ${certPath} -subj /CN=localhost -days 1`,
    { stdio: "ignore" },
  );
  chmodSync(keyPath, 0o600);
  chmodSync(certPath, 0o600);
  return { certPath, keyPath };
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

/** Minimal challenge server: sends one challenge frame per connection. */
async function startChallengeServer(port: number, certPath: string, keyPath: string): Promise<() => Promise<void>> {
  const { readFileSync } = await import("node:fs");
  const server = createHttpsServer({
    key: readFileSync(keyPath, "utf-8"),
    cert: readFileSync(certPath, "utf-8"),
    minVersion: "TLSv1.3" as const,
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "challenge", version: 1, connectionId: "c1", challenge: "ch", expiresAt: Date.now() + 30_000 }));
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "doctor-wss-test-"));
  remoteDir = join(tmpRoot, "remote");
  mkdirSync(remoteDir, { recursive: true });
  process.env["ABMIND_REMOTE_DIR"] = remoteDir;
});

afterEach(() => {
  delete process.env["ABMIND_REMOTE_DIR"];
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("checkWssEndpoint (#1948)", () => {
  it("returns no checks when the endpoint is disabled", async () => {
    writeEndpoint(0, { enabled: false });
    writeDummyTls();
    await expect(checkWssEndpoint()).resolves.toEqual([]);
  });

  it("returns no checks when there is no endpoint config", async () => {
    await expect(checkWssEndpoint()).resolves.toEqual([]);
  });

  it("warns per dropped method and on loopback when nothing listens", async () => {
    const port = await findFreePort();
    writeEndpoint(port);
    writeDummyTls();
    writeRestricted("enrollments.json", [{ peerId: "peer-a", verifyKey: "v", enrolledAt: "t" }]);
    writeRestricted("grants.json", [
      { peerId: "peer-a", principalId: "p", domains: ["private"], methods: ["private.recall", "private.attribution"], capabilities: [] },
    ]);

    const checks = await checkWssEndpoint();
    const grants = checks.filter(c => c.id === "wss-grants");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.status).toBe("warn");
    expect(grants[0]?.message).toContain("private.attribution");
    const loopback = checks.filter(c => c.id === "wss-loopback");
    expect(loopback).toHaveLength(1);
    expect(loopback[0]?.status).toBe("warn");
  });

  it("reports error when grants.json cannot load", async () => {
    const port = await findFreePort();
    writeEndpoint(port);
    writeDummyTls();
    writeRestricted("enrollments.json", [{ peerId: "peer-a", verifyKey: "v", enrolledAt: "t" }]);
    writeRestricted("grants.json", "{ not json");

    const checks = await checkWssEndpoint();
    const grants = checks.filter(c => c.id === "wss-grants");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.status).toBe("error");
  });

  it("reports ok when grants are clean and the endpoint answers", async () => {
    const port = await findFreePort();
    const { certPath, keyPath } = writeRealTls();
    writeEndpoint(port, { certPath, keyPath });
    writeRestricted("enrollments.json", [{ peerId: "peer-a", verifyKey: "v", enrolledAt: "t" }]);
    writeRestricted("grants.json", [
      { peerId: "peer-a", principalId: "p", domains: ["private"], methods: ["private.recall"], capabilities: [] },
    ]);
    const stop = await startChallengeServer(port, certPath, keyPath);
    try {
      const checks = await checkWssEndpoint();
      expect(checks.find(c => c.id === "wss-grants")).toMatchObject({ status: "ok" });
      expect(checks.find(c => c.id === "wss-loopback")).toMatchObject({ status: "ok" });
    } finally {
      await stop();
    }
  });
});
