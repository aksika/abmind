/**
 * mcp-adapter-runner.ts — real MCP-to-owner acceptance for #1384.
 *
 * Evidence boundary: MCP client -> packaged stdio entry (dist/cli/abmind.js
 * mcp) -> real AbmindClient/transport -> scratch owner -> scratch SQLite.
 * Fixture external model/embedding services only (daemons run with
 * EMBEDDING_ENABLED=false). Covers narrow grants, mutation conflict and
 * replay, test-mode context and process cleanup at this boundary; detailed
 * fault matrices belong to the targeted transport tests.
 *
 * Run after build: node dist/tests/acceptance/mcp-adapter-runner.js
 * (not part of the default e2e lane; see test:e2e in package.json).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { strict as assert } from "node:assert";
import { AbmindClientError } from "../../src/abmind-client.js";
import { LocalDaemonFixture } from "./local-daemon-fixture.js";
import { RemoteWssFixture } from "./remote-wss-fixture.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Compiled layout is dist/tests/acceptance/; the repository root (with
// package.json and dist/) is three levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const ABMIND_ENTRY = join(REPO_ROOT, "dist", "cli", "abmind.js");
const PACKAGE_VERSION = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as { version: string }).version;

const CALL_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;

interface McpEnvelope {
  version: number;
  ok: boolean;
  operationId?: string;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean; action?: string; stage?: string; current?: unknown; requestId?: string };
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: CheckResult[] = [];

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: `${detail} (${Date.now() - start}ms)` });
    console.log(`ok   ${name} — ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name, ok: false, detail });
    console.log(`FAIL ${name} — ${detail}`);
  }
}

function mcpChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "NODE_PATH", "PATHEXT", "SystemRoot", "WINDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CI", "TERM"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const home = mkdtempSync(join(tmpdir(), "mcp-acc-home-"));
  env.HOME = home;
  env.USERPROFILE = home;
  env.ABMIND_HOME = join(home, ".abmind");
  env.EMBEDDING_ENABLED = "false";
  env.NODE_ENV = "test";
  return { ...env, ...extra };
}

class McpStdioClient {
  private child: ChildProcess;
  private seq = 0;
  private buf = "";
  private pending = new Map<number, { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  stdoutLines: string[] = [];
  stdoutPolluted = false;
  stderr = "";
  private exitPromise: Promise<number | null>;

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    this.child = spawn(process.execPath, [ABMIND_ENTRY, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout!.on("data", (chunk: Buffer) => this.onStdout(chunk.toString("utf-8")));
    this.child.stderr!.on("data", (chunk: Buffer) => { this.stderr += chunk.toString("utf-8"); });
    this.exitPromise = new Promise((resolve) => {
      this.child.on("exit", (code) => {
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error("MCP child exited before responding"));
        }
        this.pending.clear();
        resolve(code);
      });
    });
  }

  private onStdout(text: string): void {
    this.buf += text;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      this.stdoutLines.push(line);
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.stdoutPolluted = true;
        continue;
      }
      if (typeof msg["id"] === "number" && this.pending.has(msg["id"] as number)) {
        const p = this.pending.get(msg["id"] as number)!;
        this.pending.delete(msg["id"] as number);
        clearTimeout(p.timer);
        p.resolve(msg);
      }
      // Notifications/requests from the server are drained, never answered.
    }
  }

  send(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = ++this.seq;
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${CALL_TIMEOUT_MS}ms`));
      }, CALL_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin!.write(`${line}\n`, (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<Record<string, unknown>> {
    const res = await this.send("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "mcp-accept", version: "1" },
    });
    this.notify("notifications/initialized");
    if (res["error"]) throw new Error(`initialize failed: ${JSON.stringify(res["error"]).slice(0, 200)}`);
    return res["result"] as Record<string, unknown>;
  }

  async listTools(): Promise<Array<{ name: string }>> {
    const res = await this.send("tools/list");
    if (res["error"]) throw new Error(`tools/list failed: ${JSON.stringify(res["error"]).slice(0, 200)}`);
    return ((res["result"] as Record<string, unknown>)["tools"] ?? []) as Array<{ name: string }>;
  }

  async callTool(name: string, args: unknown): Promise<{ envelope?: McpEnvelope; isError?: boolean; raw: Record<string, unknown> }> {
    const res = await this.send("tools/call", { name, arguments: args });
    const result = res["result"] as Record<string, unknown> | undefined;
    if (!result) return { raw: res };
    const structured = result["structuredContent"] as McpEnvelope | undefined;
    return { envelope: structured, isError: result["isError"] as boolean | undefined, raw: res };
  }

  closeStdin(): void {
    try { this.child.stdin!.end(); } catch { /* already closed */ }
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    try { this.child.kill(signal); } catch { /* already exited */ }
  }

  waitForExit(timeoutMs = EXIT_TIMEOUT_MS): Promise<number | null> {
    const timeout = new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), timeoutMs);
      t.unref?.();
    });
    return Promise.race([this.exitPromise, timeout]);
  }
}

function requireEnvelope(call: { envelope?: McpEnvelope; isError?: boolean; raw: Record<string, unknown> }, what: string): McpEnvelope {
  assert.ok(call.envelope, `${what}: missing structured envelope (raw ${JSON.stringify(call.raw).slice(0, 200)})`);
  assert.equal(call.envelope.version, 1, `${what}: envelope version`);
  return call.envelope;
}

async function spawnExpectExit(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [ABMIND_ENTRY, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();
  const code = await new Promise<number | null>((resolve) => {
    const t = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* noop */ } resolve(null); }, EXIT_TIMEOUT_MS);
    t.unref?.();
    child.on("exit", (c) => { clearTimeout(t); resolve(c); });
  });
  return { code, stdout, stderr };
}

const MARKER = "mcp-accept-tangerine-9417";

async function localLane(): Promise<void> {
  console.log("--- local lane ---");
  const fixture = new LocalDaemonFixture();
  const homes: string[] = [];
  const trackHome = (env: NodeJS.ProcessEnv): void => {
    if (env.HOME) homes.push(env.HOME);
  };
  try {
    await fixture.startOwner();

    await check("local/startup-diagnostics", async () => {
      const env = mcpChildEnv();
      trackHome(env);
      // Mutually exclusive options.
      let r = await spawnExpectExit(["mcp", "--local", fixture.socketPath, "--remote", "x"], env);
      assert.notEqual(r.code, 0, "exclusive options must fail");
      assert.ok(r.stderr.length > 0, "stderr diagnostic");
      assert.equal(r.stdout, "", "no stray stdout");
      // Unavailable owner.
      r = await spawnExpectExit(["mcp", "--local", join(fixture.root, "run", "no-such.sock"), "--principal", "e2e-user-a"], env);
      assert.notEqual(r.code, 0, "unavailable owner must fail");
      assert.ok(r.stderr.length > 0, "stderr diagnostic");
      assert.equal(r.stdout, "", "no stray stdout");
      // Unknown remote profile.
      const env2 = mcpChildEnv({ ABMIND_REMOTE_DIR: join(fixture.root, "empty-remote") });
      trackHome(env2);
      r = await spawnExpectExit(["mcp", "--remote", "nope", "--principal", "e2e-user-a", "--instance-id", "x"], env2);
      assert.notEqual(r.code, 0, "unknown profile must fail");
      assert.equal(r.stdout, "", "no stray stdout");
      return "exclusive/unavailable/profile failures are bounded on stderr";
    });

    const env = mcpChildEnv();
    trackHome(env);
    const mcp = new McpStdioClient(
      ["mcp", "--local", fixture.socketPath, "--principal", "e2e-user-a", "--instance-id", "mcp-local-1"], env,
    );

    await check("local/initialize-list", async () => {
      const init = await mcp.initialize();
      const serverInfo = init["serverInfo"] as Record<string, unknown>;
      assert.equal(serverInfo["name"], "abmind");
      assert.equal(serverInfo["version"], PACKAGE_VERSION, "adapter advertises the actual package version");
      const names = (await mcp.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["memory_context", "memory_edit", "memory_recall", "memory_status", "memory_store"]);
      assert.equal(mcp.stdoutPolluted, false, "stdout carries MCP frames only");
      return `5 tools, version ${serverInfo["version"]}`;
    });

    let memoryId = 0;
    let revision = 0;

    await check("local/round-trip", async () => {
      const stored = requireEnvelope(await mcp.callTool("memory_store", {
        text: `The ${MARKER} protocol uses five tools`, memoryType: "fact", operationId: "mcp-acc-store-1",
      }), "store");
      assert.equal(stored.ok, true, `store ok (${JSON.stringify(stored.error)?.slice(0, 200)})`);
      assert.equal(stored.operationId, "mcp-acc-store-1", "operation id carried top-level");
      const receipt = stored.result as Record<string, unknown>;
      assert.equal(receipt["stored"], true);
      memoryId = receipt["memoryId"] as number;
      revision = receipt["semanticRevision"] as number;
      assert.ok(memoryId > 0 && revision > 0, "actual receipt with id/revision");

      const recalled = requireEnvelope(await mcp.callTool("memory_recall", { keywords: [MARKER], limit: 5 }), "recall");
      assert.equal(recalled.ok, true);
      const hits = (recalled.result as Record<string, unknown>)["hits"] as Array<Record<string, unknown>>;
      assert.ok(hits.length >= 1, "explicit recall finds the stored fact");
      assert.ok(hits.some((h) => h["id"] === memoryId && h["revision"] === revision), "eligible hit carries id/revision refs");

      const edited = requireEnvelope(await mcp.callTool("memory_edit", {
        memoryId, expectedRevision: revision, action: "boost", operationId: "mcp-acc-edit-1",
      }), "edit");
      assert.equal(edited.ok, true);
      assert.equal(edited.operationId, "mcp-acc-edit-1");
      revision = ((edited.result as Record<string, unknown>)["ref"] as Record<string, unknown>)["semanticRevision"] as number;

      const status = requireEnvelope(await mcp.callTool("memory_status", {}), "status");
      assert.equal(status.ok, true);
      const sres = status.result as Record<string, unknown>;
      assert.equal((sres["connection"] as Record<string, unknown>)["mode"], "local");
      assert.ok("outbox" in sres === false, "local mode reports no outbox");

      const ctx = requireEnvelope(await mcp.callTool("memory_context", {}), "context");
      assert.equal(ctx.ok, true);
      const cres = ctx.result as Record<string, unknown>;
      assert.equal(cres["memoryTest"], false);
      assert.ok((cres["text"] as string).length > 0, "owner-composed context is non-empty");
      return `store/recall/edit/status/context round trip (memory ${memoryId})`;
    });

    await check("local/idempotency-conflict", async () => {
      const again = requireEnvelope(await mcp.callTool("memory_store", {
        text: `The ${MARKER} protocol uses five tools`, memoryType: "fact", operationId: "mcp-acc-store-1",
      }), "replay");
      assert.equal(again.ok, true, "same id + same payload converges");
      assert.equal((again.result as Record<string, unknown>)["memoryId"], memoryId, "no duplicate write");
      const conflict = requireEnvelope(await mcp.callTool("memory_store", {
        text: `The ${MARKER} protocol changed`, memoryType: "fact", operationId: "mcp-acc-store-1",
      }), "conflict");
      assert.equal(conflict.ok, false, "same id + changed input conflicts");
      assert.equal(conflict.error?.code, "idempotency_conflict");
      assert.equal(conflict.operationId, "mcp-acc-store-1");
      const stale = requireEnvelope(await mcp.callTool("memory_edit", {
        memoryId, expectedRevision: revision - 1 > 0 ? revision - 1 : 1, action: "demote", operationId: "mcp-acc-edit-stale",
      }), "stale");
      if (revision > 1) {
        assert.equal(stale.ok, false, "stale revision fails");
        assert.equal(stale.error?.code, "conflict");
        assert.ok(stale.error?.current, "conflict carries the current revision");
      }
      return "replay converges, changed input conflicts, stale revision reports current";
    });

    await check("local/input-validation", async () => {
      const cases: Array<[string, unknown]> = [
        ["memory_recall", { keywords: [MARKER], bogus: 1 }],
        ["memory_recall", { keywords: [MARKER], limit: 0 }],
        ["memory_recall", { keywords: [] }],
        ["memory_recall", { keywords: ["", "  "] }],
        ["memory_store", { text: "x", memoryType: "fact" }],
        ["memory_store", { text: "x", memoryType: "nope", operationId: "o" }],
        ["memory_edit", { memoryId: 1, expectedRevision: 1, action: "boost", operationId: "o", extra: true }],
        ["memory_status", { userId: "someone" }],
      ];
      for (const [tool, args] of cases) {
        const env2 = requireEnvelope(await mcp.callTool(tool, args), `${tool} validation`);
        assert.equal(env2.ok, false, `${tool} rejects invalid input`);
        assert.equal(env2.error?.code, "validation_error", `${tool} uses validation_error`);
      }
      return `${cases.length} invalid inputs rejected without clamping`;
    });

    await check("local/zero-hit", async () => {
      const zero = requireEnvelope(await mcp.callTool("memory_recall", { keywords: ["zzqq-no-such-memory-zzzz"] }), "zero-hit");
      assert.equal(zero.ok, true, "genuine zero-hit is success");
      assert.deepEqual((zero.result as Record<string, unknown>)["hits"], [], "empty hits, not a failed search");
      return "zero-hit success is distinguishable from failure";
    });

    await check("local/concurrent-hosts", async () => {
      const env2 = mcpChildEnv();
      trackHome(env2);
      const second = new McpStdioClient(
        ["mcp", "--local", fixture.socketPath, "--principal", "e2e-user-a", "--instance-id", "mcp-local-2"], env2,
      );
      try {
        await second.initialize();
        const names = (await second.listTools()).map((t) => t.name);
        assert.ok(names.includes("memory_status"), "second local host serves against one socket");
        const status = requireEnvelope(await second.callTool("memory_status", {}), "second status");
        assert.equal(status.ok, true);
      } finally {
        second.closeStdin();
        assert.equal(await second.waitForExit(), 0, "second host exits clean on EOF");
      }
      return "two local hosts share one socket without contending";
    });

    await check("local/memory-test-suppression", async () => {
      process.env["MEMORY_TEST"] = "ON";
      try {
        await fixture.restartOwner();
        const suppressed = requireEnvelope(await mcp.callTool("memory_context", {}), "suppressed context");
        assert.equal(suppressed.ok, true);
        const cres = suppressed.result as Record<string, unknown>;
        assert.equal(cres["memoryTest"], true);
        assert.ok(!(cres["text"] as string).includes(MARKER), "no memory-derived content under MEMORY_TEST");
        const recalled = requireEnvelope(await mcp.callTool("memory_recall", { keywords: [MARKER] }), "recall under test");
        assert.equal(recalled.ok, true, "explicit recall still retrieves");
        assert.ok(((recalled.result as Record<string, unknown>)["hits"] as unknown[]).length >= 1);
      } finally {
        delete process.env["MEMORY_TEST"];
        await fixture.restartOwner();
      }
      return "context suppressed, explicit recall intact";
    });

    mcp.closeStdin();
    await check("local/eof-clean-exit", async () => {
      assert.equal(await mcp.waitForExit(), 0, "EOF exits 0 after bounded drain");
      assert.equal(mcp.stdoutPolluted, false, "no stray stdout across the session");
      assert.ok(mcp.stderr.includes("shutting down"), "stderr carries the shutdown diagnostic");
      return "clean EOF shutdown with fenced output";
    });

    await check("local/sigterm-clean-exit", async () => {
      const env3 = mcpChildEnv();
      trackHome(env3);
      const third = new McpStdioClient(
        ["mcp", "--local", fixture.socketPath, "--principal", "e2e-user-a"], env3,
      );
      await third.initialize();
      third.kill("SIGTERM");
      assert.equal(await third.waitForExit(), 0, "SIGTERM exits 0");
      return "signal shutdown releases resources";
    });

    await check("local/restart-replay-convergence", async () => {
      // The same configured instance reopened after a clean exit must send
      // the identical wire payload for an exact retry (same operation id,
      // same input), so the owner ledger replays its completed receipt
      // instead of reporting a false idempotency conflict.
      const env4 = mcpChildEnv();
      trackHome(env4);
      const replay = new McpStdioClient(
        ["mcp", "--local", fixture.socketPath, "--principal", "e2e-user-a", "--instance-id", "mcp-local-1"], env4,
      );
      try {
        await replay.initialize();
        const again = requireEnvelope(await replay.callTool("memory_store", {
          text: `The ${MARKER} protocol uses five tools`, memoryType: "fact", operationId: "mcp-acc-store-1",
        }), "restart replay");
        assert.equal(again.ok, true, `exact retry converges after restart (${JSON.stringify(again.error)?.slice(0, 200)})`);
        assert.equal((again.result as Record<string, unknown>)["memoryId"], memoryId, "no duplicate write across restart");
      } finally {
        replay.closeStdin();
        await replay.waitForExit();
      }
      return "reopened instance replays the exact receipt";
    });
  } finally {
    await fixture.cleanup();
    for (const home of homes) {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

async function remoteLane(): Promise<void> {
  console.log("--- remote lane ---");
  const fixture = new RemoteWssFixture();
  const homes: string[] = [];
  try {
    await fixture.startOwner();
    // One shared isolated home for every remote-lane MCP host: the outbox
    // namespace lease is scoped to the user-level lease root, so duplicate
    // detection only contends when hosts share it (as same-user operators
    // do). Per-process homes would silently defeat the refusal proof.
    const sharedRemoteEnv = mcpChildEnv({ ABMIND_REMOTE_DIR: fixture.remoteDir });
    if (sharedRemoteEnv.HOME) homes.push(sharedRemoteEnv.HOME);
    const mcpEnv = (instanceExtra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
      ...sharedRemoteEnv,
      ...instanceExtra,
    });

    await check("remote/missing-identity-and-owner", async () => {
      let r = await spawnExpectExit(["mcp", "--remote", "user-a", "--instance-id", "mcp-rx"], mcpEnv());
      assert.notEqual(r.code, 0, "remote without principal must fail");
      assert.equal(r.stdout, "", "no stray stdout");
      await fixture.stopOwner();
      try {
        r = await spawnExpectExit(
          ["mcp", "--remote", "user-a", "--principal", "e2e-user-a", "--instance-id", "mcp-rx"],
          mcpEnv(),
        );
        assert.notEqual(r.code, 0, "unavailable remote owner must fail");
        assert.equal(r.stdout, "", "no stray stdout");
      } finally {
        await fixture.startOwner();
      }
      return "missing identity and unavailable owner fail closed";
    });

    const envA = mcpEnv();
    const mcp = new McpStdioClient(
      ["mcp", "--remote", "user-a", "--principal", "e2e-user-a", "--instance-id", "mcp-r1"], envA,
    );

    await check("remote/initialize-list", async () => {
      await mcp.initialize();
      const names = (await mcp.listTools()).map((t) => t.name).sort();
      assert.deepEqual(names, ["memory_context", "memory_edit", "memory_recall", "memory_status", "memory_store"]);
      return "remote negotiates all 5 tools over signed WSS";
    });

    let memoryId = 0;
    let revision = 0;

    await check("remote/round-trip", async () => {
      const stored = requireEnvelope(await mcp.callTool("memory_store", {
        text: `The remote ${MARKER} host writes once`, memoryType: "event", operationId: "mcp-racc-1",
      }), "remote store");
      assert.equal(stored.ok, true, `remote store ok (${JSON.stringify(stored.error)?.slice(0, 200)})`);
      const receipt = stored.result as Record<string, unknown>;
      memoryId = receipt["memoryId"] as number;
      revision = receipt["semanticRevision"] as number;
      const recalled = requireEnvelope(await mcp.callTool("memory_recall", { keywords: [MARKER] }), "remote recall");
      assert.equal(recalled.ok, true);
      assert.ok(((recalled.result as Record<string, unknown>)["hits"] as unknown[]).length >= 1);
      const edited = requireEnvelope(await mcp.callTool("memory_edit", {
        memoryId, expectedRevision: revision, action: "demote", operationId: "mcp-racc-e1",
      }), "remote edit");
      assert.equal(edited.ok, true);
      const status = requireEnvelope(await mcp.callTool("memory_status", {}), "remote status");
      assert.equal(status.ok, true);
      const sres = status.result as Record<string, unknown>;
      assert.equal((sres["connection"] as Record<string, unknown>)["mode"], "remote");
      const outbox = sres["outbox"] as Record<string, unknown>;
      assert.equal(typeof outbox["retryEligible"], "number", "bounded retry-eligible count");
      assert.equal(typeof outbox["terminalUnknown"], "number", "bounded terminal-unknown count");
      const ctx = requireEnvelope(await mcp.callTool("memory_context", {}), "remote context");
      assert.equal(ctx.ok, true, "primary owner context served remotely");
      return `remote round trip with outbox counts (memory ${memoryId})`;
    });

    await check("remote/authority", async () => {
      await fixture.seedMemory({ userId: "e2e-user-a", contentEn: `Authority probe ${MARKER}-auth`, contentOriginal: `Authority probe ${MARKER}-auth` });
      const envB = mcpEnv();
      const mcpB = new McpStdioClient(
        ["mcp", "--remote", "user-b", "--principal", "e2e-user-b", "--instance-id", "mcp-r2"], envB,
      );
      try {
        await mcpB.initialize();
        const ctx = requireEnvelope(await mcpB.callTool("memory_context", {}), "non-primary context");
        assert.equal(ctx.ok, false, "non-primary context refused");
        assert.equal(ctx.error?.code, "unauthorized", "permanent authorization failure, not unavailability");
        assert.equal(ctx.error?.retryable, false);
        const recalled = requireEnvelope(await mcpB.callTool("memory_recall", { keywords: [`${MARKER}-auth`] }), "foreign recall");
        assert.equal(recalled.ok, true);
        const hits = (recalled.result as Record<string, unknown>)["hits"] as Array<Record<string, unknown>>;
        assert.ok(hits.every((h) => h["id"] === undefined), "foreign hits carry no id/revision refs");
        const edit = requireEnvelope(await mcpB.callTool("memory_edit", {
          memoryId, expectedRevision: revision, action: "boost", operationId: "mcp-r2-foreign",
        }), "foreign edit");
        assert.equal(edit.ok, false, "foreign ownership cannot adjust");
        assert.equal(edit.error?.code, "not_found");
        // The row is unchanged: the owner still serves it to its principal.
        const mine = requireEnvelope(await mcp.callTool("memory_recall", { keywords: [MARKER] }), "owner re-read");
        assert.equal(mine.ok, true);
        assert.ok(((mine.result as Record<string, unknown>)["hits"] as unknown[]).length >= 1);
      } finally {
        mcpB.closeStdin();
        await mcpB.waitForExit();
      }
      // Narrow grants: forged calls are rejected by the owner even under the tools.
      const narrow = await fixture.createClient("no-cascade-principal");
      try {
        await narrow.lifecycle.store({
          identity: {
            principalId: "no-cascade-principal", conversationId: "c", executionId: "e",
            host: "test", origin: "agent", automaticWriteOwner: "no-cascade-principal",
          },
          contentEn: "forged", contentOriginal: "forged", memoryType: "fact", emotionScore: 0,
        }, "mcp-forge-1");
        assert.fail("narrow grant must reject lifecycleStore");
      } catch (err) {
        assert.ok(err instanceof AbmindClientError, "typed owner rejection");
        assert.equal((err as AbmindClientError).code, "unauthorized");
      } finally {
        await narrow.close().catch(() => {});
      }
      const envN = mcpEnv();
      const mcpN = new McpStdioClient(
        ["mcp", "--remote", "no-cascade", "--principal", "no-cascade-principal", "--instance-id", "mcp-rn"], envN,
      );
      try {
        await mcpN.initialize();
        // No tool satisfies the narrow grant, so the server advertises no
        // tools capability: tools/list is truthfully unanswerable and stale
        // writes fail through the SDK's protocol machinery.
        const narrowList = await mcpN.send("tools/list");
        assert.ok("error" in narrowList, "empty tool set surfaces a protocol-level failure, not phantom tools");
        const stale = await mcpN.callTool("memory_store", { text: "x", memoryType: "fact", operationId: "o" });
        assert.ok(stale.isError === true || "error" in stale.raw, "stale-schema write fails truthfully via protocol machinery");
      } finally {
        mcpN.closeStdin();
        await mcpN.waitForExit();
      }
      return "isolation both directions plus narrow-grant enforcement";
    });

    await check("remote/namespace-refusal-and-reopen", async () => {
      const envDup = mcpEnv();
      const dup = new McpStdioClient(
        ["mcp", "--remote", "user-a", "--principal", "e2e-user-a", "--instance-id", "mcp-r1"], envDup,
      );
      // Give the duplicate a moment to attempt the lease, then close stdin;
      // a refused process exits nonzero on its own.
      const code = await dup.waitForExit(20_000);
      assert.notEqual(code, 0, "second live owner of one namespace is refused");
      assert.ok(dup.stderr.includes("--instance-id"), "diagnostic names the instance option");
      dup.closeStdin();
      // Normal shutdown releases the lease: the matching instance reopens
      // afterward with no orphaned owner.
      mcp.closeStdin();
      assert.equal(await mcp.waitForExit(), 0, "first host exits clean");
      const envRe = mcpEnv();
      const reopen = new McpStdioClient(
        ["mcp", "--remote", "user-a", "--principal", "e2e-user-a", "--instance-id", "mcp-r1"], envRe,
      );
      try {
        await reopen.initialize();
        const status = requireEnvelope(await reopen.callTool("memory_status", {}), "reopened status");
        assert.equal(status.ok, true, "matching instance reopens and serves");
        const recalled = requireEnvelope(await reopen.callTool("memory_recall", { keywords: [MARKER] }), "reopened recall");
        assert.equal(recalled.ok, true, "durable state survives the restart");
      } finally {
        reopen.closeStdin();
        await reopen.waitForExit();
      }
      return "live duplicate refused; matching instance reopens cleanly";
    });

    await check("remote/restart-recovery", async () => {
      const envR = mcpEnv();
      const mcpR = new McpStdioClient(
        ["mcp", "--remote", "user-a", "--principal", "e2e-user-a", "--instance-id", "mcp-rr"], envR,
      );
      try {
        await mcpR.initialize();
        await fixture.restartOwner();
        const status = requireEnvelope(await mcpR.callTool("memory_status", {}), "post-restart status");
        assert.equal(status.ok, true, "reconnect refreshes discovery before new admission");
      } finally {
        mcpR.closeStdin();
        await mcpR.waitForExit();
      }
      return "route loss recovers through renegotiation";
    });
  } finally {
    await fixture.cleanup();
    for (const home of homes) {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
}

async function main(): Promise<void> {
  try {
    await localLane();
    await remoteLane();
  } catch (err) {
    console.error("runner fatal:", err instanceof Error ? err.message : err);
    process.exitCode = 2;
    return;
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\nMCP acceptance: ${results.length - failed.length}/${results.length} checks passed`);
  for (const f of failed) console.log(`  FAILED ${f.name} — ${f.detail}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
}

await main();
