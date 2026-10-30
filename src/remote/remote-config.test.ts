import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadGrants, loadGrantsWithDrops } from "./remote-config.js";
import type { RemoteGrantV1 } from "./remote-config.js";
import { resolveRemoteContext, isMethodAllowed } from "./remote-policy.js";
import { METHOD_REGISTRY, type AbmindMethod } from "../abmind-protocol.js";

let tmpRoot: string;
let remoteDir: string;

function writeRestricted(name: string, data: unknown): void {
  const p = join(remoteDir, name);
  writeFileSync(p, JSON.stringify(data, null, 2));
  chmodSync(p, 0o600);
}

function grant(peerId: string, methods: string[], extra?: Record<string, unknown>): RemoteGrantV1 {
  return {
    peerId,
    principalId: "principal-1",
    domains: ["system", "private", "operational"],
    methods: methods as unknown as AbmindMethod[],
    capabilities: [],
    ...extra,
  } as RemoteGrantV1;
}

function enroll(peerId: string): { peerId: string; verifyKey: string; enrolledAt: string } {
  return { peerId, verifyKey: `verify-key-for-${peerId}`, enrolledAt: new Date().toISOString() };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "remote-config-test-"));
  remoteDir = join(tmpRoot, "remote");
  mkdirSync(remoteDir, { recursive: true });
  process.env["ABMIND_REMOTE_DIR"] = remoteDir;
});

afterEach(() => {
  delete process.env["ABMIND_REMOTE_DIR"];
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadGrantsWithDrops (#1948)", () => {
  it("drops an unknown method but keeps the grant's known methods", () => {
    writeRestricted("enrollments.json", [enroll("peer-a")]);
    writeRestricted("grants.json", [
      grant("peer-a", ["private.recall", "private.attribution", "private.instantStore"]),
    ]);

    const { grants, drops } = loadGrantsWithDrops([{ peerId: "peer-a", verifyKey: "v", enrolledAt: "t" }]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.methods).toEqual(["private.recall", "private.instantStore"]);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.peerId).toBe("peer-a");
    expect(drops[0]?.method).toBe("private.attribution");

    // Backward compat: loadGrants returns the same pruned grants.
    expect(loadGrants([{ peerId: "peer-a", verifyKey: "v", enrolledAt: "t" }])).toEqual(grants);
  });

  it("drops a malformed entry while other peers still load", () => {
    writeRestricted("enrollments.json", [enroll("peer-a"), enroll("peer-b")]);
    writeRestricted("grants.json", [
      grant("peer-a", ["private.recall"]),
      { peerId: "peer-b" },
    ]);

    const enrollments = [enroll("peer-a"), enroll("peer-b")].map(e => ({ ...e }));
    const { grants, drops } = loadGrantsWithDrops(enrollments);
    expect(grants.map(g => g.peerId)).toEqual(["peer-a"]);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.peerId).toBe("peer-b");
    expect(drops[0]?.method).toBeUndefined();
  });

  it("drops a grant for an unenrolled peer", () => {
    writeRestricted("enrollments.json", [enroll("peer-a")]);
    writeRestricted("grants.json", [
      grant("peer-a", ["private.recall"]),
      grant("peer-ghost", ["private.recall"]),
    ]);

    const { grants, drops } = loadGrantsWithDrops([enroll("peer-a")]);
    expect(grants.map(g => g.peerId)).toEqual(["peer-a"]);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.peerId).toBe("peer-ghost");
  });

  it("drops a grant with a bad privateUserId", () => {
    writeRestricted("enrollments.json", [enroll("peer-a")]);
    writeRestricted("grants.json", [
      grant("peer-a", ["private.recall"], { privateUserId: 42 }),
    ]);

    const { grants, drops } = loadGrantsWithDrops([enroll("peer-a")]);
    expect(grants).toHaveLength(0);
    expect(drops).toHaveLength(1);
    expect(drops[0]?.peerId).toBe("peer-a");
  });

  it("an emptied grant denies every method and never means all methods", () => {
    writeRestricted("enrollments.json", [enroll("peer-a")]);
    writeRestricted("grants.json", [grant("peer-a", ["private.attribution"])]);

    const { grants, drops } = loadGrantsWithDrops([enroll("peer-a")]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.methods).toEqual([]);
    expect(drops).toHaveLength(1);

    const context = resolveRemoteContext(grants[0]!, "signed_peer");
    expect(context.allowedMethods).toBeDefined();
    expect(context.allowedMethods?.size).toBe(0);
    for (const method of Object.keys(METHOD_REGISTRY) as AbmindMethod[]) {
      expect(isMethodAllowed(method, context)).toBe(false);
    }
  });

  it("keeps a valid peer untouched while pruning another peer's unknown method", () => {
    writeRestricted("enrollments.json", [enroll("peer-a"), enroll("peer-b")]);
    writeRestricted("grants.json", [
      grant("peer-a", ["private.recall", "private.adjustRelevance"]),
      grant("peer-b", ["system.status", "private.merge"]),
    ]);

    const { grants, drops } = loadGrantsWithDrops([enroll("peer-a"), enroll("peer-b")]);
    expect(grants).toHaveLength(2);
    expect(grants.find(g => g.peerId === "peer-a")?.methods).toEqual(["private.recall"]);
    expect(grants.find(g => g.peerId === "peer-b")?.methods).toEqual(["system.status", "private.merge"]);
    expect(drops).toHaveLength(1);
  });

  it("file-level problems still throw", () => {
    // Malformed JSON.
    const badPath = join(remoteDir, "grants.json");
    writeFileSync(badPath, "{ not json");
    chmodSync(badPath, 0o600);
    expect(() => loadGrantsWithDrops([])).toThrow();

    // Not an array.
    writeRestricted("grants.json", { peerId: "peer-a" });
    expect(() => loadGrantsWithDrops([])).toThrow("must be an array");
  });

  it("a missing file loads empty with no drops", () => {
    writeRestricted("enrollments.json", [enroll("peer-a")]);
    const { grants, drops } = loadGrantsWithDrops([enroll("peer-a")]);
    expect(grants).toEqual([]);
    expect(drops).toEqual([]);
  });
});
