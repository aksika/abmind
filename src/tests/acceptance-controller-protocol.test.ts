/**
 * acceptance-controller-protocol.test.ts — #1528 focused protocol tests for
 * the consumer fixture controller contract. These run in the fast unit suite
 * (no build artifacts, no daemon spawn).
 */

import { describe, expect, it } from "vitest";
import {
  parseFixtureCommand,
  parseConsumerFixtureDescriptor,
} from "../../tests/acceptance/contracts.js";

describe("parseFixtureCommand", () => {
  it("accepts a valid describe command", () => {
    const result = parseFixtureCommand({ version: 1, id: "abc", command: "describe" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command).toEqual({ version: 1, id: "abc", command: "describe" });
    }
  });

  it("accepts conversationRows with bounded fields", () => {
    const result = parseFixtureCommand({ version: 1, id: "r1", command: "conversationRows", userId: "e2e-user-a", since: 0, limit: 50 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.command.command).toBe("conversationRows");
    }
  });

  it("rejects unsupported versions", () => {
    const result = parseFixtureCommand({ version: 2, id: "a", command: "describe" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unsupported_version");
  });

  it("rejects unknown commands", () => {
    const result = parseFixtureCommand({ version: 1, id: "a", command: "rm -rf" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("unknown_command");
  });

  it("rejects missing or oversized ids", () => {
    expect(parseFixtureCommand({ version: 1, command: "describe" }).ok).toBe(false);
    expect(parseFixtureCommand({ version: 1, id: "", command: "describe" }).ok).toBe(false);
    expect(parseFixtureCommand({ version: 1, id: "x".repeat(129), command: "describe" }).ok).toBe(false);
  });

  it("rejects invalid conversationRows field types and bounds", () => {
    expect(parseFixtureCommand({ version: 1, id: "a", command: "conversationRows", userId: "", since: 0, limit: 1 }).ok).toBe(false);
    expect(parseFixtureCommand({ version: 1, id: "a", command: "conversationRows", userId: "u", since: -1, limit: 1 }).ok).toBe(false);
    expect(parseFixtureCommand({ version: 1, id: "a", command: "conversationRows", userId: "u", since: 0, limit: 0 }).ok).toBe(false);
    expect(parseFixtureCommand({ version: 1, id: "a", command: "conversationRows", userId: "u", since: 0, limit: 201 }).ok).toBe(false);
  });

  it("rejects non-object input and non-string commands", () => {
    expect(parseFixtureCommand(null).ok).toBe(false);
    expect(parseFixtureCommand([1, 2]).ok).toBe(false);
    expect(parseFixtureCommand("describe").ok).toBe(false);
  });

  it("rejects oversized stage", () => {
    expect(parseFixtureCommand({ version: 1, id: "a", command: "copyFailureArtifacts", stage: "x".repeat(129) }).ok).toBe(false);
  });
});

describe("parseConsumerFixtureDescriptor", () => {
  it("accepts a valid local descriptor", () => {
    const result = parseConsumerFixtureDescriptor({
      version: 1,
      lane: "local-unix",
      runId: "run-1",
      principalId: "e2e-user-a",
      connection: { mode: "local", socketPath: "/tmp/x/abmind.sock" },
      endpointFingerprint: "local-abc123",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a valid wss descriptor", () => {
    const result = parseConsumerFixtureDescriptor({
      version: 1,
      lane: "remote-wss",
      runId: "run-1",
      principalId: "e2e-user-a",
      connection: { mode: "wss", url: "wss://127.0.0.1:1234", peerId: "user-a", signingKeyPath: "/tmp/x/key.pem", serverCertSha256: "a".repeat(64) },
      endpointFingerprint: "wss-abc",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects malformed descriptors", () => {
    expect(parseConsumerFixtureDescriptor(null).ok).toBe(false);
    expect(parseConsumerFixtureDescriptor({ version: 1, lane: "bogus", runId: "r", principalId: "p", connection: { mode: "local", socketPath: "/x" }, endpointFingerprint: "f" }).ok).toBe(false);
    expect(parseConsumerFixtureDescriptor({ version: 1, lane: "local-unix", runId: "r", principalId: "p", connection: { mode: "tcp", port: 1 }, endpointFingerprint: "f" }).ok).toBe(false);
    expect(parseConsumerFixtureDescriptor({ version: 1, lane: "local-unix", runId: "r", principalId: "p", connection: { mode: "local", socketPath: "" }, endpointFingerprint: "f" }).ok).toBe(false);
    expect(parseConsumerFixtureDescriptor({ version: 1, lane: "local-unix", runId: "r", principalId: "p", connection: { mode: "local", socketPath: "/x" }, endpointFingerprint: "" }).ok).toBe(false);
  });

  it("never accepts key material in a descriptor", () => {
    const result = parseConsumerFixtureDescriptor({
      version: 1,
      lane: "remote-wss",
      runId: "run-1",
      principalId: "e2e-user-a",
      connection: { mode: "wss", url: "wss://127.0.0.1:1", peerId: "user-a", signingKeyPath: "/tmp/x/key.pem", serverCertSha256: "a".repeat(64) },
      endpointFingerprint: "wss-abc",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result.descriptor);
      expect(serialized).not.toContain("PRIVATE KEY");
    }
  });
});
