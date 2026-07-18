import { createHash, createPrivateKey, sign as cryptoSign, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as http from "node:http";

const DEFAULT_PORT = 7100;
const HOME = process.env["HOME"] ?? "/root";
const ABTARS_HOME = join(HOME, ".abtars");
const PI_CRED_PATH = join(ABTARS_HOME, "clients", "pi", "credential.json");

interface PiClientCredential {
  version: number;
  clientId: "pi-local";
  keyId: string;
  signingKey: string;
  createdAt: string;
}

interface PiApiOk<T = unknown> {
  ok: true;
  data: T;
  duplicate?: boolean;
}

interface PiApiErr {
  ok: false;
  error: { code: string; message: string; retryable: boolean };
}

export type PiApiResponse<T = unknown> = PiApiOk<T> | PiApiErr;

export interface PiClientState {
  available: boolean;
  reason?: string;
}

let _cachedCred: PiClientCredential | null = null;
let _lastMtime = 0;

function loadCredential(): PiClientCredential | null {
  try {
    if (!existsSync(PI_CRED_PATH)) return null;
    const raw = readFileSync(PI_CRED_PATH, "utf-8");
    const parsed = JSON.parse(raw) as PiClientCredential;
    if (parsed.version !== 1 || parsed.clientId !== "pi-local" || !parsed.signingKey || !parsed.keyId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function getCredential(): PiClientCredential | null {
  try {
    const stat = existsSync(PI_CRED_PATH) ? undefined : null;
    if (stat === null) { _cachedCred = null; return null; }
    const mtime = 0;
    if (!_cachedCred || mtime !== _lastMtime) {
      _cachedCred = loadCredential();
      _lastMtime = mtime;
    }
    return _cachedCred;
  } catch {
    return null;
  }
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

function buildCanonical(
  method: string, path: string, clientId: string, keyId: string, ts: number, nonce: string, body: string,
): string {
  return `abtars-pi-v1\n${method}\n${path}\n${clientId}\n${keyId}\n${ts}\n${nonce}\n${sha256Hex(body)}`;
}

function signCanonical(canonical: string, signingKeyBase64: string): string {
  const privKey = createPrivateKey({
    key: Buffer.from(signingKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return cryptoSign(null, Buffer.from(canonical, "utf-8"), privKey).toString("base64");
}

function getAgentPort(): number {
  try {
    const transportPath = join(ABTARS_HOME, "config", "transport.json");
    if (existsSync(transportPath)) {
      const cfg = JSON.parse(readFileSync(transportPath, "utf-8")) as Record<string, unknown>;
      if (typeof cfg["agentApiPort"] === "number") return cfg["agentApiPort"];
    }
  } catch {
    // fall through
  }
  const envPort = process.env["AGENT_API_PORT"];
  if (envPort) {
    const p = parseInt(envPort, 10);
    if (!isNaN(p) && p > 0 && p < 65536) return p;
  }
  return DEFAULT_PORT;
}

export function checkPiClient(): PiClientState {
  const cred = loadCredential();
  if (!cred) {
    return { available: false, reason: "no-credential" };
  }
  return { available: true };
}

export async function piRequest<T = unknown>(
  method: string, path: string, body?: Record<string, unknown>,
): Promise<PiApiResponse<T>> {
  const cred = getCredential();
  if (!cred) {
    return { ok: false, error: { code: "no_credential", message: "Pi credential not found", retryable: false } };
  }

  const bodyStr = body ? JSON.stringify(body) : "";
  const ts = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const canonical = buildCanonical(method, path, cred.clientId, cred.keyId, ts, nonce, bodyStr);
  const sig = signCanonical(canonical, cred.signingKey);
  const port = getAgentPort();

  return new Promise<PiApiResponse<T>>((resolve) => {
    const headers: Record<string, string> = {
      "X-Abtars-Pi-Client": cred.clientId,
      "X-Abtars-Pi-Key-Id": cred.keyId,
      "X-Abtars-Pi-Ts": String(ts),
      "X-Abtars-Pi-Nonce": nonce,
      "X-Abtars-Pi-Sig": sig,
      "Content-Type": "application/json",
    };
    if (bodyStr) {
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
        timeout: 10_000,
      },
      (res) => {
        let data = "";
        res.on("data", (c: Buffer) => { data += c.toString(); });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data) as PiApiResponse<T>;
            resolve(parsed);
          } catch {
            resolve({
              ok: false,
              error: { code: "bad_response", message: "Invalid JSON response from abtars", retryable: true },
            });
          }
        });
      },
    );

    req.on("error", (err) => {
      resolve({
        ok: false,
        error: {
          code: "connection_failed",
          message: `Cannot reach abtars on 127.0.0.1:${port}: ${err.message}`,
          retryable: true,
        },
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        ok: false,
        error: { code: "timeout", message: "abtars Pi API request timed out", retryable: true },
      });
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}
