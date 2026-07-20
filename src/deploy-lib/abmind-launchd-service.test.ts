import { describe, expect, it, vi, beforeEach } from "vitest";
import { join } from "node:path";
import {
  resolveLaunchdDispatcher,
  xmlEscape,
  renderLaunchdPlist,
  launchdPlistPath,
  installLaunchAgent,
  startLaunchAgent,
  restartLaunchAgent,
  stopLaunchAgent,
  stopLaunchAgentSafe,
  statusLaunchAgent,
  createHealthProbe,
  isAbsentBootoutError,
  PROBE_DEADLINE_MS,
  PROBE_INTERVAL_MS,
  type LaunchdServiceDeps,
  type CommandResult,
  type HealthProbeResult,
} from "./abmind-launchd-service.js";

// ── Mocks for createHealthProbe (dynamic imports of transport + client) ──

const mockClose = vi.fn();
const mockNegotiate = vi.fn();
const mockHealth = vi.fn();
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
    fileExists: () => true,
    writeFile: vi.fn(),
    mkdirp: vi.fn(),
    command: vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" })),
    probeHealth: vi.fn(async (): Promise<HealthProbeResult> => ({ state: "ready" })),
    delay: vi.fn(async () => {}),
    now: vi.fn(() => Date.now()),
    ...overrides,
  };
}

// ── Path resolution ──────────────────────────────────────────────────────────

describe("resolveLaunchdDispatcher", () => {
  it("resolves abmind.js as sibling of abmind-service.js (source build)", () => {
    const url = makeServiceModuleUrl("/Users/test/projects/abmind");
    const r = resolveLaunchdDispatcher(url);
    expect(r).toBe("/Users/test/projects/abmind/dist/cli/abmind.js");
  });

  it("never produces dist/dist path", () => {
    const url = makeServiceModuleUrl("/Users/test/projects/abmind");
    const r = resolveLaunchdDispatcher(url);
    expect(r).not.toContain("dist/dist");
  });

  it("works with standalone release layout", () => {
    const url = `file:///Users/testuser/.local/lib/node_modules/abmind/dist/cli/abmind-service.js`;
    const r = resolveLaunchdDispatcher(url);
    expect(r).toBe("/Users/testuser/.local/lib/node_modules/abmind/dist/cli/abmind.js");
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
  it("renders expected plist structure", () => {
    const plist = renderLaunchdPlist({
      dispatcherPath: "/Users/test/projects/abmind/dist/cli/abmind.js",
      abmindHome: "/Users/test/.abmind",
    });
    expect(plist).toContain('<!DOCTYPE plist');
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>abmind</string>');
    expect(plist).toContain('/Users/test/projects/abmind/dist/cli/abmind.js');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<key>ABMIND_HOME</key>');
    expect(plist).toContain('<string>/Users/test/.abmind</string>');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).toContain('<integer>10</integer>');
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<false/>');
  });

  it("escapes XML-special characters in paths", () => {
    const plist = renderLaunchdPlist({
      dispatcherPath: "/Users/test/My&App/abmind.js",
      abmindHome: "/Users/test/.abmind",
    });
    expect(plist).toContain("/Users/test/My&amp;App/abmind.js");
    expect(plist).not.toContain("/Users/test/My&App/abmind.js");
  });

  it("does not contain dist/dist path segment", () => {
    const plist = renderLaunchdPlist({
      dispatcherPath: "/Users/test/projects/abmind/dist/cli/abmind.js",
      abmindHome: "/Users/test/.abmind",
    });
    expect(plist).not.toContain("dist/dist");
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
  it("succeeds when dispatcher exists and writes plist", () => {
    const deps = fakeDeps();
    const result = installLaunchAgent(deps);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plistPath).toBe("/Users/testuser/Library/LaunchAgents/abmind.plist");
    expect(result.dispatcherPath).toBe("/Users/testuser/projects/abmind/dist/cli/abmind.js");
    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    const [path, , mode] = (deps.writeFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(path).toContain("LaunchAgents/abmind.plist");
    expect(mode).toBe(0o644);
  });

  it("fails when dispatcher does not exist", () => {
    const deps = fakeDeps({ fileExists: () => false });
    const result = installLaunchAgent(deps);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Dispatcher not found");
    expect(result.error).toContain("abmind.js");
  });

  it("creates LaunchAgents directory if missing", () => {
    const deps = fakeDeps({ fileExists: (p: string) => p.endsWith("abmind.js") || p.endsWith("abmind.plist") ? true : false });
    installLaunchAgent(deps);
    expect(deps.mkdirp).toHaveBeenCalledWith(
      expect.stringContaining("LaunchAgents"),
    );
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

describe("startLaunchAgent", () => {
  it("runs launchctl bootstrap and probes health", async () => {
    const cmd = vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" }));
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ state: "ready" }));
    const delay = vi.fn(async () => {});
    const now = vi.fn(() => Date.now());

    const deps = fakeDeps({ command: cmd, probeHealth: probe, delay, now });
    const result = await startLaunchAgent(deps);

    expect(result.ok).toBe(true);
    expect(cmd).toHaveBeenCalledWith("launchctl", ["bootstrap", "gui/501", expect.stringContaining("abmind.plist")]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled(); // first probe succeeded
  });

  it("returns error if dispatcher missing", async () => {
    const deps = fakeDeps({ fileExists: (p: string) => !p.endsWith("abmind.js") });
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

  it("returns launchctl error on non-zero bootstrap", async () => {
    const cmd = vi.fn((): CommandResult => ({ status: 1, stdout: "", stderr: "error" }));
    const deps = fakeDeps({ command: cmd });
    const result = await startLaunchAgent(deps);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("launchctl bootstrap failed");
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
  it("boots out old service then starts new one", async () => {
    const cmd = vi.fn((): CommandResult => ({ status: 0, stdout: "", stderr: "" }));
    const probe = vi.fn(async (): Promise<HealthProbeResult> => ({ state: "ready" }));
    const deps = fakeDeps({ command: cmd, probeHealth: probe });

    const result = await restartLaunchAgent(deps);

    expect(result.ok).toBe(true);
    expect(cmd).toHaveBeenNthCalledWith(1, "launchctl", ["bootout", "gui/501/abmind"]);
    expect(cmd).toHaveBeenNthCalledWith(2, "launchctl", ["bootstrap", "gui/501", expect.stringContaining("abmind.plist")]);
  });

  it("continues if bootout reports absent service (Could not find service)", async () => {
    const cmd = vi.fn((name: string, args: readonly string[]) => {
      if (args[0] === "bootout") {
        return { status: 1, stdout: "", stderr: "Could not find service" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });

    const result = await restartLaunchAgent(deps);
    expect(result.ok).toBe(true);
  });

  it("continues if bootout reports absent service (Operation now in progress)", async () => {
    const cmd = vi.fn((name: string, args: readonly string[]) => {
      if (args[0] === "bootout") {
        return { status: 1, stdout: "", stderr: "Boot-out failed: 36: Operation now in progress" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    const deps = fakeDeps({ command: cmd });

    const result = await restartLaunchAgent(deps);
    expect(result.ok).toBe(true);
  });

  it("fails on non-absent bootout error", async () => {
    const cmd = vi.fn((name: string, args: readonly string[]) => {
      if (args[0] === "bootout") {
        return { status: 1, stdout: "", stderr: "Operation not permitted" };
      }
      return { status: 0, stdout: "", stderr: "" };
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
});
