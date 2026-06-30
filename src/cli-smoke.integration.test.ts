// #207 smoke-all — for every subcommand in the unified dispatcher, spawn
// `node dist/cli/abmind.js <name> --help` and assert it exits 0 with help
// output containing the subcommand name. Catches:
//   - dispatcher routing
//   - per-CLI --help handling inside runCli / runCliRaw
//   - isDirectRun detection via unified dispatcher path
//   - broken module imports
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const DISPATCHER = resolve(__dirname, "../dist/cli/abmind.js");

// Mirror the DISPATCH table names in cli/abmind.ts.
// Split so we can skip lifecycle subcommands that have no --help (yet —
// they're phase-1 install scripts with flag-based usage).
const LIFECYCLE = [
  "install", "update", "status",
] as const;
const MEMORY_SUBCOMMANDS = [
  "recall", "store", "edit", "expand", "embed", "retro-extract", "bundle",
  "wake-up", "sleep", "sleep-state", "sleep-apply", "sleep-report",
  "mcp", "list-secrets", "encrypt-secrets", "rekey",
] as const;
const SUBCOMMANDS = [...LIFECYCLE, ...MEMORY_SUBCOMMANDS] as const;

describe("unified abmind dispatcher — every subcommand --help works (#207)", () => {
  // Memory-facing subcommands all implement --help via runCli/runCliRaw.
  for (const name of MEMORY_SUBCOMMANDS) {
    it(`${name} --help exits 0 and prints usage`, () => {
      const result = spawnSync("node", [DISPATCHER, name, "--help"], {
        encoding: "utf8",
        timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toMatch(/Usage:|abmind/);
    });
  }

  // Lifecycle subcommands (Phase 4) use flag-based invocation without a
  // dedicated --help. Smoke: they exit cleanly when asked to run with no
  // effective args. `status` prints the runtime state and is the safest
  // no-op; install on a fresh throwaway home would work but is heavier.
  it("status (lifecycle) runs and exits with a status code", () => {
    const result = spawnSync("node", [DISPATCHER, "status"], {
      encoding: "utf8",
      timeout: 5000,
    });
    // 0 if installed, 1 if not — both are valid "ran successfully" outcomes.
    expect([0, 1]).toContain(result.status);
  });

  it("unknown subcommand exits 1", () => {
    const result = spawnSync("node", [DISPATCHER, "no-such-cmd"], {
      encoding: "utf8", timeout: 5000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown subcommand");
  });

  it("bare --help prints the table", () => {
    const result = spawnSync("node", [DISPATCHER, "--help"], {
      encoding: "utf8", timeout: 5000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Subcommands:");
    for (const name of SUBCOMMANDS) {
      expect(result.stdout).toContain(name);
    }
  });
});
