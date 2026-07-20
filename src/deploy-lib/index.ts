/**
 * Deploy-lib: shared install/update/rollback primitives.
 *
 * Consumed by both `abmind` CLI (its own runtime at ~/.abmind) and by
 * `abtars` (via file:../abmind dependency, managing ~/.abtars).
 *
 * Entry points are the module files directly:
 *   import { resolveAbtarsHome } from 'abmind/deploy-lib/paths.js'
 *   import { readManifest, writeManifest } from 'abmind/deploy-lib/manifest.js'
 *   etc.
 *
 * See abproject/docs/plans/158-deploy-rewrite.md for the full contract.
 */

export * from './paths.js';
export * from './manifest.js';
export * from './lock.js';
export * from './releases.js';
export * from './cleanup.js';
export * from './safe-copy.js';
export * from './shared-native-deps.js';
export * from './abmind-daemon-service.js';
export {
  resolveLaunchdDaemonEntry,
  xmlEscape,
  renderLaunchdPlist,
  launchdPlistPath,
  installLaunchAgent,
  startLaunchAgent,
  restartLaunchAgent,
  stopLaunchAgent,
  stopLaunchAgentSafe,
  statusLaunchAgent,
  uninstallLaunchAgent,
  stopOrphanedDaemon,
  createHealthProbe,
  isAbsentBootoutError,
  isTransientBootstrapError,
  PROBE_DEADLINE_MS,
  PROBE_INTERVAL_MS,
  ORPHAN_STOP_TIMEOUT_MS,
  ORPHAN_STOP_POLL_MS,
  BOOTSTRAP_RETRY_ATTEMPTS,
  BOOTSTRAP_RETRY_DELAY_MS,
  HealthProbeResult,
  LaunchdServiceDeps,
  InstallResult,
  StartResult,
  StopOrphanResult,
} from './abmind-launchd-service.js';
