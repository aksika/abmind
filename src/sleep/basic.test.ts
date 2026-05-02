import { describe, it, expect } from "vitest";
import { parseBasicResponse } from "./basic.js";

describe("parseBasicResponse", () => {
  it("parses a well-formed response", () => {
    const warnings: string[] = [];
    const raw = `===DAILY===
Had a long discussion about the sleep refactor. Decided to ship it as #163 with four levels.

===MEMORIES===
[fact] User uses TypeScript with strict mode
[decision] Sleep levels: basic, budget, normal, ultimate
[preference] User dislikes mid-implementation design pivots without plan updates
===END===`;
    const r = parseBasicResponse(raw, warnings);
    expect(r.ok).toBe(true);
    expect(r.daily).toContain("long discussion");
    expect(r.memories).toHaveLength(3);
    expect(r.memories[0]).toEqual({ type: "fact", content: "User uses TypeScript with strict mode" });
    expect(r.memories[1]!.type).toBe("decision");
    expect(warnings).toHaveLength(0);
  });

  it("strips leading and trailing markdown code fences", () => {
    const warnings: string[] = [];
    const raw = "```markdown\n===DAILY===\nSummary.\n===MEMORIES===\n[fact] X\n===END===\n```";
    const r = parseBasicResponse(raw, warnings);
    expect(r.ok).toBe(true);
    expect(r.daily).toBe("Summary.");
    expect(r.memories).toHaveLength(1);
  });

  it("strips unlabeled code fences", () => {
    const warnings: string[] = [];
    const raw = "```\n===DAILY===\nSummary.\n===MEMORIES===\n===END===\n```";
    const r = parseBasicResponse(raw, warnings);
    expect(r.ok).toBe(true);
  });

  it("fails on missing DAILY marker", () => {
    const warnings: string[] = [];
    const r = parseBasicResponse("===MEMORIES===\n[fact] x\n===END===", warnings);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("===DAILY===");
  });

  it("fails on missing MEMORIES marker", () => {
    const warnings: string[] = [];
    const r = parseBasicResponse("===DAILY===\nx\n===END===", warnings);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("===MEMORIES===");
  });

  it("fails on missing END marker", () => {
    const warnings: string[] = [];
    const r = parseBasicResponse("===DAILY===\nx\n===MEMORIES===\n[fact] y", warnings);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("===END===");
  });

  it("fails on empty DAILY section", () => {
    const warnings: string[] = [];
    const r = parseBasicResponse("===DAILY===\n\n===MEMORIES===\n===END===", warnings);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("Empty");
  });

  it("accepts empty MEMORIES section (not an error)", () => {
    const warnings: string[] = [];
    const r = parseBasicResponse("===DAILY===\nA quiet day.\n===MEMORIES===\n===END===", warnings);
    expect(r.ok).toBe(true);
    expect(r.memories).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it("skips unknown memory types with a warning", () => {
    const warnings: string[] = [];
    const raw = "===DAILY===\nX\n===MEMORIES===\n[fact] valid\n[insight] unknown type\n[decision] also valid\n===END===";
    const r = parseBasicResponse(raw, warnings);
    expect(r.ok).toBe(true);
    expect(r.memories).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Unknown memory type '[insight]'");
  });

  it("skips malformed memory lines (no [type] prefix) with a warning", () => {
    const warnings: string[] = [];
    const raw = "===DAILY===\nX\n===MEMORIES===\n[fact] ok\nno prefix here\n[decision] ok too\n===END===";
    const r = parseBasicResponse(raw, warnings);
    expect(r.ok).toBe(true);
    expect(r.memories).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Malformed memory line");
  });

  it("fails when MEMORIES appears before DAILY (wrong order)", () => {
    const warnings: string[] = [];
    const raw = "===MEMORIES===\n[fact] x\n===DAILY===\nsummary\n===END===";
    const r = parseBasicResponse(raw, warnings);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("before");
  });
});
