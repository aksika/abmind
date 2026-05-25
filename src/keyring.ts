/**
 * OS keyring integration — read/write passphrase from macOS Keychain or Linux secret-tool.
 * Silent failure: returns undefined if keyring is inaccessible.
 */

import { execFileSync } from "node:child_process";

const SERVICE = "abmind";
const ACCOUNT = "master-passphrase";

/** Read passphrase from OS keyring. Returns undefined on failure. */
export function readFromKeyring(): string | undefined {
  try {
    if (process.platform === "darwin") {
      const result = execFileSync("security", [
        "find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w",
      ], { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      return result.trim() || undefined;
    }
    if (process.platform === "linux") {
      // Skip on headless (no DBUS_SESSION_BUS_ADDRESS = no desktop session)
      if (!process.env["DBUS_SESSION_BUS_ADDRESS"]) return undefined;
      const result = execFileSync("secret-tool", [
        "lookup", "service", SERVICE, "account", ACCOUNT,
      ], { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      return result.trim() || undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Store passphrase in OS keyring. Returns true on success. */
export function writeToKeyring(passphrase: string): boolean {
  try {
    if (process.platform === "darwin") {
      // Delete existing first (add-generic-password fails if exists)
      try { execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT], { stdio: "pipe", timeout: 5000 }); } catch { /* may not exist */ }
      execFileSync("security", [
        "add-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w", passphrase,
      ], { timeout: 5000, stdio: "pipe" });
      return true;
    }
    if (process.platform === "linux") {
      if (!process.env["DBUS_SESSION_BUS_ADDRESS"]) return false;
      execFileSync("secret-tool", [
        "store", "--label", "abmind master passphrase", "service", SERVICE, "account", ACCOUNT,
      ], { input: passphrase, timeout: 5000, stdio: ["pipe", "pipe", "pipe"] });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
