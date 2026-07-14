import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "../..");

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(full).isDirectory()) yield* walkFiles(full);
    else if (extname(full) === ".ts" && full.endsWith(".test.ts")) yield full;
  }
}

const testFiles = [...walkFiles(join(REPO_ROOT, "src"))];

const POLICY_EXEMPTIONS: Record<string, string> = {
  "src/test-support/test-isolation-policy.test.ts": "policy checker itself — exempt",
  "src/deploy-lib/paths.test.ts": "intentionally tests default path strings (read-only, no I/O)",
};

describe("test isolation policy", () => {
  describe("no module-level homedir() paths for mutable targets", () => {
    const mutableTargets = [".abtars", ".abmind"];

    for (const file of testFiles) {
      const rel = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
      if (POLICY_EXEMPTIONS[rel]) continue;

      it(`${rel} does not construct mutable default paths at module level`, () => {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (const target of mutableTargets) {
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.includes(target) && !line.includes("POLICY_EXEMPTIONS") && !line.includes("assertSandboxPath") && !line.includes("symlinkSync") && !line.includes("originalHome") && !line.includes("originalAbmind")) {
              const hasMutation = /\b(rmSync|unlinkSync|writeFileSync|mkdirSync)\b/.test(line);
              if (hasMutation) {
                const nextLine = lines[i + 1] || "";
                if (!line.includes("assertSandboxPath") && !nextLine.includes("assertSandboxPath")) {
                  expect.fail(`Line ${i + 1}: "${line.trim()}" mutates ${target} without assertSandboxPath`);
                }
              }
            }
          }
        }
      });
    }
  });

  describe("no { ...process.env } spread to child processes", () => {
    for (const file of testFiles) {
      const rel = file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;
      if (POLICY_EXEMPTIONS[rel]) continue;
      if (rel.startsWith("src/test-support/")) continue;

      it(`${rel} does not spread process.env to child processes`, () => {
        const content = readFileSync(file, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/\.\.\.process\.env\b/.test(line) && /spawn|exec|fork/.test(content)) {
            const nextLine = lines[i + 1] || "";
            if (!line.includes("isolatedChildEnv") && !nextLine.includes("isolatedChildEnv")) {
              expect.fail(`Line ${i + 1}: "${line.trim()}" spreads process.env — use isolatedChildEnv()`);
            }
          }
        }
      });
    }
  });
});
