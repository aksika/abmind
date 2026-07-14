import { mkdtempSync, mkdirSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { tmpdir, homedir } from "node:os";
import { afterAll } from "vitest";

export interface TestRuntimeSandbox {
  root: string;
  home: string;
  abmindHome: string;
  xdgConfig: string;
  xdgCache: string;
  xdgState: string;
}

let _currentSandbox: TestRuntimeSandbox | null = null;

const SANDBOX_VARS = [
  "HOME", "USERPROFILE", "ABMIND_HOME",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "NODE_ENV", "AB_TEST_SANDBOX_ROOT",
] as const;

const _originals = new Map<string, { wasSet: boolean; value: string }>();

for (const key of SANDBOX_VARS) {
  _originals.set(key, {
    wasSet: key in process.env,
    value: process.env[key] ?? "",
  });
}

function setupSandbox(): TestRuntimeSandbox {
  const root = mkdtempSync(join(tmpdir(), "abmind-vitest-"));
  const home = join(root, "home");
  const abmindHome = join(home, ".abmind");
  const xdgConfig = join(home, ".config");
  const xdgCache = join(home, ".cache");
  const xdgState = join(home, ".local", "state");

  for (const dir of [home, abmindHome, xdgConfig, xdgCache, xdgState]) {
    mkdirSync(dir, { recursive: true });
  }

  const realHome = process.env.HOME || homedir();

  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.ABMIND_HOME = abmindHome;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_CACHE_HOME = xdgCache;
  process.env.XDG_STATE_HOME = xdgState;
  process.env.NODE_ENV = "test";
  process.env.AB_TEST_SANDBOX_ROOT = root;

  // Preserve access to real host-level native deps (~/.local/lib/node_modules/)
  const realLocalLib = join(realHome, ".local", "lib", "node_modules");
  if (existsSync(realLocalLib)) {
    const sandboxLocalLib = join(home, ".local", "lib");
    mkdirSync(sandboxLocalLib, { recursive: true });
    try { symlinkSync(realLocalLib, join(sandboxLocalLib, "node_modules")); } catch { /* best effort */ }
  }

  const sandbox: TestRuntimeSandbox = { root, home, abmindHome, xdgConfig, xdgCache, xdgState };
  _currentSandbox = sandbox;
  return sandbox;
}

function restoreSandbox(): void {
  for (const [key, record] of _originals) {
    if (record.wasSet) {
      process.env[key] = record.value;
    } else {
      delete process.env[key];
    }
  }
}

export function currentTestSandbox(): TestRuntimeSandbox {
  if (!_currentSandbox) throw new Error("No test sandbox is installed — is runtime-isolation.ts loaded as a setupFile?");
  return _currentSandbox;
}

export function assertSandboxPath(path: string): string {
  const sandbox = currentTestSandbox();
  // resolve() follows symlinks — if path is a symlink pointing outside
  // the sandbox, relative() will detect the escape via leading "..".
  const resolved = resolve(path);
  const rel = relative(sandbox.root, resolved);
  if (rel.startsWith("..") || resolved === sandbox.root) {
    throw new Error(`Path "${path}" resolves outside the test sandbox root "${sandbox.root}"`);
  }
  return resolved;
}

const CHILD_ALLOWLIST = new Set<string>([
  "PATH", "NODE_PATH", "PATHEXT", "SystemRoot", "WINDIR",
  "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "TERM",
  "HOME", "USERPROFILE", "ABMIND_HOME",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "NODE_ENV", "AB_TEST_SANDBOX_ROOT",
]);

export function isolatedChildEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (overrides) Object.assign(env, overrides);
  return env;
}

const sandbox = setupSandbox();

afterAll(() => {
  try { rmSync(sandbox.root, { recursive: true, force: true }); } catch (err) {
    process.stderr.write(`[runtime-isolation] failed to remove sandbox ${sandbox.root}: ${err}\n`);
  }
  restoreSandbox();
  _currentSandbox = null;
});
