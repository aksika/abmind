import { describe, expect, it } from "vitest";
import {
  CANONICAL_SERVICE_NAME,
  LEGACY_SERVICE_NAME,
  LEGACY_UNIT_PATH,
  MANAGED_MARKER,
  planUnitReconciliation,
  renderUnitContent,
  resolveDaemonEntryPath,
  quoteSystemdValue,
  isManagedUnit,
  isKnownGeneratedUnit,
  ensureDaemonService,
  type DaemonServiceDeps,
  type EnsureDaemonServiceOptions,
  type CommandResult,
} from "./abmind-daemon-service.js";

function fakeDeps(overrides?: Partial<DaemonServiceDeps>): DaemonServiceDeps {
  const files = new Map<string, string>();
  return {
    platform: "linux",
    userName: "testuser",
    uid: 1000,
    nodeExecutable: "/usr/bin/node",
    abmindHomeOverride: "/home/testuser/.abmind",
    publicModuleLink: "/home/testuser/.local/lib/node_modules/abmind",
    fallbackDaemonEntry: "/home/testuser/.abmind/packages/standalone/current/dist/cli/abmind-daemon.js",
    readFile: (p: string) => files.get(p) ?? null,
    writeFileAtomic: (p: string, content: string, _mode: number) => { files.set(p, content); },
    moveFile: (from: string, to: string) => {
      const c = files.get(from);
      if (c !== undefined) { files.set(to, c); files.delete(from); }
    },
    command: (name: string, _args: readonly string[]) => {
      // loginctl show-user Linger returns "yes" for linger enabled
      if (name === "loginctl") return { status: 0, stdout: "yes\n", stderr: "" };
      return { status: 0, stdout: "active\n", stderr: "" };
    },
    canonicalUnitPath: `/home/testuser/.config/systemd/user/${CANONICAL_SERVICE_NAME}.service`,
    ...overrides,
  };
}

describe("quoteSystemdValue", () => {
  it("passes through simple values", () => {
    expect(quoteSystemdValue("/usr/bin/node")).toBe("/usr/bin/node");
    expect(quoteSystemdValue("node")).toBe("node");
  });
  it("double-quotes values with spaces", () => {
    expect(quoteSystemdValue("/usr/bin/node with spaces")).toBe('"/usr/bin/node with spaces"');
  });
  it("throws on control characters", () => {
    expect(() => quoteSystemdValue("/usr/bin/node\n")).toThrow("control character");
    expect(() => quoteSystemdValue("/usr/bin/node\r")).toThrow("control character");
    expect(() => quoteSystemdValue("/usr/bin/node\0")).toThrow("control character");
  });
});

describe("renderUnitContent", () => {
  it("renders a valid unit with managed marker and direct daemon entry", () => {
    const content = renderUnitContent({
      nodeExecutable: "/usr/bin/node",
      daemonEntryPath: "/some/path/dist/cli/abmind-daemon.js",
      abmindHome: "/home/user/.abmind",
    });
    expect(content).toContain(MANAGED_MARKER);
    expect(content).toContain("ExecStart=/usr/bin/node /some/path/dist/cli/abmind-daemon.js --wait-for-owner");
    expect(content).not.toContain("abmind.js");
    expect(content).toContain("Environment=ABMIND_HOME=/home/user/.abmind");
    expect(content).toContain("UMask=0077");
    expect(content).toContain("Restart=on-failure");
    expect(content).toContain("RestartSec=5");
    expect(content).toContain("WantedBy=default.target");
    expect(content).toContain("After=network-online.target");
  });
  it("quotes paths with spaces", () => {
    const content = renderUnitContent({
      nodeExecutable: "/usr/local/bin/node",
      daemonEntryPath: "/home/user/my abmind/dist/cli/abmind-daemon.js",
      abmindHome: "/home/user/.abmind",
    });
    expect(content).toContain('ExecStart=/usr/local/bin/node "/home/user/my abmind/dist/cli/abmind-daemon.js" --wait-for-owner');
  });
});

describe("resolveDaemonEntryPath", () => {
  it("prefers public module link when it exists", () => {
    const r = resolveDaemonEntryPath("/home/user/.local/lib/node_modules/abmind", "/fallback", () => true);
    expect(r).toBe("/home/user/.local/lib/node_modules/abmind/dist/cli/abmind-daemon.js");
  });
  it("falls back when public module link does not exist", () => {
    const r = resolveDaemonEntryPath("/home/user/.local/lib/node_modules/abmind", "/fallback", () => false);
    expect(r).toBe("/fallback");
  });
  it("never resolves abmind.js (dispatcher removed)", () => {
    const r = resolveDaemonEntryPath("/home/user/.local/lib/node_modules/abmind", "/fallback", () => true);
    expect(r).not.toContain("abmind.js");
  });
});

describe("isManagedUnit", () => {
  it("detects managed marker", () => {
    expect(isManagedUnit("# Managed by abmind (#1453)")).toBe(true);
    expect(isManagedUnit("some other content")).toBe(false);
  });
});

describe("isKnownGeneratedUnit", () => {
  it("detects known units by description", () => {
    expect(isKnownGeneratedUnit("Description=abmind memory daemon")).toBe(true);
    expect(isKnownGeneratedUnit("Description=Abmind memory daemon")).toBe(true);
    expect(isKnownGeneratedUnit("Description=something else")).toBe(false);
  });
});

describe("planUnitReconciliation", () => {
  it("plans write-new when no unit exists", () => {
    const plan = planUnitReconciliation(fakeDeps());
    expect(plan.action.kind).toBe("write-new");
  });

  it("plans noop when managed unit is unchanged", () => {
    const deps = fakeDeps();
    const content = renderUnitContent({
      nodeExecutable: deps.nodeExecutable,
      daemonEntryPath: resolveDaemonEntryPath(deps.publicModuleLink, deps.fallbackDaemonEntry),
      abmindHome: deps.abmindHomeOverride ?? "/home/testuser/.abmind",
    });
    deps.readFile = (p: string) => p === deps.canonicalUnitPath ? content : null;
    const plan = planUnitReconciliation(deps);
    expect(plan.action.kind).toBe("noop");
  });

  it("plans overwrite when managed unit content changed", () => {
    const deps = fakeDeps();
    const oldContent = renderUnitContent({
      nodeExecutable: "/old/node",
      daemonEntryPath: "/old/path/dist/cli/abmind-daemon.js",
      abmindHome: "/home/testuser/.abmind",
    });
    deps.readFile = (p: string) => p === deps.canonicalUnitPath ? oldContent : null;
    const plan = planUnitReconciliation(deps);
    expect(plan.action.kind).toBe("overwrite");
  });

  it("plans migrate-legacy when known legacy unit exists", () => {
    const deps = fakeDeps();
    const legacyContent = `[Unit]\nDescription=abmind memory daemon\nExecStart=/usr/bin/node /some/path daemon`;
    deps.readFile = (p: string) => p === LEGACY_UNIT_PATH ? legacyContent : null;
    const plan = planUnitReconciliation(deps);
    expect(plan.action.kind).toBe("migrate-legacy");
  });

  it("plans conflict when unrecognized legacy unit exists", () => {
    const deps = fakeDeps();
    deps.readFile = (p: string) =>
      p === LEGACY_UNIT_PATH ? "[Unit]\nDescription=something custom" : null;
    const plan = planUnitReconciliation(deps);
    expect(plan.action.kind).toBe("conflict");
  });
});

describe("ensureDaemonService", () => {
  const defaultOpts: EnsureDaemonServiceOptions = { dryRun: false, releaseChanged: false, start: true };

  it("returns unsupported on non-linux platform", () => {
    const deps = fakeDeps({ platform: "darwin" });
    const result = ensureDaemonService(deps, defaultOpts);
    expect(result.state).toBe("unsupported");
  });

  it("returns unsupported when systemctl is not available", () => {
    const deps = fakeDeps({ command: () => ({ status: 1, stdout: "", stderr: "not found" }) });
    const result = ensureDaemonService(deps, defaultOpts);
    expect(result.state).toBe("unsupported");
  });

  it("returns ready with started action on fresh install", () => {
    const deps = fakeDeps();
    const result = ensureDaemonService(deps, defaultOpts);
    expect(result.state).toBe("ready");
    expect(result.unitChanged).toBe(true);
  });

  it("returns ready with already-running on noop", () => {
    const deps = fakeDeps();
    const content = renderUnitContent({
      nodeExecutable: deps.nodeExecutable,
      daemonEntryPath: resolveDaemonEntryPath(deps.publicModuleLink, deps.fallbackDaemonEntry),
      abmindHome: deps.abmindHomeOverride ?? "/home/testuser/.abmind",
    });
    deps.readFile = (p: string) => p === deps.canonicalUnitPath ? content : null;
    const result = ensureDaemonService(deps, defaultOpts);
    expect(result.state).toBe("ready");
    expect(result.unitChanged).toBe(false);
    expect(result.action).toBe("already-running");
  });

  it("restarts on changed release when active", () => {
    const deps = fakeDeps();
    const opts = { ...defaultOpts, releaseChanged: true };
    const result = ensureDaemonService(deps, opts);
    expect(result.state).toBe("ready");
    expect(result.action).toBe("restarted");
  });

  it("dry run does not write files", () => {
    let written = false;
    const deps = fakeDeps({
      writeFileAtomic: () => { written = true; },
      command: () => ({ status: 0, stdout: "inactive\n", stderr: "" }),
    });
    const result = ensureDaemonService(deps, { ...defaultOpts, dryRun: true });
    expect(result.state).toBe("ready");
    expect(written).toBe(false);
  });

  it("returns needs-linger when loginctl enable-linger fails", () => {
    let callCount = 0;
    const deps = fakeDeps({
      command: (_name: string, _args: readonly string[]) => {
        callCount++;
        // First calls succeed (systemctl), then loginctl show-user fails
        if (_name === "loginctl") return { status: 1, stdout: "", stderr: "not authorized" };
        return { status: 0, stdout: "inactive\n", stderr: "" };
      },
    });
    const result = ensureDaemonService(deps, defaultOpts);
    expect(result.state).toBe("needs-linger");
    if (result.state === "needs-linger") {
      expect(result.remediation).toContain("sudo loginctl");
      expect(result.serviceReady).toBe(true);
    }
  });
});
