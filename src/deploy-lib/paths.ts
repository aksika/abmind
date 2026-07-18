/**
 * Runtime directory resolution for deploy-lib consumers.
 *
 * Rules:
 *   - abtars runtime root: $ABTARS_HOME ?? ~/.abtars
 *   - abmind runtime root:      $ABMIND_HOME ?? ~/.abmind
 *   - user bin dir:             ~/.local/bin (always, XDG convention)
 *
 * All callers use these resolvers — never hardcode paths. Required by
 * plan #158 v7 (Ag2 round-2 nit): cross-repo manifest reads must respect
 * env-var overrides, not assume default locations.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

export type PackageName = 'abtars' | 'abmind';

export function resolveAbtarsHome(): string {
  return process.env['ABTARS_HOME'] ?? join(homedir(), '.abtars');
}

export function resolveAbmindHome(): string {
  return process.env['ABMIND_HOME'] ?? join(homedir(), '.abmind');
}

export function resolvePackageHome(pkg: PackageName): string {
  return pkg === 'abtars' ? resolveAbtarsHome() : resolveAbmindHome();
}

export function resolveUserBinDir(): string {
  return join(homedir(), '.local', 'bin');
}

export function resolveUserLibDir(): string {
  return join(homedir(), '.local', 'lib', 'node_modules');
}

export interface PackagePaths {
  readonly home: string;
  readonly config: string;
  readonly releases: string;
  readonly current: string;
  readonly nodeModules: string;
  readonly bin: string;
  readonly manifest: string;
  readonly lock: string;
}

export interface StandalonePaths {
  readonly home: string;
  readonly packagesStandalone: string;
  readonly currentLink: string;
  readonly scriptsDir: string;
  readonly repairScript: string;
  readonly publicBinLink: string;
  readonly publicModuleLink: string;
  readonly lock: string;
  readonly manifest: string;
}

export function standalonePaths(abmindHome?: string): StandalonePaths {
  const home = abmindHome ?? resolveAbmindHome();
  return {
    home,
    packagesStandalone: join(home, 'packages', 'standalone'),
    currentLink: join(home, 'packages', 'standalone', 'current'),
    scriptsDir: join(home, 'scripts'),
    repairScript: join(home, 'scripts', 'repair-cli.sh'),
    publicBinLink: join(resolveUserBinDir(), 'abmind'),
    publicModuleLink: join(resolveUserLibDir(), 'abmind'),
    lock: join(home, '.update.lock'),
    manifest: join(home, 'manifest.json'),
  };
}

export function packagePaths(pkg: PackageName): PackagePaths {
  const home = resolvePackageHome(pkg);
  return {
    home,
    config: join(home, 'config'),
    releases: join(home, 'releases'),
    current: join(home, 'current'),
    nodeModules: join(home, 'node_modules'),
    bin: join(home, 'bin'),
    manifest: join(home, 'manifest.json'),
    lock: join(home, '.update.lock'),
  };
}
