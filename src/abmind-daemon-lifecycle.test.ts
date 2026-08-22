import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { MemoryConfig } from "./memory-config.js";
import { runDaemon, type DaemonOptions, type DaemonDeps } from "../cli/abmind-daemon.js";
import { createOwnerLease, LinuxProcessIdentity } from "./abmind-owner-lease.js";

const MEM_CONFIG: MemoryConfig = {
  memoryEnabled: true,
  memoryDir: "",
  maxMessagesPerChat: 100,
  diskBudgetBytes: 1048576,
  stalenessThresholdMs: 86400000,
  restoreMessageCount: 50,
  ingestChunkMaxTokens: 512,
  embeddingModel: "nomic-embed-text",
  forgetThreshold: 0.8,
  searchEnhancements: {
    searchTimeoutMs: 1000,
    decayHalflifeDays: 30,
    mmrLambda: 0.7,
    compactThresholdPct: 85,
  },
};

/** Signal handlers captured through DaemonDeps — no real OS signals. */
class SignalHarness {
  readonly handlers = new Map<string, () => void>();
  shutdownLogLines = 0;
  readonly deps: DaemonDeps;

  constructor() {
    this.deps = {
      onSignal: (sig, handler) => { this.handlers.set(sig, handler); },
      abortableDelay: (ms, signal) => new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(resolve, Math.min(ms, 250));
        signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      }),
    };
  }

  send(sig: "SIGINT" | "SIGTERM"): void {
    this.handlers.get(sig)?.();
  }
}

function makeEnv(): { root: string; memoryDir: string; socketPath: string; leaseDir: string; previousHome: string | undefined } {
  const root = mkdtempSync(join(tmpdir(), "abmind-daemon-lifecycle-"));
  const memoryDir = join(root, "memory");
  const socketPath = join(root, "run", "abmind.sock");
  // The daemon listens on socketPath directly — its parent dir must exist.
  mkdirSync(memoryDir, { recursive: true });
  mkdirSync(join(root, "run"), { recursive: true });
  mkdirSync(join(root, "home", ".abmind"), { recursive: true });
  const dbHash = createHash("sha256").update(join(memoryDir, "memory.db")).digest("hex");
  const leaseDir = join(root, "home", ".abmind", "run", "leases", "owners", `${dbHash}.lease`);
  const previousHome = process.env.ABMIND_HOME;
  process.env.ABMIND_HOME = join(root, "home", ".abmind");
  return { root, memoryDir, socketPath, leaseDir, previousHome };
}

async function withEnvRoot<T>(env: { memoryDir: string }, fn: (memoryDir: string) => Promise<T>): Promise<T> {
  return fn(env.memoryDir);
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000, stepMs = 25): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("runDaemon lifecycle (#1701)", () => {
  let env: ReturnType<typeof makeEnv>;

  afterEach(() => {
    if (env) {
      if (env.previousHome === undefined) delete process.env.ABMIND_HOME;
      else process.env.ABMIND_HOME = env.previousHome;
      rmSync(env.root, { recursive: true, force: true });
    }
  });

  it("a SIGTERM during normal operation wakes runDaemon and resolves only after socket AND owner lease are gone — without calling process.exit", async () => {
    env = makeEnv();
    await withEnvRoot(env, async (memoryDir) => {
      const harness = new SignalHarness();
      const opts: DaemonOptions = { socketPath: env.socketPath, principalMapping: "self", waitForOwner: false };
      const running = runDaemon({ ...MEM_CONFIG, memoryDir }, opts, harness.deps);

      // The daemon is serving once its Unix socket exists.
      await waitFor(() => existsSync(env.socketPath));
      expect(existsSync(env.leaseDir)).toBe(true);

      harness.send("SIGTERM");
      await running; // must resolve on its own — no process.exit anywhere

      expect(existsSync(env.socketPath)).toBe(false);
      expect(existsSync(env.leaseDir)).toBe(false);
    });
  });

  it("repeated signals join one cleanup: one shutdown log line and exactly-once teardown", async () => {
    env = makeEnv();
    await withEnvRoot(env, async (memoryDir) => {
      const harness = new SignalHarness();
      const originalConsoleError = console.error;
      console.error = (...parts: unknown[]) => {
        const line = parts.map(String).join(" ");
        if (line.includes("Shutting down (")) harness.shutdownLogLines++;
      };
      try {
        const opts: DaemonOptions = { socketPath: env.socketPath, principalMapping: "self", waitForOwner: false };
        const running = runDaemon({ ...MEM_CONFIG, memoryDir }, opts, harness.deps);
        await waitFor(() => existsSync(env.socketPath));

        harness.send("SIGTERM");
        harness.send("SIGTERM");
        harness.send("SIGINT");
        await running;

        expect(harness.shutdownLogLines).toBe(1);
        expect(existsSync(env.leaseDir)).toBe(false);
      } finally {
        console.error = originalConsoleError;
      }
    });
  });

  it("a signal during the owner wait wakes the retry delay, exits cleanly, and never takes or releases a foreign lease", async () => {
    env = makeEnv();
    await withEnvRoot(env, async (memoryDir) => {
      // A LIVE foreign owner (this process, real identity) holds the lease, so
      // the daemon's acquisition fails closed with OwnerLeaseError instead of
      // recovering it as stale.
      const foreignLease = await createOwnerLease({
        runRoot: join(env.root, "home", ".abmind", "run", "leases"),
        databasePath: join(memoryDir, "memory.db"),
        mode: "daemon",
        processIdentity: new LinuxProcessIdentity(),
      });
      await foreignLease.acquire();
      expect(existsSync(env.leaseDir)).toBe(true);

      const harness = new SignalHarness();
      const opts: DaemonOptions = { socketPath: env.socketPath, principalMapping: "self", waitForOwner: true };
      const running = runDaemon({ ...MEM_CONFIG, memoryDir }, opts, harness.deps);

      // Wait until the daemon is parked in its abortable retry delay.
      await new Promise((r) => setTimeout(r, 400));

      harness.send("SIGTERM");
      await running;

      // The daemon exits cleanly without touching the successor's lease
      // (release is owner-instance checked) and without ever listening.
      expect(existsSync(env.leaseDir)).toBe(true);
      expect(existsSync(env.socketPath)).toBe(false);
      await foreignLease.release();
      expect(existsSync(env.leaseDir)).toBe(false);
    });
  });

  it("uses DaemonOptions.socketPath rather than re-reading argv", async () => {
    env = makeEnv();
    await withEnvRoot(env, async (memoryDir) => {
      const customSocket = join(env.root, "custom", "endpoint.sock");
      mkdirSync(join(env.root, "custom"), { recursive: true });
      const harness = new SignalHarness();
      const opts: DaemonOptions = { socketPath: customSocket, principalMapping: "peer_uid", waitForOwner: false };
      const running = runDaemon({ ...MEM_CONFIG, memoryDir }, opts, harness.deps);

      await waitFor(() => existsSync(customSocket));

      harness.send("SIGINT");
      await running;
      expect(existsSync(customSocket)).toBe(false);
    });
  });

  it("a genuine startup failure (held lease, no wait-for-owner) propagates to the wrapper instead of exiting internally", async () => {
    env = makeEnv();
    await withEnvRoot(env, async (memoryDir) => {
      // A LIVE holder (this process, real identity) makes acquisition fail
      // closed immediately — the error must surface as a rejection so the
      // direct wrapper can turn it into exit 1.
      const foreignLease = await createOwnerLease({
        runRoot: join(env.root, "home", ".abmind", "run", "leases"),
        databasePath: join(memoryDir, "memory.db"),
        mode: "daemon",
        processIdentity: new LinuxProcessIdentity(),
      });
      await foreignLease.acquire();

      const harness = new SignalHarness();
      const opts: DaemonOptions = { socketPath: env.socketPath, principalMapping: "self", waitForOwner: false };

      await expect(runDaemon({ ...MEM_CONFIG, memoryDir }, opts, harness.deps)).rejects.toThrow(/already owned by pid/);

      await foreignLease.release();
    });
  });
});
