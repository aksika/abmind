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
