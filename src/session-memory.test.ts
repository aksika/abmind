import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMemoryContext } from "./session-memory.js";
import { localDate } from "./mem-env.js";

/** #1821 — "today's summary" resolution under write-time filenames. */
describe("buildMemoryContext daily resolution", () => {
  let root: string;
  let memoryDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "session-mem-"));
    memoryDir = join(root, "memory");
    mkdirSync(join(memoryDir, "daily"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the legacy exact-name file when present", () => {
    const today = localDate();
    writeFileSync(join(memoryDir, "daily", `daily_${today}.md`), "legacy today");
    const text = buildMemoryContext(null, memoryDir, "u1");
    expect(text).toContain("## Today's Summary");
    expect(text).toContain("legacy today");
  });

  it("resolves a stamped file whose heading period covers today", () => {
    const y = new Date(Date.now() - 86_400_000);
    const yStr = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, "0")}-${String(y.getDate()).padStart(2, "0")}`;
    const today = localDate();
    // The filename stamp is irrelevant to coverage: an older stamp whose
    // heading range reaches today still resolves.
    writeFileSync(
      join(memoryDir, "daily", `daily_${yStr}-2359Z.md`),
      `# Daily Summary ${yStr} — ${today}\n\nstamped today`,
    );
    const text = buildMemoryContext(null, memoryDir, "u1");
    expect(text).toContain("## Today's Summary");
    expect(text).toContain("stamped today");
  });

  it("omits the block when no daily covers today", () => {
    writeFileSync(join(memoryDir, "daily", "daily_2020-01-01-0000Z.md"), "# Daily Summary 2020-01-01\n\nancient");
    const text = buildMemoryContext(null, memoryDir, "u1");
    expect(text).not.toContain("## Today's Summary");
  });
});
