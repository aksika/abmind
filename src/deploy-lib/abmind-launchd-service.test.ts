import { describe, expect, it, vi, beforeEach } from "vitest";
import { join } from "node:path";
import {
  resolveLaunchdDaemonEntry,
  xmlEscape,
  renderLaunchdPlist,
  launchdPlistPath,
  installLaunchAgent,
  startLaunchAgent,
  restartLaunchAgent,
  stopLaunchAgent,
  stopLaunchAgentSafe,
  statusLaunchAgent,
  stopOrphanedDaemon,
  createHealthProbe,
  isAbsentBootoutError,
  isTransientBootstrapError,
  PROBE_DEADLINE_MS,
  PROBE_INTERVAL_MS,
  ORPHAN_STOP_TIMEOUT_MS,
  ORPHAN_STOP_POLL_MS,
  BOOTSTRAP_RETRY_ATTEMPTS,
  BOOTSTRAP_RETRY_DELAY_MS,
  type LaunchdServiceDeps,
  type CommandResult,
  type HealthProbeResult,
} from "./abmind-launchd-service.js";
import {
  DAEMON_SHUTDOWN_BUDGET_MS,
  LAUNCHD_EXIT_TIMEOUT_SECONDS,
} from "../daemon-shutdown-contract.js";

// ── Mocks for createHealthProbe (dynamic imports of transport + client) ──

const mockClose = vi.fn();
const mockNegotiate = vi.fn();
const mockHealth = vi.fn();
const mockStatus = vi.fn();
const mockLocalTransportCtor = vi.fn();
const mockAbmindClientCtor = vi.fn();

vi.mock("../local-transport.js", () => ({ LocalTransport: mockLocalTransportCtor }));
vi.mock("../abmind-client.js", () => ({ AbmindClient: mockAbmindClientCtor }));

function makeServiceModuleUrl(prefix: string): string {
  // Simulate source-build path: .../dist/cli/abmind-service.js
  return `file://${prefix}/dist/cli/abmind-service.js`;
}

function fakeDeps(overrides?: Partial<LaunchdServiceDeps>): LaunchdServiceDeps {
  return {
    uid: 501,
    homeDir: "/Users/testuser",
    abmindHome: "/Users/testuser/.abmind",
    serviceModuleUrl: makeServiceModuleUrl("/Users/testuser/projects/abmind"),
    nodeExecutable: "/usr/local/bin/node",
    fileExists: () => true,
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
    command: vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" })),
    probeHealth: vi.fn(async (): Promise<HealthProbeResult> => ({ state: "ready" })),
    delay: vi.fn(async () => {}),
    now: vi.fn(() => Date.now()),
    readOwnerLease: vi.fn(() => null),
    isProcessAlive: vi.fn(() => false),
    terminateProcess: vi.fn(),
    ...overrides,
  };
}

// ── Path resolution ──────────────────────────────────────────────────────────

describe("resolveLaunchdDaemonEntry", () => {
  it("resolves abmind-daemon.js as sibling of abmind-service.js (source build)", () => {
    const url = makeServiceModuleUrl("/Users/test/projects/abmind");
    const r = resolveLaunchdDaemonEntry(url);
    expect(r).toBe("/Users/test/projects/abmind/dist/cli/abmind-daemon.js");
  });

  it("never produces dist/dist path", () => {
    const url = makeServiceModuleUrl("/Users/test/projects/abmind");
    const r = resolveLaunchdDaemonEntry(url);
    expect(r).not.toContain("dist/dist");
  });

  it("resolves abmind-daemon.js in standalone release layout", () => {
    const url = `file:///Users/testuser/.local/lib/node_modules/abmind/dist/cli/abmind-service.js`;
    const r = resolveLaunchdDaemonEntry(url);
    expect(r).toBe("/Users/testuser/.local/lib/node_modules/abmind/dist/cli/abmind-daemon.js");
  });

  it("does not resolve abmind.js (dispatcher removed)", () => {
    const url = makeServiceModuleUrl("/Users/test/projects/abmind");
    const r = resolveLaunchdDaemonEntry(url);
    expect(r).not.toContain("abmind.js");
    expect(r).toContain("abmind-daemon.js");
  });
});

// ── XML escaping ─────────────────────────────────────────────────────────────

describe("xmlEscape", () => {
  it("passes through plain text", () => {
    expect(xmlEscape("/usr/local/bin/node")).toBe("/usr/local/bin/node");
  });

  it("escapes & < > \" '", () => {
    expect(xmlEscape("a&b<c>d\"e'f")).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

// ── Plist rendering ──────────────────────────────────────────────────────────

describe("renderLaunchdPlist", () => {
  it("renders expected plist structure with node + daemon-entry + --wait-for-owner", () => {
    const plist = renderLaunchdPlist({
      nodeExecutable: "/usr/local/bin/node",
      daemonEntryPath: "/Users/test/projects/abmind/dist/cli/abmind-daemon.js",
      abmindHome: "/Users/test/.abmind",
    });
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>abmind</string>');
    expect(plist).toContain('/usr/local/bin/node');
    expect(plist).toContain('/Users/test/projects/abmind/dist/cli/abmind-daemon.js');
    expect(plist).toContain('<string>--wait-for-owner</string>');
    expect(plist).not.toContain('daemon</string>');
    expect(plist).not.toContain('abmind.js');
    expect(plist).toContain('<key>ABMIND_HOME</key>');
    expect(plist).toContain('<string>/Users/test/.abmind</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>10</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<false/>');
  });

  it("renders exactly one ExitTimeOut key with the shared 40-second constant (#1701)", () => {
    const plist = renderLaunchdPlist({
      nodeExecutable: "/usr/local/bin/node",
      daemonEntryPath: "/path/to/abmind-daemon.js",
      abmindHome: "/home/user/.abmind",
    });
    expect((plist.match(/<key>ExitTimeOut<\/key>/g) ?? [])).toHaveLength(1);
    expect(plist).toContain(`<integer>${LAUNCHD_EXIT_TIMEOUT_SECONDS}</integer>`);
    // The explicit supervisor deadline must exceed the daemon's internal budget.
    expect(LAUNCHD_EXIT_TIMEOUT_SECONDS * 1000).toBeGreaterThan(DAEMON_SHUTDOWN_BUDGET_MS);
  });

  it("contains three ProgramArguments entries (node, daemon-entry, --wait-for-owner)", () => {
    const plist = renderLaunchdPlist({
      nodeExecutable: "/usr/local/bin/node",
      daemonEntryPath: "/path/to/abmind-daemon.js",
      abmindHome: "/home/user/.abmind",
    });
    const args = plist.match(/<string>[^<]+<\/string>/g) ?? [];
    expect(args.filter(a => a.includes('abmind-daemon.js'))).toHaveLength(1);
    expect(args.filter(a => a.includes('/bin/node'))).toHaveLength(1);
    expect(args.filter(a => a.includes('--wait-for-owner'))).toHaveLength(1);
    // No entry should be the literal standalone string "daemon"
    expect(args.filter(a => a === '<string>daemon</string>')).toHaveLength(0);
  });

  it("escapes XML-special characters in paths", () => {
    const plist = renderLaunchdPlist({
      nodeExecutable: "/usr/local/bin/node",
      daemonEntryPath: "/Users/test/My&App/abmind-daemon.js",
      abmindHome: "/Users/test/.abmind",
    });
    expect(plist).toContain("/Users/test/My&amp;App/abmind-daemon.js");
    expect(plist).not.toContain("/Users/test/My&App/abmind-daemon.js");
  });

  it("does not contain dist/dist path segment", () => {
    const plist = renderLaunchdPlist({
      nodeExecutable: "/usr/local/bin/node",
      daemonEntryPath: "/Users/test/projects/abmind/dist/cli/abmind-daemon.js",
      abmindHome: "/Users/test/.abmind",
    });
    expect(plist).not.toContain("dist/dist");
  });

  it("does not contain standalone 'daemon' argument", () => {
    const plist = renderLaunchdPlist({
      nodeExecutable: "/usr/local/bin/node",
      daemonEntryPath: "/path/to/abmind-daemon.js",
      abmindHome: "/home/user/.abmind",
    });
    // No <string> entry should be exactly "daemon" (the old dispatcher argument)
    const stringTags = plist.match(/<string>[^<]+<\/string>/g) ?? [];
    const standaloneDaemon = stringTags.filter(t => t === '<string>daemon</string>' || t === '<string>daemon</string>');
    expect(standaloneDaemon).toHaveLength(0);
  });
});

// ── Plist path ───────────────────────────────────────────────────────────────

describe("launchdPlistPath", () => {
  it("returns ~/Library/LaunchAgents/abmind.plist", () => {
    expect(launchdPlistPath("/Users/test")).toBe("/Users/test/Library/LaunchAgents/abmind.plist");
  });
});

// ── Install ──────────────────────────────────────────────────────────────────

describe("installLaunchAgent", () => {
  it("succeeds when daemon entry exists and writes plist with node args", () => {
    const deps = fakeDeps();
    const result = installLaunchAgent(deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plistPath).toBe("/Users/testuser/Library/LaunchAgents/abmind.plist");
    expect(result.daemonEntryPath).toBe("/Users/testuser/projects/abmind/dist/cli/abmind-daemon.js");
    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    const [, content, mode] = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(content).toContain("/usr/local/bin/node");
    expect(content).toContain("abmind-daemon.js");
    expect(content).toContain("--wait-for-owner");
    expect(content).not.toContain("abmind.js");
    expect(mode).toBe(0o644);
  });

  it("fails when daemon entry does not exist", () => {
    const deps = fakeDeps({ fileExists: () => false });
    const result = installLaunchAgent(deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Daemon entry not found");
    expect(result.error).toContain("abmind-daemon.js");
  });

  it("creates LaunchAgents directory if missing", () => {
    const deps = fakeDeps({ fileExists: (p: string) => p.endsWith("abmind-daemon.js") || p.endsWith("abmind.plist") ? true : false });
    installLaunchAgent(deps);
    expect(deps.mkdirp).toHaveBeenCalledWith(
      expect.stringContaining("LaunchAgents"),
    );
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

describe("startLaunchAgent", () => {
  it("boots out existing job then bootstraps and probes health", async () => {
    const cmd = vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" }));
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ state: "ready" }));
    const delay = vi.fn(async () => {});
    const now = vi.fn(() => Date.now());

    const deps = fakeDeps({ command: cmd, probeHealth: probe, delay, now });
    const result = await startLaunchAgent(deps);

    expect(result.ok).toBe(true);
    expect(cmd).toHaveBeenNthCalledWith(1, "launchctl", ["bootout", "gui/501/abmind"]);
    expect(cmd).toHaveBeenNthCalledWith(2, "launchctl", ["bootstrap", "gui/501", expect.stringContaining("abmind.plist")]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled(); // first probe succeeded
  });

  it("stops an unsupervised orphaned daemon before booting out the launchd job", async () => {
    const terminateProcess = vi.fn();
    let alive = true;
    const isProcessAlive = vi.fn(() => alive);
    const readOwnerLease = vi.fn(() => ({ pid: 424242 }));
    const delay = vi.fn(async () => { alive = false; });

    const deps = fakeDeps({ readOwnerLease, isProcessAlive, terminateProcess, delay });
    const result = await startLaunchAgent(deps);

    expect(result.ok).toBe(true);
    expect(readOwnerLease).toHaveBeenCalled();
    expect(terminateProcess).toHaveBeenCalledWith(424242, "SIGTERM");
  });

  it("does nothing when no lease is held (no orphan)", async () => {
    const terminateProcess = vi.fn();
    const deps = fakeDeps({ readOwnerLease: () => null, terminateProcess });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(true);
    expect(terminateProcess).not.toHaveBeenCalled();
  });

  it("does nothing when the leased pid is already dead (stale lease)", async () => {
    const terminateProcess = vi.fn();
    const deps = fakeDeps({ readOwnerLease: () => ({ pid: 1 }), isProcessAlive: () => false, terminateProcess });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(true);
    expect(terminateProcess).not.toHaveBeenCalled();
  });

  it("fails with an actionable error if the orphan never exits", async () => {
    const now = vi.fn()
      .mockReturnValueOnce(1000)                                  // deadline computed
      .mockReturnValueOnce(1000)                                  // first loop check
      .mockReturnValueOnce(1000 + ORPHAN_STOP_TIMEOUT_MS + 1);     // second loop check — exits
    const deps = fakeDeps({
      readOwnerLease: () => ({ pid: 999 }),
      isProcessAlive: () => true, // never dies
      now,
    });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("999");
    expect(result.error).toContain("did not exit");
    expect(result.error).toContain("kill 999");
  });

  it("returns error if daemon entry missing", async () => {
    const deps = fakeDeps({ fileExists: (p: string) => !p.endsWith("abmind-daemon.js") });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("service install");
  });

  it("returns error if plist missing", async () => {
    const deps = fakeDeps({ fileExists: (p: string) => !p.endsWith("abmind.plist") });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("service install");
  });

  it("returns bootout error on non-zero, non-absent bootout", async () => {
    const cmd = vi.fn((): CommandResult => ({ status: 1, stdout: "", stderr: "Operation not permitted" }));
    const deps = fakeDeps({ command: cmd });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bootout failed");
    // bootstrap should NOT have been called
    expect(cmd).toHaveBeenCalledTimes(1);
  });

  it("continues on absent bootout error (loaded or not)", async () => {
    let callCount = 0;
    const cmd = vi.fn((_name: string, args: readonly string[]) => {
      callCount++;
      if (callCount === 1) {
        return { status: 1, stdout: "", stderr: "Could not find service" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(true);
    expect(cmd).toHaveBeenCalledTimes(2);
  });

  it("returns launchctl error on non-zero bootstrap", async () => {
    let callCount = 0;
    const cmd = vi.fn((_name: string, _args: readonly string[]) => {
      callCount++;
      // bootout succeeds, bootstrap fails
      if (callCount === 2) return { status: 1, stdout: "", stderr: "bootstrap error" };
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("launchctl bootstrap failed");
  });

  it("retries a transient exit-5 Input/output error on bootstrap and succeeds", async () => {
    let bootstrapCalls = 0;
    const cmd = vi.fn((_name: string, args: readonly string[]) => {
      if (args[0] === "bootstrap") {
        bootstrapCalls++;
        if (bootstrapCalls < 2) return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" }; // bootout
    });
    const delay = vi.fn(async () => {});
    const deps = fakeDeps({ command: cmd, delay });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(true);
    expect(bootstrapCalls).toBe(2);
    expect(delay).toHaveBeenCalledWith(BOOTSTRAP_RETRY_DELAY_MS);
  });

  it("gives up after BOOTSTRAP_RETRY_ATTEMPTS on persistent exit-5 errors", async () => {
    let bootstrapCalls = 0;
    const cmd = vi.fn((_name: string, args: readonly string[]) => {
      if (args[0] === "bootstrap") {
        bootstrapCalls++;
        return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd, delay: vi.fn(async () => {}) });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("launchctl bootstrap failed (exit 5)");
    expect(bootstrapCalls).toBe(BOOTSTRAP_RETRY_ATTEMPTS + 1);
  });

  it("does not retry a non-transient bootstrap error even with exit 5", async () => {
    let bootstrapCalls = 0;
    const cmd = vi.fn((_name: string, args: readonly string[]) => {
      if (args[0] === "bootstrap") {
        bootstrapCalls++;
        return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Some other reason" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    expect(bootstrapCalls).toBe(1);
  });

  it("does not retry a non-exit-5 bootstrap error", async () => {
    let bootstrapCalls = 0;
    const cmd = vi.fn((_name: string, args: readonly string[]) => {
      if (args[0] === "bootstrap") {
        bootstrapCalls++;
        return { status: 1, stdout: "", stderr: "Operation not permitted" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    expect(bootstrapCalls).toBe(1);
  });

  it("retries unavailable probe until ready", async () => {
    const probe = vi.fn()
      .mockResolvedValueOnce({ state: "unavailable", detail: "not yet" } as HealthProbeResult)
      .mockResolvedValueOnce({ state: "unavailable", detail: "still not" } as HealthProbeResult)
      .mockResolvedValueOnce({ state: "ready" } as HealthProbeResult);
    const start = 1000;
    const now = vi.fn()
      .mockReturnValueOnce(start)
      .mockReturnValueOnce(start + PROBE_INTERVAL_MS)
      .mockReturnValueOnce(start + 2 * PROBE_INTERVAL_MS)
      .mockReturnValueOnce(start + 3 * PROBE_INTERVAL_MS);
    const delay = vi.fn(async () => {});
    const deps = fakeDeps({ probeHealth: probe, now, delay });

    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(true);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });

  it("fails on terminal probe result", async () => {
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ state: "terminal", detail: "Protocol mismatch" }));
    const deps = fakeDeps({ probeHealth: probe });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Protocol mismatch");
    expect(result.error).toContain("launchctl print");
  });

  it("times out if daemon never becomes ready", async () => {
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ state: "unavailable", detail: "connection refused" }));
    const start = 1000;
    const now = vi.fn()
      .mockReturnValueOnce(start)                           // deadline
      .mockReturnValueOnce(start)                           // first loop check — enters loop
      .mockReturnValueOnce(start + PROBE_DEADLINE_MS + 1);  // second loop check — exits
    const delay = vi.fn(async () => {});
    const deps = fakeDeps({ probeHealth: probe, now, delay });

    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("did not become ready");
    expect(result.error).toContain("connection refused");
  });

});

// ── Restart ──────────────────────────────────────────────────────────────────

describe("restartLaunchAgent", () => {
  it("delegates to start (bootout + bootstrap + probe), no duplicate bootout", async () => {
    const cmd = vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" }));
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ state: "ready" }));
    const deps = fakeDeps({ command: cmd, probeHealth: probe });

    const result = await restartLaunchAgent(deps);

    expect(result.ok).toBe(true);
    // Exactly one bootout, not two
    expect(cmd).toHaveBeenNthCalledWith(1, "launchctl", ["bootout", "gui/501/abmind"]);
    expect(cmd).toHaveBeenNthCalledWith(2, "launchctl", ["bootstrap", "gui/501", expect.stringContaining("abmind.plist")]);
    expect(cmd).toHaveBeenCalledTimes(2);
  });

  it("continues if bootout reports absent service (Could not find service)", async () => {
    let callCount = 0;
    const cmd = vi.fn((_name: string, args: readonly string[]) => {
      callCount++;
      if (callCount === 1) {
        return { status: 1, stdout: "", stderr: "Could not find service" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });

    const result = await restartLaunchAgent(deps);
    expect(result.ok).toBe(true);
  });

  it("continues if bootout reports absent service (Operation now in progress)", async () => {
    let callCount = 0;
    const cmd = vi.fn((_name: string, args: readonly string[]) => {
      callCount++;
      if (callCount === 1) {
        return { status: 1, stdout: "", stderr: "Boot-out failed: 36: Operation now in progress" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });

    const result = await restartLaunchAgent(deps);
    expect(result.ok).toBe(true);
  });

  it("fails on non-absent bootout error", async () => {
    const cmd = vi.fn((_name: string, _args: readonly string[]) => {
      return { status: 1, stdout: "", stderr: "Operation not permitted" };
    });
    const deps = fakeDeps({ command: cmd });

    const result = await restartLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bootout failed");
  });
});

// ── Stop ─────────────────────────────────────────────────────────────────────

describe("stopLaunchAgent", () => {
  it("runs launchctl bootout and returns result", () => {
    const cmd = vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" }));
    const deps = fakeDeps({ command: cmd });

    const result = stopLaunchAgent(deps);
    expect(result.status).toBe(0);
    expect(cmd).toHaveBeenCalledWith("launchctl", ["bootout", "gui/501/abmind"]);
  });
});

describe("stopLaunchAgentSafe", () => {
  it("returns ok on successful bootout", () => {
    const cmd = vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" }));
    const deps = fakeDeps({ command: cmd });

    const result = stopLaunchAgentSafe(deps);
    expect(result).toEqual({ ok: true });
  });

  it("returns ok on absent job (idempotent)", () => {
    const cmd = vi.fn((): CommandResult => ({ status: 1, stdout: "", stderr: "Boot-out failed: 36: Operation now in progress" }));
    const deps = fakeDeps({ command: cmd });

    const result = stopLaunchAgentSafe(deps);
    expect(result).toEqual({ ok: true });
  });

  it("fails on non-absent bootout error", () => {
    const cmd = vi.fn((): CommandResult => ({ status: 1, stdout: "", stderr: "Operation not permitted" }));
    const deps = fakeDeps({ command: cmd });

    const result = stopLaunchAgentSafe(deps);
    expect(result).toEqual({ ok: false, error: expect.stringContaining("bootout failed") });
  });
});

// ── Status ──────────────────────────────────────────────────────────────────

describe("statusLaunchAgent", () => {
  it("runs launchctl print", () => {
    const cmd = vi.fn((): CommandResult => ({ status: 0, stdout: "active\n", stderr: "" }));
    const deps = fakeDeps({ command: cmd });

    const result = statusLaunchAgent(deps);
    expect(result.stdout).toBe("active\n");
    expect(cmd).toHaveBeenCalledWith("launchctl", ["print", "gui/501/abmind"]);
  });
});

// ── isAbsentBootoutError ───────────────────────────────────────────────

// ── stopOrphanedDaemon ─────────────────────────────────────────────────

describe("stopOrphanedDaemon", () => {
  it("allows the shared daemon shutdown budget, not the former five-second default (#1701)", () => {
    expect(ORPHAN_STOP_TIMEOUT_MS).toBe(DAEMON_SHUTDOWN_BUDGET_MS);
    expect(ORPHAN_STOP_TIMEOUT_MS).toBeGreaterThan(5_000);
  });

  it("returns no-lease when nothing is recorded", async () => {
    const deps = fakeDeps({ readOwnerLease: () => null });
    const result = await stopOrphanedDaemon(deps);
    expect(result).toEqual({ stopped: false, reason: "no-lease" });
  });

  it("returns not-live when the leased pid is already dead", async () => {
    const deps = fakeDeps({ readOwnerLease: () => ({ pid: 5 }), isProcessAlive: () => false });
    const result = await stopOrphanedDaemon(deps);
    expect(result).toEqual({ stopped: false, reason: "not-live" });
  });

  it("terminates the exact leased pid only, never a broad match", async () => {
    const terminateProcess = vi.fn();
    let alive = true;
    const deps = fakeDeps({
      readOwnerLease: () => ({ pid: 777 }),
      isProcessAlive: () => alive,
      terminateProcess,
      delay: async () => { alive = false; },
    });
    const result = await stopOrphanedDaemon(deps);
    expect(result).toEqual({ stopped: true, pid: 777 });
    expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(777, "SIGTERM");
  });

  it("polls at ORPHAN_STOP_POLL_MS and stops within the bounded deadline", async () => {
    const delay = vi.fn(async () => {});
    let checks = 0;
    const deps = fakeDeps({
      readOwnerLease: () => ({ pid: 42 }),
      isProcessAlive: () => { checks++; return checks < 3; }, // dies on 3rd check
      delay,
    });
    const result = await stopOrphanedDaemon(deps);
    expect(result).toEqual({ stopped: true, pid: 42 });
    expect(delay).toHaveBeenCalledWith(ORPHAN_STOP_POLL_MS);
  });

  it("gives up without escalating to SIGKILL when the process never exits", async () => {
    const terminateProcess = vi.fn();
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(ORPHAN_STOP_TIMEOUT_MS + 1);
    const deps = fakeDeps({
      readOwnerLease: () => ({ pid: 9 }),
      isProcessAlive: () => true,
      terminateProcess,
      now,
    });
    const result = await stopOrphanedDaemon(deps);
    expect(result).toEqual({ stopped: false, reason: "timeout", pid: 9 });
    expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(9, "SIGTERM");
    expect(terminateProcess).not.toHaveBeenCalledWith(9, "SIGKILL");
  });
});

describe("isTransientBootstrapError", () => {
  it("returns true for exit 5 with Input/output error", () => {
    expect(isTransientBootstrapError(5, "Bootstrap failed: 5: Input/output error")).toBe(true);
  });
  it("returns false for exit 5 with a different message", () => {
    expect(isTransientBootstrapError(5, "Bootstrap failed: 5: Some other reason")).toBe(false);
  });
  it("returns false for a different exit code with the same message text", () => {
    expect(isTransientBootstrapError(1, "Input/output error")).toBe(false);
  });
  it("returns false for permission errors", () => {
    expect(isTransientBootstrapError(1, "Operation not permitted")).toBe(false);
  });
});

describe("isAbsentBootoutError", () => {
  it("returns true for 'Could not find service'", () => {
    expect(isAbsentBootoutError("Could not find service \"abmind\" in domain for user 501")).toBe(true);
  });

  it("returns true for 'No such process'", () => {
    expect(isAbsentBootoutError("Boot-out failed: 3: No such process")).toBe(true);
  });

  it("returns true for 'Operation now in progress' (macOS Ventura+)", () => {
    expect(isAbsentBootoutError("Boot-out failed: 36: Operation now in progress")).toBe(true);
  });

  it("returns false for other errors", () => {
    expect(isAbsentBootoutError("Boot-out failed: 1: Operation not permitted")).toBe(false);
    expect(isAbsentBootoutError("")).toBe(false);
  });
});

// ── createHealthProbe ─────────────────────────────────────────────────────

describe("createHealthProbe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalTransportCtor.mockReturnValue({ close: mockClose });
    mockAbmindClientCtor.mockReturnValue({
      system: {
        negotiate: mockNegotiate,
        health: mockHealth,
        status: mockStatus,
      },
    });
  });

  it("returns ready and closes transport when negotiate + health succeed", async () => {
    mockNegotiate.mockResolvedValue({ methods: ["system.health"] });
    mockHealth.mockResolvedValue({ status: "healthy", memoryEnabled: true });

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toEqual({ state: "ready" });
    expect(mockLocalTransportCtor).toHaveBeenCalledWith("/tmp/abmind.sock");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable and closes transport on connection error", async () => {
    mockNegotiate.mockRejectedValue(new Error("Could not connect to daemon — ECONNREFUSED"));

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toEqual({ state: "unavailable", detail: expect.stringContaining("ECONNREFUSED") });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable on ENOENT socket", async () => {
    mockNegotiate.mockRejectedValue(new Error("ENOENT: no such file or directory"));

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toMatchObject({ state: "unavailable" });
    expect((result as any).detail).toContain("ENOENT");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns terminal and closes transport on protocol negotiation failure", async () => {
    mockNegotiate.mockRejectedValue(new Error("Unauthorized: invalid key"));

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toEqual({ state: "terminal", detail: expect.stringContaining("Unauthorized") });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns terminal when daemon lacks system.health method", async () => {
    mockNegotiate.mockResolvedValue({ methods: ["system.negotiate"] });

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toEqual({ state: "terminal", detail: expect.stringContaining("system.health") });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable and closes transport when health status is not healthy", async () => {
    mockNegotiate.mockResolvedValue({ methods: ["system.health"] });
    mockHealth.mockResolvedValue({ status: "degraded", memoryEnabled: true });

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toEqual({ state: "unavailable", detail: expect.stringContaining("degraded") });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable and closes transport when memory not enabled", async () => {
    mockNegotiate.mockResolvedValue({ methods: ["system.health"] });
    mockHealth.mockResolvedValue({ status: "healthy", memoryEnabled: false });

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toMatchObject({ state: "unavailable" });
    expect((result as any).detail).toContain("memory not enabled");
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("returns terminal and closes transport on health check crash", async () => {
    mockNegotiate.mockResolvedValue({ methods: ["system.health"] });
    mockHealth.mockRejectedValue(new Error("Internal server error"));

    const probe = createHealthProbe("/tmp/abmind.sock");
    const result = await probe();

    expect(result).toEqual({ state: "terminal", detail: expect.stringContaining("Internal server error") });
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("accepts a matching version, build, and release identity", async () => {
    mockNegotiate.mockResolvedValue({ methods: ["system.health"] });
    mockHealth.mockResolvedValue({ status: "healthy", memoryEnabled: true });
    mockStatus.mockResolvedValue({ version: "0.3.1", buildCommit: "abc123", releaseId: "0.3.1-stable-abc123" });

    const probe = createHealthProbe("/tmp/abmind.sock", {
      version: "0.3.1",
      buildCommit: "abc123",
      releaseId: "0.3.1-stable-abc123",
    });

    await expect(probe()).resolves.toEqual({ state: "ready" });
  });

  it("rejects a healthy daemon with the wrong build identity", async () => {
    mockNegotiate.mockResolvedValue({ methods: ["system.health"] });
    mockHealth.mockResolvedValue({ status: "healthy", memoryEnabled: true });
    mockStatus.mockResolvedValue({ version: "0.3.1", buildCommit: "old-build", releaseId: "0.3.1-stable-old" });

    const probe = createHealthProbe("/tmp/abmind.sock", {
      version: "0.3.1",
      buildCommit: "new-build",
      releaseId: "0.3.1-stable-new",
    });

    await expect(probe()).resolves.toMatchObject({
      state: "terminal",
      detail: expect.stringContaining("identity mismatch"),
    });
  });
});
