import { describe, expect, it, vi, beforeEach } from "vitest";
import { spawnSync } from "node:child_process";
import { darwinDeps } from "./abmind-service-reconciler.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const mockedSpawnSync = vi.mocked(spawnSync);

describe("darwinDeps command wrapper", () => {
  beforeEach(() => {
    mockedSpawnSync.mockClear();
  });

  it("spawns launchctl with fully piped stdio so raw stderr never reaches the terminal", () => {
    mockedSpawnSync.mockReturnValue({
      status: 5,
      stdout: "",
      stderr: "Bootstrap failed: 5: Input/output error\nTry re-running the command as root for richer errors.\n",
      signal: null,
      pid: 1,
      error: undefined,
    } as never);

    const deps = darwinDeps({ version: "", commit: null, releaseId: "" });
    const result = deps.command("launchctl", ["bootstrap", "gui/501", "/tmp/abmind.plist"]);

    expect(mockedSpawnSync).toHaveBeenCalledWith(
      "launchctl",
      ["bootstrap", "gui/501", "/tmp/abmind.plist"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
    expect(result.status).toBe(5);
    expect(result.stderr).toContain("Input/output error");
  });

  it("captures stderr instead of forwarding it to the parent process", () => {
    mockedSpawnSync.mockReturnValue({
      status: 5,
      stdout: "",
      stderr: "Bootstrap failed: 5: Input/output error\n",
      signal: null,
      pid: 1,
      error: undefined,
    } as never);

    const deps = darwinDeps({ version: "", commit: null, releaseId: "" });
    const result = deps.command("launchctl", ["bootstrap", "gui/501", "/tmp/abmind.plist"]);

    expect(result.stderr).toContain("Input/output error");
    expect(mockedSpawnSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.not.objectContaining({ stdio: "inherit" }),
    );
  });
});
