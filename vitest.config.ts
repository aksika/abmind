import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Native deps (better-sqlite3) are installed centrally by `abmind deps install`
// to ~/.local/lib/node_modules — NOT local node_modules — so they are shared
// across packages and built once. Production resolves them via NODE_PATH (set by
// the CLI wrapper) + createRequire (src/memory-db.ts). vitest/vite ignores
// NODE_PATH, so bridge it with a resolve.alias to the same shared path. Types
// still come from @types/better-sqlite3 (devDep). Guarded so hosts with a local
// install (or CI) fall through to normal resolution.
const sharedSqlite = join(homedir(), ".local", "lib", "node_modules", "better-sqlite3");

export default defineConfig({
  resolve: {
    alias: existsSync(sharedSqlite) ? { "better-sqlite3": sharedSqlite } : {},
  },
  test: {
    dir: "src",
    testTimeout: 10_000,
  },
});
