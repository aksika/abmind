import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { lockDirPath, OWNER_FILE } from "./shared-native-deps-paths.js";
import type { LockOwner, NativeConsumer } from "./shared-native-deps-types.js";
import { PROTOCOL_VERSION } from "./shared-native-deps-types.js";

export class LockError extends Error {
  constructor(msg: string) { super(msg); this.name = "LockError"; }
}

export function generateLockToken(): string {
  return randomUUID();
}

function ownerPath(): string {
  return join(lockDirPath(), OWNER_FILE);
}

export function acquireLock(
  product: NativeConsumer,
  operation: string,
  token: string,
  timeoutMs = 6000,
): void {
  const dir = lockDirPath();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Directory exists — someone else holds the lock
    }

    if (!existsSync(dir)) {
      wait(200);
      continue;
    }

    const ownerP = ownerPath();
    if (existsSync(ownerP)) {
      const owner = parseOwner();
      if (owner) {
        if (owner.token === token) return;
        const staleReason = isStale(owner);
        if (staleReason) {
          rmSync(dir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LockError(`Lock held by ${owner.product} (PID ${owner.pid}) — try again later`);
        }
        wait(200);
        continue;
      }
    }

    const owner: LockOwner = {
      protocolVersion: PROTOCOL_VERSION,
      token,
      product,
      operation,
      pid: process.pid,
      hostname: hostname(),
      processStartedAt: Date.now(),
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(ownerP, JSON.stringify(owner, null, 2) + "\n", { mode: 0o644 });
    return;
  }

  throw new LockError("Lock acquisition timed out");
}

export function releaseLock(token: string): void {
  try {
    const ownerP = ownerPath();
    if (!existsSync(ownerP)) return;
    const raw = readFileSync(ownerP, "utf-8");
    const owner = JSON.parse(raw) as LockOwner;
    if (owner.token === token) {
      rmSync(lockDirPath(), { recursive: true, force: true });
    }
  } catch {
    // Best-effort
  }
}

function parseOwner(): LockOwner | null {
  try {
    const raw = readFileSync(join(lockDirPath(), OWNER_FILE), "utf-8");
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

function isStale(owner: LockOwner): string | null {
  if (owner.hostname !== hostname()) return null;
  try {
    process.kill(owner.pid, 0);
    return null;
  } catch {
    return "owner process gone";
  }
}

function wait(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { /* busy-spin */ }
}
