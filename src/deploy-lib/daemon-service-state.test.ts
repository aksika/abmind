import { describe, expect, it } from "vitest";
import {
  describeDaemonServiceState,
  queryDaemonServiceState,
  type DaemonServiceQueryDeps,
} from "./daemon-service-state.js";

function queryFake(
  platform: NodeJS.Platform,
  outputs: Record<string, { status: number; stdout: string }>,
): DaemonServiceQueryDeps {
  return {
    platform,
    uid: 501,
    command: (name, args) => {
      const key = `${name} ${args.join(" ")}`;
      const out = outputs[key] ?? { status: 1, stdout: "" };
      return { ...out, stderr: "" };
    },
  };
}

describe("queryDaemonServiceState", () => {
  it("reports a running daemon with pid on darwin", () => {
    const deps = queryFake("darwin", {
      "launchctl list abmind": { status: 0, stdout: "PID\tStatus\tLabel\n1901\t0\tabmind" },
    });
    const state = queryDaemonServiceState(deps);
    expect(state).toMatchObject({ active: true, pid: 1901 });
    expect(describeDaemonServiceState(state)).toBe("running (pid 1901)");
  });

  it("reports running without pid when the supervisor names no pid", () => {
    const deps = queryFake("darwin", {
      "launchctl list abmind": { status: 0, stdout: "PID\tStatus\tLabel\n-\t0\tabmind" },
    });
    const state = queryDaemonServiceState(deps);
    expect(state).toMatchObject({ active: true, pid: null });
    expect(describeDaemonServiceState(state)).toBe("running");
  });

  it("reports stopped when the job is not loaded on darwin", () => {
    const state = queryDaemonServiceState(queryFake("darwin", {}));
    expect(state).toMatchObject({ active: false, pid: null });
    expect(describeDaemonServiceState(state)).toBe("stopped");
  });

  it("reports a running daemon with pid on linux", () => {
    const deps = queryFake("linux", {
      "systemctl --user is-active abmind-daemon": { status: 0, stdout: "active" },
      "systemctl --user show abmind-daemon -p MainPID --value": { status: 0, stdout: "1901" },
    });
    const state = queryDaemonServiceState(deps);
    expect(state).toMatchObject({ active: true, pid: 1901 });
    expect(describeDaemonServiceState(state)).toBe("running (pid 1901)");
  });

  it("reports stopped when the unit is inactive on linux", () => {
    const deps = queryFake("linux", {
      "systemctl --user is-active abmind-daemon": { status: 0, stdout: "inactive" },
    });
    const state = queryDaemonServiceState(deps);
    expect(state).toMatchObject({ active: false, pid: null });
    expect(describeDaemonServiceState(state)).toBe("stopped");
  });
});
