import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const DISPATCHER = join(__dirname, "../dist/cli/abmind.js");

function run(args: string[], env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("node", [DISPATCHER, ...args], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("abmind operational CLI — --help smoke", () => {
  const cases: Array<[string, string[], string]> = [
    ["operational bare", ["operational"], "operational memory"],
    ["operational draft submit", ["operational", "draft", "submit"], "--lesson"],
    ["operational draft list", ["operational", "draft", "list"], "--status"],
    ["operational recall", ["operational", "recall"], "--query"],
    ["operational promote", ["operational", "promote"], "--draft-id"],
    ["operational reject", ["operational", "reject"], "--draft-id"],
    ["operational revise", ["operational", "revise"], "--memory-id"],
    ["operational retire", ["operational", "retire"], "--memory-id"],
    ["operational history", ["operational", "history"], "--memory-id"],
  ];

  for (const [name, cmdArgs, expectedText] of cases) {
    it(`${name} --help exits 0 and prints usage`, () => {
      const result = spawnSync("node", [DISPATCHER, ...cmdArgs, "--help"], {
        encoding: "utf8", timeout: 5000,
      });
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toContain(expectedText);
    });
  }
});

describe("abmind operational CLI — end-to-end lifecycle", () => {
  let tmpDir: string;
  let env: Record<string, string>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "op-cli-e2e-"));
    env = { ABMIND_HOME: tmpDir, MEMORY_ENABLED: "true", MEMORY_BACKEND: "sqlite" };
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("full lifecycle: submit → list → promote → recall → getMemory → revise → history → retire", () => {
    // 1. Submit a draft
    const submit1 = run([
      "operational", "draft", "submit",
      "--lesson", "Use focused test suites, not full regression, for CI speed",
      "--scope-level", "global",
      "--confidence", "85",
      "--json",
    ], env);
    expect(submit1.status).toBe(0);
    const draft1 = JSON.parse(submit1.stdout);
    expect(draft1.ok).toBe(true);
    expect(draft1.value.lesson).toContain("focused test suites");
    expect(draft1.value.status).toBe("draft");
    const draft1Id = draft1.value.id;
    expect(draft1Id).toBeTruthy();

    // 2. Submit a platform-scoped draft
    const submit2 = run([
      "operational", "draft", "submit",
      "--lesson", "Use linux hosts for integration tests",
      "--scope-level", "platform",
      "--platform", "linux",
      "--confidence", "90",
      "--json",
    ], env);
    expect(submit2.status).toBe(0);
    const draft2 = JSON.parse(submit2.stdout);
    expect(draft2.ok).toBe(true);
    const draft2Id = draft2.value.id;

    // 3. List drafts (no status filter — both)
    const list = run(["operational", "draft", "list", "--json"], env);
    expect(list.status).toBe(0);
    const listResult = JSON.parse(list.stdout);
    expect(listResult.ok).toBe(true);
    expect(listResult.value.items.length).toBeGreaterThanOrEqual(2);
    expect(listResult.value.nextCursor).toBeUndefined();

    // 4. List drafts by status
    const listDraft = run(["operational", "draft", "list", "--status", "draft", "--json"], env);
    expect(listDraft.status).toBe(0);
    const listDraftResult = JSON.parse(listDraft.stdout);
    expect(listDraftResult.ok).toBe(true);
    expect(listDraftResult.value.items.every((d: { status: string }) => d.status === "draft")).toBe(true);

    // 5. Promote the first draft
    const promote = run([
      "operational", "promote",
      "--draft-id", draft1Id,
      "--content", "Always use focused test suites for CI — full regression is too slow",
      "--actor-id", "reviewer",
      "--reason", "Agreed: focused suites are faster",
      "--json",
    ], env);
    expect(promote.status).toBe(0);
    const promoteResult = JSON.parse(promote.stdout);
    expect(promoteResult.ok).toBe(true);
    expect(promoteResult.value.status).toBe("active");
    expect(promoteResult.value.lesson).toContain("focused test suites");
    const memId = promoteResult.value.id;
    const memHash = promoteResult.value.contentHash;

    // 6. GetMemory
    const getMem = run(["operational", "history", "--memory-id", memId, "--json"], env);
    expect(getMem.status).toBe(0);
    const getMemResult = JSON.parse(getMem.stdout);
    expect(getMemResult.ok).toBe(true);
    expect(getMemResult.value.items.length).toBeGreaterThanOrEqual(1);

    // 7. Recall
    const recall = run([
      "operational", "recall",
      "--query", "focused test suites",
      "--json",
    ], env);
    expect(recall.status).toBe(0);
    const recallResult = JSON.parse(recall.stdout);
    expect(recallResult.ok).toBe(true);
    expect(recallResult.value.items.length).toBeGreaterThanOrEqual(1);
    expect(recallResult.value.items[0].lesson).toContain("focused test suites");
    expect(recallResult.value.nextCursor).toBeUndefined();

    // 8. Recall scoped (platform matches)
    const scopedRecall = run([
      "operational", "recall",
      "--platform", "linux",
      "--json",
    ], env);
    expect(scopedRecall.status).toBe(0);
    const scopedResult = JSON.parse(scopedRecall.stdout);
    expect(scopedResult.ok).toBe(true);
    // Should have: platform match first, then global
    expect(scopedResult.value.items.length).toBeGreaterThanOrEqual(1);

    // 9. Revise
    const revise = run([
      "operational", "revise",
      "--memory-id", memId,
      "--expected-hash", memHash,
      "--content", "Updated: Always use focused test suites in CI pipelines",
      "--scope-level", "global",
      "--confidence", "92",
      "--actor-id", "editor",
      "--reason", "Clarified wording",
      "--json",
    ], env);
    expect(revise.status).toBe(0);
    const reviseResult = JSON.parse(revise.stdout);
    expect(reviseResult.ok).toBe(true);
    expect(reviseResult.value.contentHash).not.toBe(memHash);
    const newHash = reviseResult.value.contentHash;

    // 10. History (should show both versions)
    const history = run(["operational", "history", "--memory-id", memId, "--json"], env);
    expect(history.status).toBe(0);
    const historyResult = JSON.parse(history.stdout);
    expect(historyResult.ok).toBe(true);
    expect(historyResult.value.items.length).toBe(2);

    // 11. Retire
    const retire = run([
      "operational", "retire",
      "--memory-id", memId,
      "--expected-hash", newHash,
      "--actor-id", "admin",
      "--reason", "Superseded by updated guidance",
      "--json",
    ], env);
    expect(retire.status).toBe(0);
    const retireResult = JSON.parse(retire.stdout);
    expect(retireResult.ok).toBe(true);
    expect(retireResult.value.status).toBe("retired");

    // 12. Recall after retire — memory should not appear
    const recallAfter = run([
      "operational", "recall",
      "--query", "focused test suites",
      "--json",
    ], env);
    expect(recallAfter.status).toBe(0);
    const recallAfterResult = JSON.parse(recallAfter.stdout);
    expect(recallAfterResult.ok).toBe(true);
    expect(recallAfterResult.value.items.length).toBe(0);
  });

  it("rejects with correct conflict shape when promoting an already-promoted draft", () => {
    const submit = run([
      "operational", "draft", "submit",
      "--lesson", "Draft for replay test",
      "--scope-level", "global",
      "--confidence", "50",
      "--json",
    ], env);
    expect(submit.status).toBe(0);
    const draft = JSON.parse(submit.stdout);
    expect(draft.ok).toBe(true);
    const draftId = draft.value.id;

    // Promote once
    const promote1 = run([
      "operational", "promote",
      "--draft-id", draftId,
      "--content", "Promoted content",
      "--actor-id", "agent",
      "--reason", "First promotion",
      "--json",
    ], env);
    expect(promote1.status).toBe(0);

    // Promote again — idempotent (same terminal state)
    const promote2 = run([
      "operational", "promote",
      "--draft-id", draftId,
      "--content", "Same content",
      "--actor-id", "agent",
      "--reason", "Replay",
      "--json",
    ], env);
    expect(promote2.status).toBe(0);
    const promote2Result = JSON.parse(promote2.stdout);
    expect(promote2Result.ok).toBe(true);

    // Reject after promote — conflict
    const reject = run([
      "operational", "reject",
      "--draft-id", draftId,
      "--rejected-by", "reviewer",
      "--reason", "Too late",
      "--json",
    ], env);
    expect(reject.status).toBe(1);
    const rejectResult = JSON.parse(reject.stdout);
    expect(rejectResult.ok).toBe(false);
    expect(rejectResult.error.code).toBe("conflict");
    expect(rejectResult.error.current.kind).toBe("draft");
    expect(rejectResult.error.current.status).toBe("promoted");
  });

  it("returns stale hash conflict on revise with wrong expected hash", () => {
    const submit = run([
      "operational", "draft", "submit",
      "--lesson", "Memory for stale test",
      "--scope-level", "global",
      "--confidence", "50",
      "--json",
    ], env);
    expect(submit.status).toBe(0);
    const draft = JSON.parse(submit.stdout);
    const draftId = draft.value.id;

    const promote = run([
      "operational", "promote",
      "--draft-id", draftId,
      "--content", "Original",
      "--actor-id", "agent",
      "--reason", "Create memory",
      "--json",
    ], env);
    expect(promote.status).toBe(0);
    const promoted = JSON.parse(promote.stdout);
    const memId = promoted.value.id;

    const revise = run([
      "operational", "revise",
      "--memory-id", memId,
      "--expected-hash", "0000wronghash",
      "--content", "Updated",
      "--scope-level", "global",
      "--confidence", "60",
      "--actor-id", "editor",
      "--reason", "Should fail",
      "--json",
    ], env);
    expect(revise.status).toBe(1);
    const reviseResult = JSON.parse(revise.stdout);
    expect(reviseResult.ok).toBe(false);
    expect(reviseResult.error.code).toBe("conflict");
    expect(reviseResult.error.current.kind).toBe("memory");
    expect(reviseResult.error.current.contentHash).toBeTruthy();
  });

  it("returns not_found for nonexistent memory in getHistory", () => {
    const result = run(["operational", "history", "--memory-id", "00000000-0000-0000-0000-000000000000", "--json"], env);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("not_found");
  });
});
