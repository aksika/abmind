import { describe, expect, it } from "vitest";
import {
  describeLayaServiceState,
  ensureLayaSidecar,
  isManagedSidecarContent,
  layaLaunchdPlistPath,
  layaPortFromUrl,
  layaSystemdUnitPath,
  layaVenvPython,
  parseLaunchctlListPid,
  queryLayaServiceState,
  renderLayaLaunchdPlist,
  renderLayaSystemdUnit,
  resolveLayaServerScript,
  LAYA_LAUNCHD_LABEL,
  LAYA_SYSTEMD_NAME,
  type LayaServiceQueryDeps,
  type LayaSidecarDeps,
} from "./laya-sidecar-service.js";
import type { LayaHealth } from "../judgment-provider.js";
import type { System1Config } from "../system1-config.js";

const LAYA_ON: System1Config = {
  state: "on", backend: "laya", url: "http://127.0.0.1:8765", endpoint: "127.0.0.1:8765",
  recallEnabled: true, fastpathEnabled: false, timeoutMs: 1500, maxCandidates: 20,
};

function ready(model = "convaiinnovations/laya"): LayaHealth {
  return { reachable: true, ready: true, model, contractVersion: 1, latencyMs: 5 };
}

function warming(): LayaHealth {
  return { reachable: true, ready: false, model: "", contractVersion: 0, latencyMs: 5, error: "warming" };
}

interface FakeState {
  files: Set<string>;
  written: Map<string, string>;
  commands: Array<{ name: string; args: readonly string[] }>;
  probes: LayaHealth[];
  probeCalls: number;
  clock: number;
  loaded: boolean;
}

function fake(overrides: Partial<FakeState> = {}): { deps: LayaSidecarDeps; state: FakeState } {
  const state: FakeState = {
    files: new Set([
      "/home/u/.laya-venv/bin/python",
      "/home/u/.abmind/src/abmind/scripts/laya-server.py",
    ]),
    written: new Map(),
    commands: [],
    probes: [ready()],
    probeCalls: 0,
    clock: 0,
    loaded: false,
    ...overrides,
  };
  const deps: LayaSidecarDeps = {
    platform: "darwin",
    homeDir: "/home/u",
    abmindHome: "/home/u/.abmind",
    fileExists: (p) => state.files.has(p),
    writeFile: (p, content) => { state.written.set(p, content); },
    mkdirp: () => {},
    command: (name, args) => {
      state.commands.push({ name, args });
      if (name === "launchctl" && args[0] === "print") {
        return state.loaded
          ? { status: 0, stdout: "loaded", stderr: "" }
          : { status: 1, stdout: "", stderr: "Could not find service" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    probeSidecar: async () => {
      state.probeCalls += 1;
      return state.probes[Math.min(state.probeCalls - 1, state.probes.length - 1)] ?? ready();
    },
    delay: async (ms) => { state.clock += ms; },
    now: () => state.clock,
  };
  return { deps, state };
}

describe("laya sidecar unit rendering", () => {
  it("renders a launchd plist with RunAtLoad + KeepAlive on loopback", () => {
    const plist = renderLayaLaunchdPlist({
      venvPython: "/home/u/.laya-venv/bin/python",
      serverScript: "/home/u/.abmind/src/abmind/scripts/laya-server.py",
      port: 8765,
    });
    expect(plist).toContain(LAYA_LAUNCHD_LABEL);
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("laya-server.py");
    expect(plist).toContain("<string>8765</string>");
    expect(plist).not.toContain("0.0.0.0");
  });

  it("renders a systemd unit with restart policy and managed marker", () => {
    const unit = renderLayaSystemdUnit({
      venvPython: "/home/u/.laya-venv/bin/python",
      serverScript: "/home/u/.abmind/src/abmind/scripts/laya-server.py",
      port: 8765,
    });
    expect(isManagedSidecarContent(unit)).toBe(true);
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("--port 8765");
  });

  it("resolves venv, script, paths, and ports", () => {
    expect(layaVenvPython("/home/u")).toBe("/home/u/.laya-venv/bin/python");
    expect(layaLaunchdPlistPath("/home/u")).toContain(LAYA_LAUNCHD_LABEL);
    expect(layaSystemdUnitPath("/home/u")).toContain(LAYA_SYSTEMD_NAME);
    expect(layaPortFromUrl("http://127.0.0.1:9999")).toBe(9999);
    expect(layaPortFromUrl("http://127.0.0.1:8765")).toBe(8765);
    expect(layaPortFromUrl("http://127.0.0.1/")).toBe(8765);
    const files = new Set(["/home/u/.abmind/src/abmind/scripts/laya-server.py"]);
    expect(resolveLayaServerScript("/home/u/.abmind", (p) => files.has(p))).toContain("laya-server.py");
    expect(resolveLayaServerScript("/home/u/.abmind", () => false)).toBeNull();
  });
});

describe("ensureLayaSidecar", () => {
  it("skips when the backend is not laya", async () => {
    const { deps } = fake();
    for (const sys1 of [
      { state: "off", recallRequested: false },
      { state: "on", backend: "jev", url: "https://api.typesafe.ai", endpoint: "api.typesafe.ai", model: "jev-1.13.0", keyPresent: true, recallEnabled: false, fastpathEnabled: false, timeoutMs: 1500, maxCandidates: 20 },
    ] as System1Config[]) {
      const result = await ensureLayaSidecar(deps, sys1);
      expect(result.state).toBe("skipped");
    }
  });

  it("degrades when the venv is missing (daemon must not block)", async () => {
    const { deps, state } = fake({ probes: [{ reachable: false, ready: false, model: "", contractVersion: 0, latencyMs: 1, error: "unreachable" }] });
    state.files.delete("/home/u/.laya-venv/bin/python");
    const result = await ensureLayaSidecar(deps, LAYA_ON);
    expect(result.state).toBe("degraded");
    expect(result.detail).toContain(".laya-venv");
    expect(state.commands.length).toBe(0);
  });

  it("respects an already-hot sidecar: writes the unit, bootstraps nothing", async () => {
    const { deps, state } = fake();
    const result = await ensureLayaSidecar(deps, LAYA_ON);
    expect(result.state).toBe("ready");
    expect(result.detail).toContain("already hot");
    expect(state.written.has(layaLaunchdPlistPath("/home/u"))).toBe(true);
    expect(state.commands.filter((c) => c.args[0] === "bootstrap").length).toBe(0);
  });

  it("starts the unit and waits through warming to ready", async () => {
    const { deps, state } = fake({ probes: [warming(), warming(), ready()] });
    const result = await ensureLayaSidecar(deps, LAYA_ON);
    expect(result.state).toBe("ready");
    expect(result.detail).toContain("convaiinnovations/laya");
    expect(state.commands.some((c) => c.args[0] === "bootstrap")).toBe(true);
    expect(state.probeCalls).toBe(3); // first probe + 2 polls
  });

  it("fails fast on contract mismatch instead of burning the deadline", async () => {
    const mismatch: LayaHealth = { reachable: true, ready: false, model: "x", contractVersion: 2, latencyMs: 1, error: "contract-mismatch" };
    const { deps, state } = fake({ probes: [{ reachable: false, ready: false, model: "", contractVersion: 0, latencyMs: 1, error: "unreachable" }, mismatch] });
    const result = await ensureLayaSidecar(deps, LAYA_ON);
    expect(result.state).toBe("degraded");
    expect(result.detail).toContain("contract-mismatch");
    expect(state.clock).toBe(0);
  });

  it("degrades after the deadline when warming never ends", async () => {
    const { deps, state } = fake({ probes: [warming()] });
    state.clock = 0;
    const result = await ensureLayaSidecar(deps, LAYA_ON);
    expect(result.state).toBe("degraded");
    expect(result.detail).toContain("not ready within");
    expect(state.clock).toBeGreaterThanOrEqual(180_000);
  });
});

describe("queryLayaServiceState", () => {
  function queryFake(outputs: Record<string, { status: number; stdout: string }>): LayaServiceQueryDeps {
    return {
      platform: "darwin",
      homeDir: "/home/u",
      fileExists: (p) => p.endsWith("ai.abmind.laya-sidecar.plist"),
      command: (name, args) => {
        const key = `${name} ${args.join(" ")}`;
        const out = outputs[key] ?? { status: 1, stdout: "" };
        return { ...out, stderr: "" };
      },
    };
  }

  it("parses launchctl list output including the not-running dash", () => {
    expect(parseLaunchctlListPid("PID\tStatus\tLabel\n34508\t0\tai.abmind.laya-sidecar")).toBe(34508);
    expect(parseLaunchctlListPid("PID\tStatus\tLabel\n-\t0\tai.abmind.laya-sidecar")).toBeNull();
    expect(parseLaunchctlListPid("{\n\t\"Label\" = \"ai.abmind.laya-sidecar\";\n\t\"PID\" = 34508;\n};")).toBe(34508);
    expect(parseLaunchctlListPid("")).toBeNull();
  });

  it("reports a loaded sidecar with pid", () => {
    const deps = queryFake({
      "launchctl list ai.abmind.laya-sidecar": { status: 0, stdout: "PID\tStatus\tLabel\n34508\t0\tai.abmind.laya-sidecar" },
    });
    const state = queryLayaServiceState(deps);
    expect(state).toMatchObject({ installed: true, active: true, pid: 34508 });
    expect(describeLayaServiceState(state)).toBe("loaded (pid 34508)");
  });

  it("reports installed-but-absent when the job is not loaded", () => {
    const deps = queryFake({});
    const state = queryLayaServiceState(deps);
    expect(state).toMatchObject({ installed: true, active: false, pid: null });
    expect(describeLayaServiceState(state)).toBe("installed, not loaded");
  });

  it("reports not installed when no unit file exists", () => {
    const deps = queryFake({});
    const noFile: LayaServiceQueryDeps = { ...deps, fileExists: () => false };
    const state = queryLayaServiceState(noFile);
    expect(describeLayaServiceState(state)).toBe("not installed");
  });
});
