/**
 * runtime-store.ts — per-plugin runtime isolation via Symbol.for registry.
 *
 * When abmind is loaded as a plugin host (OpenClaw ContextEngine, future multi-
 * session embedders), multiple instances may coexist in a single Node process.
 * Module-level state or process.env mutations leak across instances.
 *
 * This registry uses Symbol.for as a process-wide key that survives module
 * re-loading (bundler duplication, different resolution paths). Each plugin
 * instance registers its runtime under a unique pluginId and retrieves it
 * by that id — no shared mutable state, no env pollution.
 *
 * Pattern borrowed from openclaw/src/plugin-sdk/runtime-store.ts (Apache-2.0).
 * See abproject/docs/plans/346-runtime-store-pattern.md for design rationale.
 */

const REGISTRY_KEY = Symbol.for("abmind.plugin-sdk.runtime-store");

interface RegistryEntry<R> {
  runtime: R;
  pluginId: string;
  createdAt: number;
}

type Registry = Map<string, RegistryEntry<unknown>>;

interface GlobalWithRegistry {
  [REGISTRY_KEY]?: Registry;
}

function getRegistry(): Registry {
  const g = globalThis as unknown as GlobalWithRegistry;
  if (!g[REGISTRY_KEY]) {
    g[REGISTRY_KEY] = new Map();
  }
  return g[REGISTRY_KEY]!;
}

/**
 * Register a runtime under a pluginId.
 * Throws if the pluginId is already in use — callers must dispose before re-registering.
 */
export function registerRuntime<R>(pluginId: string, runtime: R): void {
  if (!pluginId || typeof pluginId !== "string") {
    throw new Error("registerRuntime: pluginId must be a non-empty string");
  }
  const registry = getRegistry();
  if (registry.has(pluginId)) {
    throw new Error(
      `registerRuntime: pluginId "${pluginId}" already registered — call removeRuntime first`,
    );
  }
  registry.set(pluginId, { runtime, pluginId, createdAt: Date.now() });
}

/**
 * Retrieve a runtime by pluginId.
 * Throws if no runtime is registered — callers should register at plugin init
 * and only call getRuntime during request handling (after init completes).
 */
export function getRuntime<R>(pluginId: string): R {
  const entry = getRegistry().get(pluginId);
  if (!entry) {
    throw new Error(
      `getRuntime: no runtime registered for pluginId "${pluginId}" (register at plugin init)`,
    );
  }
  return entry.runtime as R;
}

/**
 * Check whether a runtime is registered for a pluginId.
 * Use this to guard against double-registration in idempotent plugin init paths.
 */
export function hasRuntime(pluginId: string): boolean {
  return getRegistry().has(pluginId);
}

/**
 * Remove a runtime. Call from plugin dispose/shutdown.
 * No-op if the pluginId isn't registered (safe to call multiple times).
 */
export function removeRuntime(pluginId: string): void {
  getRegistry().delete(pluginId);
}

/**
 * List all currently-registered pluginIds. Primarily for debugging/tests.
 * Order is insertion order.
 */
export function listRuntimes(): readonly string[] {
  return [...getRegistry().keys()];
}

/**
 * Clear all runtimes. Test-only helper — production code should use removeRuntime.
 * @internal
 */
export function _clearAllRuntimes(): void {
  getRegistry().clear();
}
