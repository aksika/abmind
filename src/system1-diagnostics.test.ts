/**
 * #1812 — System One doctor checks. Real MemoryManager over a temp dir;
 * only the provider HTTP boundary is stubbed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import { runDiagnostics } from "./operator-diagnostics.js";
import type { DoctorCheckResult } from "./abmind-protocol.js";
import { initAbmindEnv, _resetAbmindEnv } from "./env-schema.js";

const ENV_KEYS = [
  "SYSTEM1", "SYSTEM1_RECALL", "SYSTEM1_FASTPATH", "SYSTEM1_TIMEOUT_MS", "SYSTEM1_MAX_CANDIDATES",
  "JEV_URL", "JEV_API_KEY", "JEV_MODEL", "LAYA_URL",
];

function find(checks: DoctorCheckResult[], id: string): DoctorCheckResult {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`missing check ${id}`);
  return c;
}

describe("#1812 — system1 doctor checks", () => {
  let saved: Record<string, string | undefined>;
  let tmpDir: string;
  let mm: MemoryManager | null = null;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    _resetAbmindEnv();
    tmpDir = mkdtempSync(join(tmpdir(), "mm-sys1-"));
  });

  afterEach(() => {
    mm?.close();
    mm = null;
    rmSync(tmpDir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    _resetAbmindEnv();
    vi.restoreAllMocks();
  });

  async function initManager(): Promise<MemoryManager> {
    initAbmindEnv();
    mm = new MemoryManager(makeMemoryTestConfig(tmpDir));
    await mm.initialize({ skipEmbeddingCheck: true });
    return mm;
  }

  function messages(checks: DoctorCheckResult[]): string {
    return JSON.stringify(checks.map((c) => `${c.id}:${c.status}:${c.message}`));
  }

  it("reports disabled with no network when off", async () => {
    process.env.SYSTEM1 = "off";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const manager = await initManager();
    const checks = await runDiagnostics({ manager, memoryDir: tmpDir });
    expect(find(checks, "system1-config")).toMatchObject({ status: "ok" });
    expect(find(checks, "system1-reachable")).toMatchObject({ status: "skip" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("falls back to no provider on default boot with no sidecar (A15)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const manager = await initManager();
    expect(manager.getJudgmentProvider()).toBeNull();
  });

  it("creates a provider on default boot when the sidecar is reachable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ status: "ready", model: "convaiinnovations/laya", contractVersion: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const manager = await initManager();
    expect(manager.getJudgmentProvider()?.name).toBe("laya");
  });

  it("falls back on explicit laya with a down sidecar", async () => {
    process.env.SYSTEM1 = "laya";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const manager = await initManager();
    expect(manager.getJudgmentProvider()).toBeNull();
    const checks = await runDiagnostics({ manager, memoryDir: tmpDir });
    expect(find(checks, "system1-reachable").status).toBe("warn");
  });

  it("validates a healthy laya sidecar with model identity", async () => {
    process.env.SYSTEM1 = "laya";
    // Fresh Response per call: boot probe and doctor each read the body once.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ status: "ready", model: "convaiinnovations/laya", contractVersion: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const manager = await initManager();
    expect(manager.getJudgmentProvider()?.name).toBe("laya");
    const checks = await runDiagnostics({ manager, memoryDir: tmpDir });
    expect(find(checks, "system1-config").message).toContain("127.0.0.1:8765");
    const reach = find(checks, "system1-reachable");
    expect(reach.status).toBe("ok");
    expect(reach.message).toContain("convaiinnovations/laya");
  });

  it("reports only the active backend's profiles when fastpath is on", async () => {
    process.env.SYSTEM1 = "laya";
    process.env.SYSTEM1_FASTPATH = "on";
    // Fresh Response per call: boot probe and doctor each read the body once.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ status: "ready", model: "convaiinnovations/laya", contractVersion: 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));
    const manager = await initManager();
    const fastpath = find(await runDiagnostics({ manager, memoryDir: tmpDir }), "system1-fastpath");
    expect(fastpath.status).toBe("ok");
    expect(fastpath.message).toContain("laya/* attribution-v1 advisory");
    expect(fastpath.message).not.toContain("jev");
  });

  it("warns on a down sidecar with the endpoint host, no secrets", async () => {
    process.env.SYSTEM1 = "laya";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const manager = await initManager();
    const checks = await runDiagnostics({ manager, memoryDir: tmpDir });
    const reach = find(checks, "system1-reachable");
    expect(reach.status).toBe("warn");
    expect(reach.message).toContain("127.0.0.1:8765");
    expect(reach.message).toContain("laya-server.py");
  });

  it("reports warming, contract mismatch, and malformed payloads distinctly", async () => {
    process.env.SYSTEM1 = "laya";
    // Fresh Response per call: boot probe and doctor each read the body once.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("", { status: 503 }));
    const manager = await initManager();
    const warming = find(await runDiagnostics({ manager, memoryDir: tmpDir }), "system1-reachable");
    expect(warming.status).toBe("warn");
    expect(warming.message).toContain("warming");

    fetchSpy.mockImplementation(async () => new Response(
      JSON.stringify({ status: "ready", model: "convaiinnovations/laya", contractVersion: 2 }),
      { status: 200 },
    ));
    const mismatch = find(await runDiagnostics({ manager, memoryDir: tmpDir }), "system1-reachable");
    expect(mismatch.status).toBe("warn");
    expect(mismatch.message).toContain("contract mismatch");

    fetchSpy.mockImplementation(async () => new Response("not json", { status: 200 }));
    const malformed = find(await runDiagnostics({ manager, memoryDir: tmpDir }), "system1-reachable");
    expect(malformed.status).toBe("warn");
    expect(malformed.message).toContain("malformed");
  });

  it("warns on jev without a key and probes nothing", async () => {
    process.env.SYSTEM1 = "jev";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const manager = await initManager();
    expect(manager.getJudgmentProvider()).toBeNull();
    const checks = await runDiagnostics({ manager, memoryDir: tmpDir });
    expect(find(checks, "system1-config").status).toBe("warn");
    expect(find(checks, "system1-config").message).toContain("JEV_API_KEY");
    expect(find(checks, "system1-reachable").status).toBe("skip");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("probes jev exactly once and validates the typed answer and model", async () => {
    process.env.SYSTEM1 = "jev";
    process.env.JEV_API_KEY = "sk-test-key";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        model: "jev-1.13.0",
        answers: { ping: { type: "noul", noul: 0.99 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    } as unknown as Response);
    const manager = await initManager();
    const checks = await runDiagnostics({ manager, memoryDir: tmpDir });
    const reach = find(checks, "system1-reachable");
    expect(reach.status).toBe("ok");
    expect(reach.message).toContain("jev-1.13.0");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string) as Record<string, unknown>;
    expect(Object.keys(body["questions"] as Record<string, unknown>)).toEqual(["ping"]);
  });

  it("warns with the failure class on jev 401", async () => {
    process.env.SYSTEM1 = "jev";
    process.env.JEV_API_KEY = "sk-wrong-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false, status: 401, headers: new Headers(), text: async () => "nope",
    } as unknown as Response);
    const manager = await initManager();
    const checks = await runDiagnostics({ manager, memoryDir: tmpDir });
    const reach = find(checks, "system1-reachable");
    expect(reach.status).toBe("warn");
    expect(reach.message).toContain("unauthorized");
    expect(messages(checks)).not.toContain("sk-wrong-key");
  });
});
