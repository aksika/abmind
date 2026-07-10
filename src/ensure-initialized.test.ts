import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { tmpdir as osTmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * ensure-initialized.test.ts — verify lazy-init seeds non-SOUL core files
 * and explicitly skips SOUL.md (which is owned by soul-seeder; #1323, #1324).
 *
 * We can't import ensure-initialized.ts directly because it resolves its
 * template dir via dirname(import.meta.url) at call time — pointing at the
 * real repo's templates/ tree. Instead we exercise the same path resolution
 * and file-copy logic by simulating the function locally. The actual
 * import-and-execute path is covered by the smoke test in cli-smoke.integration.test.ts.
 */

const TEMPLATE_BODY_SOUL = "I am <agentName>.\n";
const TEMPLATE_BODY_TOOLS = "# memory-tools\n";
const TEMPLATE_BODY_NOTES = "# agent_notes\n";

const LAZY_INIT_SKIP = new Set(["SOUL.md"]);

function ensureCoreFilesForTest(dataDir: string, tplDir: string): void {
  if (!existsSync(tplDir)) return;
  const coreDir = join(dataDir, "core");
  mkdirSync(coreDir, { recursive: true });
  for (const file of ["SOUL.md", "memory-tools.md", "agent_notes.md"]) {
    if (LAZY_INIT_SKIP.has(file)) continue;
    const dst = join(coreDir, file);
    if (!existsSync(dst)) {
      writeFileSync(dst, readFileSync(join(tplDir, file), "utf-8"));
    }
  }
}

function seedTemplates(tplDir: string): void {
  mkdirSync(tplDir, { recursive: true });
  writeFileSync(join(tplDir, "SOUL.md"), TEMPLATE_BODY_SOUL);
  writeFileSync(join(tplDir, "memory-tools.md"), TEMPLATE_BODY_TOOLS);
  writeFileSync(join(tplDir, "agent_notes.md"), TEMPLATE_BODY_NOTES);
}

describe("ensure-initialized core-file seed (#1323, #1324)", () => {
  let tplDir: string;
  let dataDir: string;

  beforeEach(() => {
    tplDir = mkdtempSync(join(osTmpdir(), "abmind-ensure-tpl-"));
    dataDir = mkdtempSync(join(osTmpdir(), "abmind-ensure-data-"));
    seedTemplates(tplDir);
  });

  afterEach(() => {
    rmSync(tplDir, { recursive: true, force: true });
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("seeds memory-tools.md and agent_notes.md when missing", () => {
    ensureCoreFilesForTest(dataDir, tplDir);
    expect(existsSync(join(dataDir, "core", "memory-tools.md"))).toBe(true);
    expect(existsSync(join(dataDir, "core", "agent_notes.md"))).toBe(true);
  });

  it("does NOT seed SOUL.md — owned by soul-seeder", () => {
    ensureCoreFilesForTest(dataDir, tplDir);
    expect(existsSync(join(dataDir, "core", "SOUL.md"))).toBe(false);
  });

  it("does not overwrite an existing memory-tools.md (idempotent)", () => {
    mkdirSync(join(dataDir, "core"), { recursive: true });
    const userContent = "# user's own\n";
    writeFileSync(join(dataDir, "core", "memory-tools.md"), userContent);

    ensureCoreFilesForTest(dataDir, tplDir);

    expect(readFileSync(join(dataDir, "core", "memory-tools.md"), "utf-8")).toBe(userContent);
  });

  it("is a no-op when template dir is missing", () => {
    rmSync(tplDir, { recursive: true, force: true });
    ensureCoreFilesForTest(dataDir, tplDir);
    expect(existsSync(join(dataDir, "core"))).toBe(false);
  });
});

describe("ensure-initialized path resolution (templates/memory/core)", () => {
  it("resolves to templates/memory/core — not the legacy templates/core", () => {
    // Test file lives at src/ensure-initialized.test.ts; the source we want
    // to inspect is one level up at the same basename.
    const here = dirname(fileURLToPath(import.meta.url));
    const srcPath = join(here, "ensure-initialized.ts");
    const src = readFileSync(srcPath, "utf-8");
    // The post-#1323 templatesDir() must reference templates/memory/core
    expect(src).toContain('join(here, "..", "templates", "memory", "core")');
    // And must NOT reference the legacy templates/core
    expect(src).not.toMatch(/join\(here, ["']\.\.["'], ["']templates["'], ["']core["']\)/);
  });
});
