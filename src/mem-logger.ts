/**
 * Standalone logger for abmind.
 * Re-exports bridge logger when running inside the bridge,
 * falls back to minimal console logger when standalone.
 */

let _logInfo: (tag: string, msg: string) => void = (tag, msg) => console.log(`[${tag}] ${msg}`);
let _logWarn: (tag: string, msg: string) => void = (tag, msg) => console.warn(`[${tag}] ${msg}`);
let _logError: (tag: string, msg: string, err?: unknown) => void = (tag, msg, err) => {
  if (err) console.error(`[${tag}] ${msg}`, err);
  else console.error(`[${tag}] ${msg}`);
};

/** Allow the host (bridge) to inject its own logger. */
export function setLogger(fns: { logInfo: typeof _logInfo; logWarn: typeof _logWarn; logError: typeof _logError }): void {
  _logInfo = fns.logInfo;
  _logWarn = fns.logWarn;
  _logError = fns.logError;
}

export function logInfo(tag: string, msg: string): void { _logInfo(tag, msg); }
export function logWarn(tag: string, msg: string): void { _logWarn(tag, msg); }
export function logError(tag: string, msg: string, err?: unknown): void { _logError(tag, msg, err); }
export function logDebug(tag: string, msg: string): void { _logInfo(tag, msg); }
