// #210 — .env.memory is sourced by loadMemoryConfig when CLI spawned standalone.
// Observable signal: loadMemoryConfig().memoryDir points at the MEMORY_DIR set
// in .env.memory, not the default.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Inline script that loads memory config and prints the resolved memoryDir.
const PROBE_SCRIPT = resolve(__dirname, "../dist/src/memory-config.js");

describe("abmind CLI sources .env.memory (#210)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "env-sourcing-test-"));
    mkdirSync(join(tmpDir, "config"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("abmind memory-stats uses MEMORY_DIR from .env.memory", () => {
    const customDir = join(tmpDir, "custom-memory");
    writeFileSync(join(tmpDir, "config", ".env.memory"), `MEMORY_DIR=${customDir}\n`);

    // Do NOT pass MEMORY_DIR in env — the file must be the only source.
    const env = { ...process.env, ABMIND_HOME: tmpDir };
    delete env["MEMORY_DIR"];

    // Use a one-liner that imports loadMemoryConfig and prints memoryDir
    const result = spawnSync("node", [
      "--input-type=module",
      "-e",
      `import { loadMemoryConfig } from "${PROBE_SCRIPT}"; console.log(loadMemoryConfig().memoryDir);`,
    ], { env, encoding: "utf8" });

    expect(result.status).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain(customDir);
  });
});
