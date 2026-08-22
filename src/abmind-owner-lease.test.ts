import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createOwnerLease, InjectableProcessIdentity, MacOsProcessIdentity, OwnerLeaseError, cleanTombstones } from "./abmind-owner-lease.js";

interface TestMacPsRunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

type TestMacPsRunner = ((pid: number) => TestMacPsRunResult) & { calls: number[] };

function macPsResult(overrides: Partial<TestMacPsRunResult> = {}): TestMacPsRunResult {
  return {
    status: overrides.status ?? null,
    signal: overrides.signal ?? null,
    stdout: overrides.stdout ?? "",
    stderr: overrides.stderr ?? "",
    ...(overrides.error ? { error: overrides.error } : {}),
  };
}

function makeMacPsRunner(resultFor: (pid: number) => TestMacPsRunResult): TestMacPsRunner {
  const calls: number[] = [];
  const runner = ((pid: number) => {
    calls.push(pid);
    return resultFor(pid);
  }) as TestMacPsRunner;
  runner.calls = calls;
  return runner;
}

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

  it("allows stale takeover when owner PID is live but start token differs (PID reuse)", async () => {
    const dir = makeDir();
    try {
      const identity1 = new InjectableProcessIdentity({ pid: 1001, startToken: "boot-123" });
      const identity2 = new InjectableProcessIdentity({ pid: 1002, startToken: "boot-456" });

      const lease1 = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "embedded", processIdentity: identity1,
      });
      await lease1.acquire();

      identity2.setInspectResult(1001, { state: "live", startToken: "boot-reused" });

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

  it("replaces a stale lease through real MacOsProcessIdentity observation", async () => {
    const dir = makeDir();
    const deadOwnerPid = 999999;
    try {
      const oldIdentity = new InjectableProcessIdentity({ pid: deadOwnerPid, startToken: "mac-999999-Mon Aug 17 09:00:00 2026" });
      const oldLease = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "daemon", processIdentity: oldIdentity,
      });
      await oldLease.acquire();

      const runner = makeMacPsRunner((pid) => {
        if (pid === deadOwnerPid) return macPsResult({ status: 1, stdout: "", stderr: "" });
        if (pid === process.pid) return macPsResult({ status: 0, stdout: "Mon Aug 17 12:34:56 2026\n", stderr: "" });
        throw new Error(`unexpected pid ${pid}`);
      });
      const contender = await createOwnerLease({
        runRoot: dir,
        databasePath: join(dir, "memory.db"),
        mode: "daemon",
        processIdentity: new MacOsProcessIdentity(runner),
      });
      await contender.acquire();
      expect(contender.state).toBe("acquired");

      const hash = createHash("sha256").update(join(dir, "memory.db")).digest("hex");
      const owner = JSON.parse(readFileSync(join(dir, "owners", `${hash}.lease`, "owner.json"), "utf-8")) as { pid: number; processStartToken: string };
      expect(owner.pid).toBe(process.pid);
      expect(owner.processStartToken).toBe(`mac-${process.pid}-Mon Aug 17 12:34:56 2026`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the original lease intact when MacOsProcessIdentity cannot classify the owner PID", async () => {
    const dir = makeDir();
    const mysteryPid = 999999;
    try {
      const oldIdentity = new InjectableProcessIdentity({ pid: mysteryPid, startToken: "mac-999999-Mon Aug 17 09:00:00 2026" });
      const oldLease = await createOwnerLease({
        runRoot: dir, databasePath: join(dir, "memory.db"), mode: "daemon", processIdentity: oldIdentity,
      });
      await oldLease.acquire();

      const hash = createHash("sha256").update(join(dir, "memory.db")).digest("hex");
      const leaseFile = join(dir, "owners", `${hash}.lease`, "owner.json");
      const before = readFileSync(leaseFile, "utf-8");

      const runner = makeMacPsRunner((pid) => {
        if (pid === mysteryPid) return macPsResult({ status: 1, stdout: "", stderr: "ps: unknown user or uid" });
        if (pid === process.pid) return macPsResult({ status: 0, stdout: "Mon Aug 17 12:34:56 2026\n", stderr: "" });
        throw new Error(`unexpected pid ${pid}`);
      });
      const contender = await createOwnerLease({
        runRoot: dir,
        databasePath: join(dir, "memory.db"),
        mode: "daemon",
        processIdentity: new MacOsProcessIdentity(runner),
      });
      await expect(contender.acquire()).rejects.toThrow(OwnerLeaseError);
      expect(readFileSync(leaseFile, "utf-8")).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MacOsProcessIdentity", () => {
  it("returns the exact live token from exactly one ps invocation", async () => {
    const runner = makeMacPsRunner(() => macPsResult({ status: 0, stdout: "Mon Aug 17 12:34:56 2026\n", stderr: "" }));
    const identity = new MacOsProcessIdentity(runner);

    await expect(identity.inspect(4242)).resolves.toEqual({
      state: "live",
      startToken: "mac-4242-Mon Aug 17 12:34:56 2026",
    });
    expect(runner.calls).toEqual([4242]);
  });

  it("classifies status 1 with empty output and empty stderr as dead from one invocation", async () => {
    const runner = makeMacPsRunner(() => macPsResult({ status: 1, stdout: "", stderr: "" }));
    const identity = new MacOsProcessIdentity(runner);

    await expect(identity.inspect(4242)).resolves.toEqual({ state: "dead" });
    expect(runner.calls).toEqual([4242]);
  });

  it.each([
    ["spawn error", macPsResult({ error: new Error("spawn /bin/ps ENOENT") })],
    ["signal termination", macPsResult({ signal: "SIGTERM", status: null })],
    ["null status without signal or error", macPsResult({ status: null })],
    ["stderr output on exit 1", macPsResult({ status: 1, stdout: "", stderr: "ps: no such process" })],
    ["stderr output on exit 0", macPsResult({ status: 0, stdout: "Mon Aug 17 12:34:56 2026\n", stderr: "warning" })],
    ["exit 0 with no rows", macPsResult({ status: 0, stdout: "", stderr: "" })],
    ["exit 0 with multiple rows", macPsResult({ status: 0, stdout: "Mon Aug 17 12:34:56 2026\nMon Aug 17 12:34:57 2026\n", stderr: "" })],
    ["unexpected exit status", macPsResult({ status: 2, stdout: "", stderr: "" })],
  ])("treats %s as unknown", async (_label, result) => {
    const runner = makeMacPsRunner(() => result);
    const identity = new MacOsProcessIdentity(runner);

    const outcome = await identity.inspect(4242);
    expect(outcome.state).toBe("unknown");
    if (outcome.state === "unknown") {
      expect(outcome.reason).toMatch(/^(spawn_failed|probe_terminated|unexpected_result|stderr_output|malformed_live_output)$/);
      expect(outcome.reason).not.toContain("no such process");
      expect(outcome.reason).not.toContain("warning");
    }
  });

  it("trims whitespace-only stdout before classifying exit 1 as dead", async () => {
    const runner = makeMacPsRunner(() => macPsResult({ status: 1, stdout: "\n  ", stderr: "" }));
    const identity = new MacOsProcessIdentity(runner);

    await expect(identity.inspect(4242)).resolves.toEqual({ state: "dead" });
    expect(runner.calls).toEqual([4242]);
  });

  it("captures self from one live observation", async () => {
    const runner = makeMacPsRunner(() => macPsResult({ status: 0, stdout: "Mon Aug 17 12:34:56 2026\n", stderr: "" }));
    const identity = new MacOsProcessIdentity(runner);

    await expect(identity.captureSelf()).resolves.toEqual({
      pid: process.pid,
      startToken: `mac-${process.pid}-Mon Aug 17 12:34:56 2026`,
    });
    expect(runner.calls).toEqual([process.pid]);
  });

  it.each([
    ["dead", macPsResult({ status: 1, stdout: "", stderr: "" })],
    ["unknown via spawn error", macPsResult({ error: new Error("spawn /bin/ps ENOENT") })],
    ["unknown via signal", macPsResult({ signal: "SIGTERM", status: null })],
    ["unknown via stderr", macPsResult({ status: 1, stdout: "", stderr: "boom" })],
    ["unknown via malformed rows", macPsResult({ status: 0, stdout: "", stderr: "" })],
  ])("refuses to capture self for %s result without a second invocation or fabricated token", async (_label, result) => {
    const runner = makeMacPsRunner(() => result);
    const identity = new MacOsProcessIdentity(runner);

    await expect(identity.captureSelf()).rejects.toThrow(/Cannot establish current process identity/);
    expect(runner.calls).toEqual([process.pid]);
  });
});

describe("cleanTombstones", () => {
  it("removes stale directories", async () => {
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
