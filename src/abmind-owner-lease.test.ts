import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOwnerLease, InjectableProcessIdentity, OwnerLeaseError, cleanTombstones } from "./abmind-owner-lease.js";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "abmind-lease-"));
}

describe("OwnerLease", () => {
  it("acquires and releases a lease", async () => {
    const dir = makeDir();
    try {
      const identity = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const lease = await createOwnerLease({
        runRoot: dir,
        databasePath: join(dir, "memory.db"),
        mode: "embedded",
        processIdentity: identity,
      });

      expect(lease.state).toBe("released");
      await lease.acquire();
      expect(lease.state).toBe("acquired");

      const leaseFile = join(dir, "owners", `${require("crypto").createHash("sha256").update(join(dir, "memory.db")).digest("hex")}.lease`);
      expect(existsSync(join(leaseFile, "owner.json"))).toBe(true);

      await lease.release();
      expect(lease.state).toBe("released");
      expect(existsSync(leaseFile)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects concurrent acquisition by different instance", async () => {
    const dir = makeDir();
    try {
      const identity1 = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const identity2 = new InjectableProcessIdentity({ pid: 1002, startToken: "boot-456" });

      const lease1 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity1,
      });
      await lease1.acquire();

      identity2.setInspectResult(1001, { state: "live", startToken: "boot-123" });

      const lease2 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity2,
      });
      await expect(lease2.acquire()).rejects.toThrow(OwnerLeaseError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses one lease root across aliased run roots", async () => {
    const dir = makeDir();
    const alias = join(tmpdir(), `abmind-lease-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      symlinkSync(dir, alias, "dir");
      const identity1 = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const identity2 = new InjectableProcessIdentity({ pid: 1002, startToken: "boot-456" });
      const lease1 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity1,
      });
      await lease1.acquire();

      identity2.setInspectResult(1001, { state: "live", startToken: "boot-123" });
      const lease2 = await createOwnerLease({
        runRoot: alias, databasePath: join(alias, "memory.db"), mode: "embedded", processIdentity: identity2,
      });
      await expect(lease2.acquire()).rejects.toThrow(OwnerLeaseError);
      await lease1.release();
    } finally {
      rmSync(alias, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows stale takeover when owner PID is dead", async () => {
    const dir = makeDir();
    try {
      const identity1 = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const identity2 = new InjectableProcessIdentity({ pid: 1002, startToken: "boot-456" });

      const lease1 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity1,
      });
      await lease1.acquire();

      identity2.setInspectResult(1001, { state: "dead" });

      const lease2 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity2,
      });
      await lease2.acquire();
      expect(lease2.state).toBe("acquired");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stale takeover when PID is unknown (fail closed)", async () => {
    const dir = makeDir();
    try {
      const identity1 = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const identity2 = new InjectableProcessIdentity({ pid: 1002, startToken: "boot-456" });

      const lease1 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity1,
      });
      await lease1.acquire();

      identity2.setInspectResult(1001, { state: "unknown", reason: "permission denied" });

      const lease2 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity2,
      });
      await expect(lease2.acquire()).rejects.toThrow(OwnerLeaseError);
      await lease1.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not release another owner's lease", async () => {
    const dir = makeDir();
    try {
      const identity1 = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const identity2 = new InjectableProcessIdentity({ pid: 1002, startToken: "boot-456" });

      const lease1 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity1,
      });
      await lease1.acquire();

      const hash = require("crypto").createHash("sha256").update(join(dir, "memory.db")).digest("hex");
      const leasePath = join(dir, "owners", `${hash}.lease`);

      const lease2 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity2,
      });
      identity2.setInspectResult(1001, { state: "dead" });
      await lease2.acquire();

      await lease1.release();
      expect(existsSync(leasePath)).toBe(true);
      await lease2.release();
      expect(existsSync(leasePath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles release of already-released lease", async () => {
    const dir = makeDir();
    try {
      const identity = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const lease = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity,
      });
      await lease.release();
      expect(lease.state).toBe("released");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleanTombstones removes stale directories", async () => {
    const dir = makeDir();
    try {
      mkdirSync(join(dir, ".stale-abc-123-def"), { recursive: true });
      mkdirSync(join(dir, ".stale-ghi-456-jkl"), { recursive: true });
      writeFileSync(join(dir, ".stale-abc-123-def", "owner.json"), "{}");

      cleanTombstones(dir);

      expect(existsSync(join(dir, ".stale-abc-123-def"))).toBe(false);
      expect(existsSync(join(dir, ".stale-ghi-456-jkl"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clean non-stale entries", async () => {
    const dir = makeDir();
    try {
      mkdirSync(dir, { recursive: true });
      const validDir = join(dir, "abcdef123456.lease");
      mkdirSync(validDir, { recursive: true });

      cleanTombstones(dir);
      expect(existsSync(validDir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
