/**
 * Unit tests for sleep/audit.ts — parseOutcomesFromResponse and buildSnapshotSummary (#1229).
 */

import { describe, it, expect } from "vitest";
import { parseOutcomesFromResponse, buildSnapshotSummary } from "./audit.js";
import type { StateSnapshot } from "../sleep-state-gatherer.js";

// ── parseOutcomesFromResponse ────────────────────────────────────────────────

describe("parseOutcomesFromResponse", () => {
  it("returns all zeros for empty response", () => {
    const r = parseOutcomesFromResponse("");
    expect(r.filesConsolidated).toBe(0);
    expect(r.messagesPruned).toBe(0);
    expect(r.embeddingsRemoved).toBe(0);
    expect(r.sessionsCleaned).toBe(0);
    expect(r.topicsMerged).toBe(0);
    expect(r.topicsDeleted).toBe(0);
  });

  it("parses 'consolidated 3 files'", () => {
    expect(parseOutcomesFromResponse("consolidated 3 files").filesConsolidated).toBe(3);
  });

  it("parses 'pruned 42 messages'", () => {
    expect(parseOutcomesFromResponse("pruned 42 messages").messagesPruned).toBe(42);
  });

  it("parses 'removed 7 embeddings'", () => {
    expect(parseOutcomesFromResponse("removed 7 embeddings").embeddingsRemoved).toBe(7);
  });

  it("parses 'cleaned 2 sessions'", () => {
    expect(parseOutcomesFromResponse("cleaned 2 sessions").sessionsCleaned).toBe(2);
  });

  it("parses 'merged 4 topics'", () => {
    expect(parseOutcomesFromResponse("merged 4 topics").topicsMerged).toBe(4);
  });

  it("parses 'deleted 1 topic'", () => {
    expect(parseOutcomesFromResponse("deleted 1 topic").topicsDeleted).toBe(1);
  });

  it("parses all counts from a realistic multi-line response", () => {
    const response = `
      Sleep cycle complete.
      Consolidated 2 files into one.
      Pruned 18 messages from old sessions.
      Removed 3 embeddings that were no longer needed.
      Cleaned 1 session directory.
      Merged 2 topics about work.
      Deleted 1 topic (duplicate).
    `;
    const r = parseOutcomesFromResponse(response);
    expect(r.filesConsolidated).toBe(2);
    expect(r.messagesPruned).toBe(18);
    expect(r.embeddingsRemoved).toBe(3);
    expect(r.sessionsCleaned).toBe(1);
    expect(r.topicsMerged).toBe(2);
    expect(r.topicsDeleted).toBe(1);
  });

  it("handles 'N noun verb' ordering as well as 'verb N noun'", () => {
    expect(parseOutcomesFromResponse("5 files consolidated").filesConsolidated).toBe(5);
    expect(parseOutcomesFromResponse("12 messages pruned").messagesPruned).toBe(12);
  });

  it("handles key:N label format", () => {
    expect(parseOutcomesFromResponse("files consolidated: 6").filesConsolidated).toBe(6);
  });

  it("returns 0 for unrecognised keys", () => {
    const r = parseOutcomesFromResponse("nothing relevant happened today");
    expect(r.filesConsolidated).toBe(0);
    expect(r.messagesPruned).toBe(0);
  });

  it("case-insensitive matching", () => {
    expect(parseOutcomesFromResponse("PRUNED 10 MESSAGES").messagesPruned).toBe(10);
    expect(parseOutcomesFromResponse("CONSOLIDATED 3 FILES").filesConsolidated).toBe(3);
  });

  it("does not parse negative numbers", () => {
    // parseInt("-3") is negative — the check isNaN catches that it's valid,
    // but the parseInt returns -3. The code only skips NaN, not negatives.
    // Documenting actual behavior: negative inputs pass through as-is.
    // This test is descriptive, not normative.
    const r = parseOutcomesFromResponse("pruned -3 messages");
    // The regex \d+ doesn't match negative numbers — so 0 is expected
    expect(r.messagesPruned).toBe(0);
  });
});

// ── buildSnapshotSummary ─────────────────────────────────────────────────────

describe("buildSnapshotSummary", () => {
  const makeSnapshot = (overrides: Partial<StateSnapshot> = {}): StateSnapshot =>
    ({
      workingDirs: ["dir1", "dir2"],
      dbStats: { messageCount: 150, embeddingCount: 40, extractedMemoryCount: 25 },
      diskUsageBytes: 5 * 1024 * 1024,
      diskBudgetBytes: 100 * 1024 * 1024,
      topicFiles: ["t1.md", "t2.md", "t3.md"],
      fts5Health: { messages_fts: true, extracted_memories_fts: true, extracted_memories_original_fts: true },
      ...overrides,
    }) as unknown as StateSnapshot;

  it("includes working dir count", () => {
    expect(buildSnapshotSummary(makeSnapshot())).toContain("Working dirs: 2");
  });

  it("includes message count", () => {
    expect(buildSnapshotSummary(makeSnapshot())).toContain("Messages: 150");
  });

  it("includes embedding count", () => {
    expect(buildSnapshotSummary(makeSnapshot())).toContain("Embeddings: 40");
  });

  it("includes extracted memory count", () => {
    expect(buildSnapshotSummary(makeSnapshot())).toContain("Extracted memories: 25");
  });

  it("includes disk usage in MB", () => {
    const s = buildSnapshotSummary(makeSnapshot());
    expect(s).toContain("Disk:");
    expect(s).toContain("MB");
  });

  it("includes topic file count", () => {
    expect(buildSnapshotSummary(makeSnapshot())).toContain("Topics: 3");
  });

  it("includes FTS5 health", () => {
    const s = buildSnapshotSummary(makeSnapshot());
    expect(s).toContain("FTS5:");
    expect(s).toContain("messages=true");
  });
});
