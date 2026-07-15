import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, chmodSync, rmSync, symlinkSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock spawnSync so tests never call real npm.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process");
  return { ...actual as object, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import { resolveAbmindBinPath, checkAbmindBinary, ensureAbmindExecutable } from "../cli/lib/ensure-cli-executable.js";

const TMP = join(tmpdir(), `abmind-test-ensure-${process.pid}`);

function mockNpmPrefix(stdout: string, status = 0, stderr = ""): void {
  (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({ stdout, stderr, status, pid: 0, output: [], signal: null });
}

describe("resolveAbmindBinPath", () => {
  it("returns <prefix>/bin/abmind when npm prefix succeeds", () => {
    mockNpmPrefix("/usr/local\n");
    expect(resolveAbmindBinPath()).toBe("/usr/local/bin/abmind");
  });

  it("throws when npm prefix fails", () => {
    mockNpmPrefix("", 1, "error");
    expect(() => resolveAbmindBinPath()).toThrow("npm prefix -g failed");
  });

  it("throws when npm prefix returns empty", () => {
    mockNpmPrefix("");
    expect(() => resolveAbmindBinPath()).toThrow("npm prefix -g returned empty output");
  });
});

describe("checkAbmindBinary", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    mockNpmPrefix(TMP + "\n");
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns exists=false when binary file is missing", () => {
    const r = checkAbmindBinary();
    expect(r.exists).toBe(false);
    expect(r.isExecutable).toBe(false);
    expect(r.message).toContain("not found");
  });

  it("returns exists=true, isExecutable=true when file exists and has +x", () => {
    const bin = join(TMP, "bin", "abmind");
    mkdirSync(join(TMP, "bin"), { recursive: true });
    writeFileSync(bin, "#!/usr/bin/env node\ntrue\n");
    chmodSync(bin, 0o755);
    const r = checkAbmindBinary();
    expect(r.exists).toBe(true);
    expect(r.isExecutable).toBe(true);
    expect(r.binPath).toBe(bin);
  });

  it("returns isExecutable=false when file lacks +x", () => {
    const bin = join(TMP, "bin", "abmind");
    mkdirSync(join(TMP, "bin"), { recursive: true });
    writeFileSync(bin, "#!/usr/bin/env node\ntrue\n");
    chmodSync(bin, 0o644);
    const r = checkAbmindBinary();
    expect(r.exists).toBe(true);
    expect(r.isExecutable).toBe(false);
    expect(r.message).toContain("not executable");
  });

  it("follows symlink to check target executability", () => {
    const binDir = join(TMP, "bin");
    const targetDir = join(TMP, "lib", "node_modules", "abmind");
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const target = join(targetDir, "abmind.js");
    writeFileSync(target, "#!/usr/bin/env node\ntrue\n");
    chmodSync(target, 0o755);
    symlinkSync(target, join(binDir, "abmind"));
    const r = checkAbmindBinary();
    expect(r.exists).toBe(true);
    expect(r.isExecutable).toBe(true);
  });

  it("reports missing symlink target", () => {
    const binDir = join(TMP, "bin");
    mkdirSync(binDir, { recursive: true });
    symlinkSync("/nonexistent/abmind", join(binDir, "abmind"));
    const r = checkAbmindBinary();
    expect(r.exists).toBe(true);
    expect(r.isExecutable).toBe(false);
    expect(r.message).toContain("missing");
  });

  it("returns non-fatal error status when npm prefix itself fails", () => {
    mockNpmPrefix("", 1, "npm ERR!");
    const r = checkAbmindBinary();
    expect(r.exists).toBe(false);
    expect(r.binPath).toBe("unknown");
  });
});

describe("ensureAbmindExecutable", () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
    mockNpmPrefix(TMP + "\n");
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("throws when binary is missing", () => {
    expect(() => ensureAbmindExecutable()).toThrow("not found");
  });

  it("succeeds when already executable (no-op)", () => {
    const bin = join(TMP, "bin", "abmind");
    mkdirSync(join(TMP, "bin"), { recursive: true });
    writeFileSync(bin, "#!/usr/bin/env node\ntrue\n");
    chmodSync(bin, 0o755);
    expect(() => ensureAbmindExecutable()).not.toThrow();
  });

  it("applies +x through a symlink to the actual target", () => {
    const binDir = join(TMP, "bin");
    const targetDir = join(TMP, "lib", "node_modules", "abmind");
    mkdirSync(targetDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    const target = join(targetDir, "abmind.js");
    writeFileSync(target, "#!/usr/bin/env node\ntrue\n");
    chmodSync(target, 0o644);
    symlinkSync(target, join(binDir, "abmind"));
    ensureAbmindExecutable();
    const mode = statSync(target).mode & 0o111;
    expect(mode).not.toBe(0);
  });

  it("repairs a non-executable binary by setting +x", () => {
    const bin = join(TMP, "bin", "abmind");
    mkdirSync(join(TMP, "bin"), { recursive: true });
    writeFileSync(bin, "#!/usr/bin/env node\ntrue\n");
    chmodSync(bin, 0o644);
    ensureAbmindExecutable();
    const mode = statSync(bin).mode & 0o111;
    expect(mode).not.toBe(0);
  });
});
