/**
 * #1813 — installed-CLI serialization acceptance (integration lane).
 *
 * Fully installed path: the packaged daemon binary serves a real Unix socket
 * and tmp database; the packaged dist CLI (store/recall/hook-recall) runs as
 * child processes against it. No judgment backend, provider, or network: the
 * decision is explicitly null and hook output stays text-only. Proves the wire
 * paths (CLI args, protocol, output shapes), not core logic.
 *
 * NOTE: the daemon runs as a child CLI process, not in-process runDaemon:
 * an in-process daemon plus spawned CLI children hangs negotiation in this
 * environment (unresolved; the shipped topology is daemon-process +
 * CLI-process, which is what this exercises).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, spawnSync, type ChildProcess, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolatedChildEnv } from "./test-support/runtime-isolation.js";

const DISPATCHER = resolve(__dirname, "../dist/cli/abmind.js");
const DAEMON = resolve(__dirname, "../dist/cli/abmind-daemon.js");

async function waitFor(condition: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("#1813 — installed CLI fast-path serialization", () => {
  let root: string;
  let socketPath: string;
  let env: Record<string, string | undefined>;
  let daemon: ChildProcess | null = null;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "fastpath-cli-"));
    mkdirSync(join(root, "memory"), { recursive: true });
    mkdirSync(join(root, "run"), { recursive: true });
    socketPath = join(root, "run", "abmind.sock");
    env = isolatedChildEnv({
      ABMIND_HOME: root,
      ABMIND_ENDPOINT: socketPath,
      ABMIND_USER_ID: "cli-user",
    });
    daemon = spawn("node", [DAEMON, "--socket", socketPath], {
      env: env as SpawnSyncOptions["env"], stdio: "ignore",
    });
    await waitFor(() => existsSync(socketPath));
  });

  afterEach(async () => {
    if (daemon) {
      daemon.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { daemon?.kill("SIGKILL"); resolve(); }, 10_000);
        daemon?.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      daemon = null;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function run(args: string[], input?: string) {
    const result = spawnSync("node", [DISPATCHER, ...args], {
      env: env as SpawnSyncOptions["env"], encoding: "utf8", timeout: 60000,
      ...(input !== undefined ? { input } : {}),
    });
    return { status: result.status, stdout: result.stdout as string, stderr: result.stderr as string };
  }

  it("legacy recall prints an array; --decision prints the envelope", () => {
    const stored = run(["store", "--translated", "Production deploys run via /deploy prod.",
      "--original", "Production deploys run via /deploy prod.",
      "--memory-type", "fact", "--emotion-score", "0", "--user-id", "cli-user"]);
    expect(stored.status).toBe(0);

    const legacy = run(["recall", "--translated", "deploy", "--user-id", "cli-user"]);
    expect(legacy.status).toBe(0);
    const legacyBody: unknown = JSON.parse(legacy.stdout);
    expect(Array.isArray(legacyBody)).toBe(true);
    expect((legacyBody as unknown[]).length).toBeGreaterThan(0);

    const structured = run(["recall", "--translated", "deploy", "--user-id", "cli-user",
      "--question", "How do I deploy?", "--session", "s1", "--turn", "t1", "--decision"]);
    expect(structured.status).toBe(0);
    const envelope = JSON.parse(structured.stdout) as {
      results: unknown[];
      decision: unknown;
      selection: { version: number; refs: Array<{ id: number; revision: number }> } | null;
    };
    expect(Array.isArray(envelope.results)).toBe(true);
    // No backend, no flag: ordinary recall, decision explicitly null.
    expect(envelope.decision).toBeNull();
    // #1813 — selection is deterministic and backend-independent: present
    // even here with no provider and no fast-path flag.
    expect(envelope.selection?.version).toBe(1);
    expect(envelope.selection?.refs.length).toBeGreaterThan(0);
    expect(envelope.selection?.refs.every((r) => Number.isInteger(r.id) && Number.isInteger(r.revision))).toBe(true);
  });

  it("hook-recall stays text-only with no decision payload", () => {
    const stored = run(["store", "--translated", "Production deploys run via /deploy prod.",
      "--original", "Production deploys run via /deploy prod.",
      "--memory-type", "fact", "--emotion-score", "0", "--user-id", "cli-user"]);
    expect(stored.status).toBe(0);
    const result = run(["hook-recall"],
      JSON.stringify({ hook_event_name: "userPromptSubmit", prompt: "how do I deploy" }));
    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("\"decision\"");
  });
});
