// #212 — every KEY= documented in config/.env.memory.example must be read by code.
// Catches drift: key added to the example but no reader, or reader renamed.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "..");
const EXAMPLE = join(ROOT, "templates", "config", ".env.memory");

/** Extract KEY names from ^#?\s*KEY= lines in the example. */
function documentedKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (m && m[1]) out.push(m[1]);
  }
  return [...new Set(out)];
}

/** Walk src/ and cli/ collecting .ts contents (skip .test.ts and dist). */
function codebaseText(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(p);
      } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
        parts.push(readFileSync(p, "utf-8"));
      }
    }
  };
  walk(join(ROOT, "src"));
  walk(join(ROOT, "cli"));
  return parts.join("\n");
}

describe(".env.memory.example coverage (#212)", () => {
  const keys = documentedKeys(readFileSync(EXAMPLE, "utf-8"));
  const code = codebaseText();

  it("extracts at least the known baseline of keys", () => {
    // Guards against the extractor silently returning [] if the example file format changes.
    expect(keys.length).toBeGreaterThanOrEqual(10);
  });

  for (const key of keys) {
    it(`${key} is read somewhere in src/ or cli/`, () => {
      // Accept any of: process.env["KEY"], process.env.KEY, "KEY" as string arg
      // to parseBoolEnv / parseNumberEnv / similar env helpers.
      const bracket = `process.env["${key}"]`;
      const dot = new RegExp(`process\\.env\\.${key}\\b`);
      const quoted = new RegExp(`["'\`]${key}["'\`]`);
      const found = code.includes(bracket) || dot.test(code) || quoted.test(code);
      expect(found, `${key} documented in .env.memory.example but not read in src/ or cli/`).toBe(true);
    });
  }
});
