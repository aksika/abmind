import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(full).isDirectory()) yield* walkFiles(full);
    else if (extname(full) === ".ts" && full.endsWith(".test.ts")) yield full;
  }
}

const testFiles = [...walkFiles(join(REPO_ROOT, "src"))];

const rel = (file: string) =>
  file.startsWith(REPO_ROOT) ? file.slice(REPO_ROOT.length + 1) : file;

/** Application roots that must never be mutated by a default-path writer. */
const MUTABLE_TARGETS = [".abmind", ".abtars", ".abtars-releases"];
/** Filesystem mutation calls (sync). */
const MUTATION_FNS = /\b(rmSync|unlinkSync|writeFileSync|mkdirSync|rmdirSync|cpSync|renameSync|appendFileSync)\b/;
/** Containment guards / sandbox-aware helpers that make a mutation safe. */
const GUARD = /assertSandboxPath|isolatedChildEnv|currentTestSandbox/;
/** Explicit test-owned temporary-directory owners. */
const TEMP_OWNER = /mkdtemp|tmpdir\(\)/;

export interface Violation {
  line: number;
  snippet: string;
}

/** R1: directly mutate a default mutable target built from homedir() on the same line. */
function liveDefaultMutation(src: string): Violation[] {
  const lines = src.split("\n");
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!MUTATION_FNS.test(line)) continue;
    if (!/homedir\(\)/.test(line)) continue;
    if (!MUTABLE_TARGETS.some((t) => line.includes(t))) continue;
    const nearby = line + "\n" + (lines[i + 1] || "");
    if (GUARD.test(nearby) || TEMP_OWNER.test(nearby)) continue;
    out.push({ line: i + 1, snippet: line.trim() });
  }
  return out;
}

/** R2: module-level capture of a homedir()-derived mutable default that is later mutated. */
function moduleLevelMutableCapture(src: string): Violation[] {
  const lines = src.split("\n");
  const captures: { name: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const m = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Z_][A-Z0-9_]*)\s*=/);
    if (!m) continue;
    const name = m[1];
    if (name === undefined) continue;
    if (!/homedir\(\)/.test(line)) continue;
    if (!MUTABLE_TARGETS.some((t) => line.includes(t))) continue;
    if (GUARD.test(line) || TEMP_OWNER.test(line)) continue;
    captures.push({ name, line: i + 1 });
  }
  const out: Violation[] = [];
  for (const cap of captures) {
    const ref = new RegExp(`\\b${cap.name}\\b`);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      if (!MUTATION_FNS.test(line)) continue;
      if (!ref.test(line)) continue;
      const nearby = (lines[i - 1] || "") + "\n" + line + "\n" + (lines[i + 1] || "");
      if (GUARD.test(nearby) || TEMP_OWNER.test(nearby)) continue;
      out.push({
        line: i + 1,
        snippet: `"${cap.name}" captured at line ${cap.line}, mutated here: ${line.trim()}`,
      });
    }
  }
  return out;
}

/** R3: recursive cleanup targeting a default mutable root without a guard or temp owner. */
function unsafeRecursiveCleanup(src: string): Violation[] {
  const lines = src.split("\n");
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!/rmSync\s*\(/.test(line)) continue;
    if (!/recursive\s*:\s*true/.test(line)) continue;
    const targetsDefault =
      /homedir\(\)/.test(line) ||
      MUTABLE_TARGETS.some((t) => line.includes(`"${t}"`) || line.includes(`'${t}'`));
    if (!targetsDefault) continue;
    const nearby = (lines[i - 1] || "") + "\n" + line + "\n" + (lines[i + 1] || "");
    if (GUARD.test(nearby) || TEMP_OWNER.test(nearby)) continue;
    out.push({ line: i + 1, snippet: line.trim() });
  }
  return out;
}

/** R4: spread process.env into a real child-process call instead of isolatedChildEnv(). */
function envSpreadToChildProcess(src: string): Violation[] {
  const lines = src.split("\n");
  const realCall = /\b(spawn|execFile|execSync|spawnSync|fork|exec)\s*\(/;
  const hasRealCall = lines.some(
    (l) => realCall.test(l) && !/vi\.(fn|spyOn|mock)/.test(l),
  );
  if (!hasRealCall) return [];
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (!/\.\.\.process\.env\b/.test(line)) continue;
    const nearby = (lines[i - 1] || "") + "\n" + line + "\n" + (lines[i + 1] || "");
    if (/isolatedChildEnv/.test(nearby)) continue;
    out.push({ line: i + 1, snippet: line.trim() });
  }
  return out;
}

const RULES: { name: string; run: (src: string) => Violation[] }[] = [
  { name: "live default mutation", run: liveDefaultMutation },
  { name: "module-level mutable capture", run: moduleLevelMutableCapture },
  { name: "unsafe recursive cleanup", run: unsafeRecursiveCleanup },
  { name: "env spread to child process", run: envSpreadToChildProcess },
];

// Exact-path exemptions with a one-line reason. Path-only assertions and tests
// that mutate only owned temp directories do not need an exemption under the
// line-oriented predicates; reserve exemptions for genuine exceptions.
const POLICY_EXEMPTIONS: Record<string, string> = {
  "src/test-support/test-isolation-policy.test.ts": "policy checker itself — exempt",
};

describe("test isolation policy — rule fixtures", () => {
  describe("R1: live default mutation", () => {
    it("rejects rmSync of a homedir()-derived .abmind path", () => {
      const src = `rmSync(join(homedir(), ".abmind", "memory"), { recursive: true });`;
      expect(liveDefaultMutation(src)).toHaveLength(1);
    });
    it("rejects writeFileSync to a homedir() .abmind path", () => {
      const src = `writeFileSync(join(homedir(), ".abmind", "hooks", "x.log"), "x");`;
      expect(liveDefaultMutation(src)).toHaveLength(1);
    });
    it("accepts the same mutation guarded by assertSandboxPath", () => {
      const src = [
        `const p = join(homedir(), ".abmind", "memory");`,
        `assertSandboxPath(p);`,
        `rmSync(p, { recursive: true });`,
      ].join("\n");
      expect(liveDefaultMutation(src)).toHaveLength(0);
    });
    it("accepts mutation of an owned tmp path", () => {
      const src = `rmSync(join(tmpdir(), "my-test"), { recursive: true });`;
      expect(liveDefaultMutation(src)).toHaveLength(0);
    });
  });

  describe("R2: module-level mutable capture", () => {
    it("rejects a module-level homedir() capture that is later mutated", () => {
      const src = [
        `const HOOK_FILE = join(homedir(), ".abmind", "hooks", "errors.log");`,
        `writeFileSync(HOOK_FILE, "x");`,
      ].join("\n");
      expect(moduleLevelMutableCapture(src)).toHaveLength(1);
    });
    it("accepts a capture that is never mutated", () => {
      const src = `const P = join(homedir(), ".abmind");\nexpect(P).toContain(".abmind");`;
      expect(moduleLevelMutableCapture(src)).toHaveLength(0);
    });
  });

  describe("R3: unsafe recursive cleanup", () => {
    it("rejects recursive rmSync of a default .abmind target", () => {
      const src = `rmSync(join(homedir(), ".abmind"), { recursive: true });`;
      expect(unsafeRecursiveCleanup(src)).toHaveLength(1);
    });
    it("accepts recursive rmSync of an owned tmp path", () => {
      const src = `rmSync(tmpDir, { recursive: true });`;
      expect(unsafeRecursiveCleanup(src)).toHaveLength(0);
    });
  });

  describe("R4: env spread to child process", () => {
    it("rejects {...process.env} passed to a real spawn", () => {
      const src = `spawnSync("node", [cli], { env: { ...process.env } });`;
      expect(envSpreadToChildProcess(src)).toHaveLength(1);
    });
    it("accepts isolatedChildEnv with overrides", () => {
      const src = `spawnSync("node", [cli], { env: isolatedChildEnv({ ABMIND_HOME: t }) });`;
      expect(envSpreadToChildProcess(src)).toHaveLength(0);
    });
    it("does not flag files that only mock child_process", () => {
      const src = [
        `vi.fn()`,
        `const env = { ...process.env };`,
      ].join("\n");
      expect(envSpreadToChildProcess(src)).toHaveLength(0);
    });
  });
});

describe("test isolation policy — repository scan", () => {
  for (const file of testFiles) {
    const r = rel(file);
    if (POLICY_EXEMPTIONS[r]) continue;

    it(`${r} passes all isolation rules`, () => {
      const src = readFileSync(file, "utf-8");
      const violations = RULES.flatMap((rule) =>
        rule.run(src).map((v) => `[${rule.name}] line ${v.line}: ${v.snippet}`),
      );
      if (violations.length > 0) {
        expect.fail(
          `isolation policy violations in ${r}:\n${violations.join("\n")}`,
        );
      }
    });
  }
});
