import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync,
  lstatSync, readlinkSync, unlinkSync, renameSync, rmSync, symlinkSync,
  statSync, copyFileSync, readdirSync,
} from "node:fs";
import { join, dirname, isAbsolute, resolve, basename } from "node:path";
import { homedir, hostname } from "node:os";

export type StandaloneChannel = "stable" | "alpha" | "dev";

export interface StandaloneInstallRequest {
  readonly channel: StandaloneChannel;
  readonly explicitDevDir?: string;
  readonly artifactPath?: string;
}

export interface ReleaseMetadata {
  readonly schemaVersion: 1;
  readonly packageName: "abmind";
  readonly releaseId: string;
  readonly version: string;
  readonly channel: StandaloneChannel;
  readonly source: "npm" | "git" | "local";
  readonly commit: string | null;
  readonly artifactSha256: string;
  readonly activatedAt: string;
  readonly entrypoint: string;
}

export interface StandaloneInstallResult {
  readonly changed: boolean;
  readonly release: ReleaseMetadata;
  readonly releaseDir: string;
  readonly shadowedBy: string | null;
}

export interface ExecResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface StandaloneInstallerDeps {
  readonly abmindHome: string;
  readonly userBinDir: string;
  readonly userLibDir: string;
  readonly exec: (cmd: string, args: readonly string[], opts?: { cwd?: string }) => ExecResult;
  readonly sha256: (data: Buffer) => string;
}

const ABMIND_DEV_REPO = "https://github.com/aksika/abmind.git";
const LAUNCHER_MARKER = "# abmind-standalone-launcher:v1";

export function defaultDeps(abmindHome?: string): StandaloneInstallerDeps {
  const home = abmindHome ?? process.env["ABMIND_HOME"] ?? join(homedir(), ".abmind");
  return {
    abmindHome: home,
    userBinDir: join(homedir(), ".local", "bin"),
    userLibDir: join(homedir(), ".local", "lib", "node_modules"),
    exec: (cmd, args, opts) => {
      const r = spawnSync(cmd, args, {
        cwd: opts?.cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    sha256: (data) => createHash("sha256").update(data).digest("hex"),
  };
}

function fail(msg: string): never {
  throw new Error(msg);
}

function assertOk(r: ExecResult, label: string): void {
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout).trim().slice(0, 500);
    fail(`${label} failed (exit ${r.status}): ${detail}`);
  }
}

function spDir(home: string): string {
  return join(home, "packages", "standalone");
}

function curLink(home: string): string {
  return join(spDir(home), "current");
}

function scriptsPath(home: string): string {
  return join(home, "scripts");
}

function publicBin(userBinDir: string): string {
  return join(userBinDir, "abmind");
}

function publicMod(userLibDir: string): string {
  return join(userLibDir, "abmind");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function posixQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function sanitizeReleaseId(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function generateLauncher(entrypoint: string): string {
  return `#!/bin/sh\n${LAUNCHER_MARKER}\nset -eu\nexec node ${posixQuote(entrypoint)} "$@"\n`;
}

function readCurrentLink(home: string): string | null {
  try {
    return readlinkSync(curLink(home));
  } catch {
    return null;
  }
}

function validateReleaseJson(meta: unknown): ReleaseMetadata {
  const m = meta as Record<string, unknown>;
  if (m?.schemaVersion !== 1) fail("release.json has invalid schemaVersion");
  if (m?.packageName !== "abmind") fail("release.json packageName is not abmind");
  if (typeof m?.releaseId !== "string" || !m.releaseId) fail("release.json missing releaseId");
  if (typeof m?.entrypoint !== "string" || !m.entrypoint) fail("release.json missing entrypoint");
  return m as unknown as ReleaseMetadata;
}

function linkOwnershipPredicate(linkPath: string, marker: string): "create" | "replace" | "refuse" {
  try {
    const st = lstatSync(linkPath);
    if (st.isSymbolicLink()) return "replace";
    if (st.isFile()) {
      const content = readFileSync(linkPath, "utf-8");
      if (content.includes(marker)) return "replace";
    }
    return "refuse";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "create";
    return "refuse";
  }
}

function atomicSymlinkReplace(target: string, linkPath: string): void {
  const tmp = `${linkPath}.${randomBytes(4).toString("hex")}`;
  symlinkSync(target, tmp);
  try {
    renameSync(tmp, linkPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { }
    throw err;
  }
}

function atomicFileReplace(source: string, dest: string): void {
  const tmp = `${dest}.${randomBytes(4).toString("hex")}`;
  copyFileSync(source, tmp);
  try {
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { }
    throw err;
  }
}

function ensurePublicLink(sourceTarget: string, linkPath: string, marker: string): void {
  const predicate = linkOwnershipPredicate(linkPath, marker);
  if (predicate === "refuse") {
    fail(`Refusing to overwrite unrelated file at ${linkPath}`);
  }
  const parent = dirname(linkPath);
  mkdirSync(parent, { recursive: true });
  if (predicate === "replace") {
    unlinkSync(linkPath);
  }
  symlinkSync(sourceTarget, linkPath);
}

function validateLinkChain(linkPath: string): boolean {
  try {
    const st = lstatSync(linkPath);
    if (!st.isSymbolicLink()) return false;
    const target = readlinkSync(linkPath);
    const abs = resolve(dirname(linkPath), target);
    return existsSync(abs);
  } catch {
    return false;
  }
}

function detectPathShadowing(userBinDir: string): string | null {
  try {
    const r = spawnSync("sh", ["-c", "command -v abmind"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status === 0) {
      const resolved = r.stdout.trim();
      if (resolved && resolved !== join(userBinDir, "abmind")) {
        return resolved;
      }
    }
  } catch {
  }
  return null;
}

export function readReleaseJson(releaseDir: string): ReleaseMetadata | null {
  const p = join(releaseDir, "release.json");
  try {
    return validateReleaseJson(readJson(p));
  } catch {
    return null;
  }
}

export function findExistingRelease(home: string, releaseId: string): string | null {
  const dir = join(spDir(home), releaseId);
  if (!existsSync(dir)) return null;
  const meta = readReleaseJson(dir);
  if (!meta) return null;
  if (meta.releaseId !== releaseId) return null;
  const entry = join(dir, meta.entrypoint);
  if (!existsSync(entry)) return null;
  return dir;
}

async function acquireArtifact(
  request: StandaloneInstallRequest,
  deps: StandaloneInstallerDeps,
): Promise<{ tarballPath: string; sha256: string; version: string; commit: string | null; source: "npm" | "git" | "local" }> {
  const workDir = join(spDir(deps.abmindHome), ".staging-work");
  mkdirSync(workDir, { recursive: true, mode: 0o700 });

  if (request.artifactPath) {
    const buf = readFileSync(request.artifactPath);
    const sha256 = deps.sha256(buf);
    // Extract tarball to a temp dir to read version from package.json
    const extractDir = join(workDir, "artifact-extract");
    mkdirSync(extractDir, { recursive: true });
    const extractR = deps.exec("tar", ["-xzf", request.artifactPath, "--strip-components=1", "-C", extractDir]);
    if (extractR.status !== 0) fail(`Failed to extract artifact: ${extractR.stderr}`);
    const pkg = readJson(join(extractDir, "package.json")) as Record<string, unknown>;
    rmSync(extractDir, { recursive: true, force: true });
    return { tarballPath: request.artifactPath, sha256, version: pkg.version as string, commit: null, source: "local" };
  }

  if (request.channel === "stable" || request.channel === "alpha") {
    const tag = request.channel === "stable" ? "latest" : "alpha";
    const r = deps.exec("npm", ["pack", "--json", "--pack-destination", workDir, `abmind@${tag}`]);
    assertOk(r, `npm pack abmind@${tag}`);
    const parsed = JSON.parse(r.stdout) as Array<{ filename?: string; version?: string }>;
    if (!Array.isArray(parsed) || parsed.length === 0) fail("npm pack returned no output");
    const filename = parsed[0]?.filename;
    const version = parsed[0]?.version;
    if (!filename) fail("npm pack output missing filename");
    const tarballPath = join(workDir, filename);
    const buf = readFileSync(tarballPath);
    const sha256 = deps.sha256(buf);
    return { tarballPath, sha256, version: version ?? "unknown", commit: null, source: "npm" };
  }

  const explicitDir = request.explicitDevDir;
  const devDir: string = (() => {
    if (explicitDir) return isAbsolute(explicitDir) ? explicitDir : resolve(process.cwd(), explicitDir);
    return join(deps.abmindHome, "src", "abmind");
  })();

  if (explicitDir) {
    if (!existsSync(join(devDir, "package.json"))) fail(`Not a valid abmind source: ${devDir}`);
  } else {
    if (!existsSync(join(devDir, ".git"))) {
      const parent = dirname(devDir);
      mkdirSync(parent, { recursive: true });
      const r = deps.exec("git", ["clone", "--depth", "1", "-b", "dev", ABMIND_DEV_REPO, devDir], { cwd: parent });
      assertOk(r, "git clone abmind dev");
    } else {
      const r1 = deps.exec("git", ["-C", devDir, "fetch", "origin", "dev"]);
      assertOk(r1, "git fetch dev");
      const r2 = deps.exec("git", ["-C", devDir, "checkout", "-f", "origin/dev"]);
      assertOk(r2, "git checkout origin/dev");
    }
  }

  if (!existsSync(join(devDir, "package.json"))) fail(`Not a valid abmind source: ${devDir}`);

  const rInstall = deps.exec("npm", ["install", "--no-audit", "--no-fund"], { cwd: devDir });
  assertOk(rInstall, "npm install in dev source");
  const rBuild = deps.exec("npm", ["run", "build"], { cwd: devDir });
  assertOk(rBuild, "npm run build in dev source");
  const rPack = deps.exec("npm", ["pack", "--json", "--pack-destination", workDir], { cwd: devDir });
  assertOk(rPack, "npm pack in dev source");
  const parsed = JSON.parse(rPack.stdout) as Array<{ filename?: string }>;
  if (!Array.isArray(parsed) || parsed.length === 0) fail("npm pack returned no output");
  const filename = parsed[0]?.filename;
  if (!filename) fail("npm pack output missing filename");
  const tarballPath = join(workDir, filename);
  const buf = readFileSync(tarballPath);
  const sha256 = deps.sha256(buf);
  const pkg = readJson(join(devDir, "package.json")) as Record<string, unknown>;
  let commit: string | null = null;
  if (!explicitDir) {
    const rCommit = deps.exec("git", ["-C", devDir, "rev-parse", "--short", "HEAD"]);
    if (rCommit.status === 0) commit = rCommit.stdout.trim();
  }
  return { tarballPath, sha256, version: pkg.version as string, commit, source: explicitDir ? "local" : "git" };
}

async function stageRelease(
  tarballPath: string,
  sha256: string,
  version: string,
  commit: string | null,
  channel: StandaloneChannel,
  source: "npm" | "git" | "local",
  deps: StandaloneInstallerDeps,
): Promise<{ releaseDir: string; meta: ReleaseMetadata }> {
  const sp = spDir(deps.abmindHome);
  mkdirSync(sp, { recursive: true, mode: 0o700 });

  const nonce = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const stagingDir = join(sp, `.staging-${nonce}`);
  mkdirSync(stagingDir, { mode: 0o700 });

  const cleanup = (): void => {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { }
  };

  try {
    const installR = deps.exec("npm", [
      "install", "--prefix", stagingDir, "--omit=dev", "--ignore-scripts", tarballPath,
    ]);
    if (installR.status !== 0) {
      fail(`npm install --prefix failed (exit ${installR.status}): ${installR.stderr || installR.stdout}`);
    }

    const nodeModulesDir = join(stagingDir, "node_modules");
    const pkgDir = join(nodeModulesDir, "abmind");
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) fail("package.json not found after npm install --prefix");
    const pkg = readJson(pkgJsonPath) as Record<string, unknown>;
    if (pkg.name !== "abmind") fail(`Unexpected package name: ${pkg.name}`);

    const entrypoint = "node_modules/abmind/dist/cli/abmind.js";
    const entryAbs = join(stagingDir, entrypoint);
    if (!existsSync(entryAbs)) fail(`CLI entrypoint missing: ${entryAbs}`);

    const releaseIdBase = `${sanitizeReleaseId(version)}-${channel}-${sha256.slice(0, 12)}`;
    const releaseId = releaseIdBase;
    const finalEntryAbs = join(deps.abmindHome, "packages", "standalone", releaseId, entrypoint);

    const binDir = join(stagingDir, "bin");
    mkdirSync(binDir, { mode: 0o755 });
    const launcherPath = join(binDir, "abmind");

    const scriptsPathDir = scriptsPath(deps.abmindHome);
    mkdirSync(scriptsPathDir, { recursive: true, mode: 0o700 });

    const meta: ReleaseMetadata = {
      schemaVersion: 1,
      packageName: "abmind",
      releaseId,
      version: version as string,
      channel,
      source,
      commit,
      artifactSha256: sha256,
      activatedAt: new Date().toISOString(),
      entrypoint,
    };

    writeJson(join(stagingDir, "release.json"), meta);

    // Smoke test 1: explicit node invocation of the JS entrypoint
    const nodeCheck = deps.exec(process.execPath, [entryAbs, "--version"], { cwd: stagingDir });
    if (nodeCheck.status !== 0) {
      fail(`Node smoke test failed: ${nodeCheck.stderr || nodeCheck.stdout}`);
    }
    const nodeVersion = nodeCheck.stdout.trim();
    if (!nodeVersion.includes(meta.version)) {
      fail(`Node smoke version mismatch: expected ${meta.version}, got ${nodeVersion}`);
    }

    // Smoke test 2: generate launcher with staging path, test it,
    // then regenerate with final path before rename.
    const stagingEntryAbs = join(stagingDir, entrypoint);
    const stagingLauncherContent = generateLauncher(stagingEntryAbs);
    writeFileSync(launcherPath, stagingLauncherContent, "utf-8");
    chmodSync(launcherPath, 0o755);

    const launcherCheck = deps.exec("sh", [launcherPath, "--version"], { cwd: stagingDir });
    if (launcherCheck.status !== 0) {
      fail(`Launcher smoke test failed: ${launcherCheck.stderr || launcherCheck.stdout}`);
    }
    const launcherVersion = launcherCheck.stdout.trim();
    if (!launcherVersion.includes(meta.version)) {
      fail(`Launcher smoke version mismatch: expected ${meta.version}, got ${launcherVersion}`);
    }

    // Regenerate launcher with final absolute path before finalizing
    writeFileSync(launcherPath, generateLauncher(finalEntryAbs), "utf-8");
    chmodSync(launcherPath, 0o755);

    const finalDir = join(sp, releaseId);
    if (existsSync(finalDir)) {
      const existingMeta = readReleaseJson(finalDir);
      if (existingMeta && existingMeta.releaseId === releaseId) {
        cleanup();
        return { releaseDir: finalDir, meta };
      }
      rmSync(finalDir, { recursive: true, force: true });
    }

    renameSync(stagingDir, finalDir);

    return { releaseDir: finalDir, meta };
  } catch (err) {
    cleanup();
    throw err;
  }
}

export async function stageAndValidate(
  request: StandaloneInstallRequest,
  deps: StandaloneInstallerDeps,
): Promise<{ releaseDir: string; meta: ReleaseMetadata; tarballSha256: string }> {
  const { tarballPath, sha256, version, commit, source } = await acquireArtifact(request, deps);

  const existing = findExistingRelease(deps.abmindHome, `${sanitizeReleaseId(version)}-${request.channel}-${sha256.slice(0, 12)}`);
  if (existing) {
    const existingMeta = readReleaseJson(existing)!;
    return { releaseDir: existing, meta: existingMeta, tarballSha256: sha256 };
  }

  const { releaseDir, meta } = await stageRelease(tarballPath, sha256, version, commit, request.channel, source, deps);
  return { releaseDir, meta, tarballSha256: sha256 };
}

export async function activateRelease(
  releaseDir: string,
  meta: ReleaseMetadata,
  deps: StandaloneInstallerDeps,
): Promise<StandaloneInstallResult> {
  const cl = curLink(deps.abmindHome);
  mkdirSync(dirname(cl), { recursive: true });

  const currentTarget = readCurrentLink(deps.abmindHome);
  if (currentTarget === releaseDir) {
    return {
      changed: false,
      release: meta,
      releaseDir,
      shadowedBy: null,
    };
  }

  const tmpLink = `${cl}.${randomBytes(4).toString("hex")}`;
  symlinkSync(releaseDir, tmpLink);
  renameSync(tmpLink, cl);

  const absLauncher = join(releaseDir, "bin", "abmind");
  if (existsSync(absLauncher)) {
    ensurePublicLink(absLauncher, publicBin(deps.userBinDir), LAUNCHER_MARKER);
  }

  const absNodeModules = join(releaseDir, "node_modules", "abmind");
  if (existsSync(absNodeModules)) {
    ensurePublicLink(absNodeModules, publicMod(deps.userLibDir), LAUNCHER_MARKER);
  }

  const shadowedBy = detectPathShadowing(deps.userBinDir);

  const manifestPath = join(deps.abmindHome, "manifest.json");
  try {
    const existing = existsSync(manifestPath) ? (readJson(manifestPath) as Record<string, unknown>) : null;
    const manifest = {
      ...(existing ?? {}),
      version: meta.version,
      commit: meta.commit,
      source: meta.source,
      activatedAt: meta.activatedAt,
    };
    writeJson(manifestPath, manifest);
  } catch {
  }

  pruneOldReleases(deps.abmindHome, basename(releaseDir));

  return {
    changed: true,
    release: meta,
    releaseDir,
    shadowedBy,
  };
}

function pruneOldReleases(home: string, activeReleaseId: string): void {
  const spDirPath = spDir(home);
  let entries: string[];
  try {
    entries = readdirSync(spDirPath).filter((e) => {
      try { return statSync(join(spDirPath, e)).isDirectory() && !e.startsWith("."); } catch { return false; }
    });
  } catch {
    return;
  }

  const valid: Array<{ id: string; mtime: Date }> = [];
  for (const e of entries) {
    if (e === activeReleaseId) continue;
    const metaPath = join(spDirPath, e, "release.json");
    if (!existsSync(metaPath)) continue;
    try {
      const s = statSync(metaPath);
      valid.push({ id: e, mtime: s.mtime });
    } catch { }
  }

  valid.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

  const toRemove = valid.slice(2);
  for (const r of toRemove) {
    try {
      rmSync(join(spDirPath, r.id), { recursive: true, force: true });
    } catch {
    }
  }
}

export async function installStandalone(
  request: StandaloneInstallRequest,
  deps?: StandaloneInstallerDeps,
): Promise<StandaloneInstallResult> {
  const d = deps ?? defaultDeps();
  const { releaseDir, meta } = await stageAndValidate(request, d);
  return activateRelease(releaseDir, meta, d);
}
