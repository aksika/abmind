/**
 * mcp-connection.test.ts — MCP connection helpers (#1384).
 *
 * Small deterministic tests for the adapter's pure boundary: identifier
 * validation, idempotency-key derivation (payload excluded by
 * construction), outbox namespace stability/isolation, and principal
 * resolution rules. Transport/lease behavior is proved at the acceptance
 * boundary, not here.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import {
  validateInstanceId, validatePrincipal, validateOperationId,
  deriveIdempotencyKey, mcpOutboxNamespace, mcpOutboxFilePath,
  resolveMcpPrincipal,
} from "./mcp-connection.js";

describe("mcp-connection helpers", () => {
  let savedUser: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedUser = process.env["ABMIND_USER_ID"];
    savedHome = process.env["ABMIND_HOME"];
    delete process.env["ABMIND_USER_ID"];
    process.env["ABMIND_HOME"] = mkdtempSync(join(tmpdir(), "mcp-conn-home-"));
  });

  afterEach(() => {
    rmSync(process.env["ABMIND_HOME"]!, { recursive: true, force: true });
    if (savedUser === undefined) delete process.env["ABMIND_USER_ID"];
    else process.env["ABMIND_USER_ID"] = savedUser;
    if (savedHome === undefined) delete process.env["ABMIND_HOME"];
    else process.env["ABMIND_HOME"] = savedHome;
  });

  it("validates instance ids as bounded names, never paths", () => {
    expect(validateInstanceId("local")).toBe("local");
    expect(validateInstanceId("host-1.alpha_2")).toBe("host-1.alpha_2");
    expect(() => validateInstanceId("")).toThrow();
    expect(() => validateInstanceId("../escape")).toThrow();
    expect(() => validateInstanceId("a/b")).toThrow();
    expect(() => validateInstanceId("x".repeat(65))).toThrow();
  });

  it("validates principals without guessing one", () => {
    expect(validatePrincipal("  alice  ")).toBe("alice");
    expect(() => validatePrincipal("")).toThrow();
    expect(() => validatePrincipal("bad\x01id")).toThrow();
  });

  it("validates operation ids as 1-128 characters", () => {
    expect(validateOperationId("op-1")).toBe("op-1");
    expect(() => validateOperationId("")).toThrow();
    expect(() => validateOperationId("x".repeat(129))).toThrow();
  });

  it("derives a stable bounded key from instance, principal, tool and operation id", () => {
    const a = deriveIdempotencyKey("host-1", "alice", "memory_store", "op-1");
    expect(deriveIdempotencyKey("host-1", "alice", "memory_store", "op-1")).toBe(a);
    expect(a.length).toBeLessThanOrEqual(128);
    expect(deriveIdempotencyKey("host-2", "alice", "memory_store", "op-1")).not.toBe(a);
    expect(deriveIdempotencyKey("host-1", "bob", "memory_store", "op-1")).not.toBe(a);
    expect(deriveIdempotencyKey("host-1", "alice", "memory_edit", "op-1")).not.toBe(a);
    expect(deriveIdempotencyKey("host-1", "alice", "memory_store", "op-2")).not.toBe(a);
  });

  it("namespaces remote outboxes stably and isolates distinct configurations", () => {
    const a = mcpOutboxNamespace("host-1", "alice", "wss://x:1", "peer-1", "pin-1");
    expect(mcpOutboxNamespace("host-1", "alice", "wss://x:1", "peer-1", "pin-1")).toEqual(a);
    expect(mcpOutboxNamespace("host-2", "alice", "wss://x:1", "peer-1", "pin-1").namespace).not.toBe(a.namespace);
    expect(mcpOutboxNamespace("host-1", "bob", "wss://x:1", "peer-1", "pin-1").namespace).not.toBe(a.namespace);
    const file = mcpOutboxFilePath(a.namespace);
    expect(dirname(file)).toMatch(/remote[\\/]outbox$/);
    expect(basename(file)).toBe(`mcp-${a.namespace}.json`);
    expect(basename(file)).not.toContain("..");
  });

  it("resolves principals: explicit wins, remote requires explicit, local falls back to env", () => {
    expect(resolveMcpPrincipal("local", "  alice  ")).toBe("alice");
    expect(resolveMcpPrincipal("remote", "alice")).toBe("alice");
    expect(() => resolveMcpPrincipal("remote")).toThrow(/--principal/);
    process.env["ABMIND_USER_ID"] = "env-user";
    expect(resolveMcpPrincipal("local")).toBe("env-user");
  });

  it("refuses to guess a local principal with nothing configured", () => {
    expect(() => resolveMcpPrincipal("local")).toThrow();
  });
});
