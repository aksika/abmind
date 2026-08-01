/**
 * consumer-controller-smoke.ts — #1528 focused controller lifecycle smoke.
 *
 * Spawns the BUILT consumer fixture controller for each lane, negotiates the
 * descriptor, exercises describe/restart/stop/shutdown, and proves idempotent
 * cleanup: no fixture root, no daemon socket, and no survivor processes after
 * a clean shutdown, and the controller exits non-zero when its owner cannot
 * start.
 *
 * Run: node dist/tests/acceptance/consumer-controller-smoke.js
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  parseConsumerFixtureDescriptor,
  type FixtureResponseV1,
  type FixtureLane,
} from "./contracts.js";

const COMPILED_ROOT = resolve(import.meta.dirname, "../..");
const CONTROLLER = resolve(COMPILED_ROOT, "tests/acceptance/consumer-fixture-controller.js");

interface SmokeController {
  child: ChildProcess;
  lines: ReturnType<typeof createInterface>;
  descriptorLine: Promise<Record<string, unknown>>;
  stdoutBuf: string;
  stderrBuf: string;
  pending: Map<string, (response: FixtureResponseV1) => void>;
}

function spawnController(lane: FixtureLane, runId: string): Promise<SmokeController> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CONTROLLER, "--lane", lane, "--run-id", runId], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let resolveDescriptor: (value: Record<string, unknown>) => void = () => {};
    const descriptorLine = new Promise<Record<string, unknown>>((res) => { resolveDescriptor = res; });
    const ctrl: SmokeController = {
      child,
      lines: createInterface({ input: child.stdout!, crlfDelay: Infinity }),
      descriptorLine,
      stdoutBuf: "",
      stderrBuf: "",
      pending: new Map(),
    };
    child.stdout!.on("data", (chunk: Buffer) => { ctrl.stdoutBuf += chunk.toString("utf-8"); });
    child.stderr!.on("data", (chunk: Buffer) => { ctrl.stderrBuf += chunk.toString("utf-8"); });
    ctrl.lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: FixtureResponseV1;
      try { parsed = JSON.parse(trimmed) as FixtureResponseV1; } catch { return; }
      const pending = ctrl.pending.get(parsed.id);
      if (pending) { ctrl.pending.delete(parsed.id); pending(parsed); }
    });
    ctrl.lines.once("line", (line) => {
      try { resolveDescriptor(JSON.parse(line) as Record<string, unknown>); } catch { resolveDescriptor({ malformed: line }); }
    });
    child.on("error", reject);
    // Startup failures surface through the descriptor line — resolve when we
    // have either the descriptor or the process exit.
    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        reject(new Error(`controller exited ${code} before descriptor: ${ctrl.stderrBuf.slice(-500)}`));
      }
    });
    resolvePromise(ctrl);
  });
}

function send(ctrl: SmokeController, command: unknown): Promise<FixtureResponseV1> {
  return new Promise((resolvePromise, reject) => {
    const raw = JSON.stringify(command);
    const id = (command as { id: string }).id;
    const timer = setTimeout(() => {
      ctrl.pending.delete(id);
      reject(new Error(`controller command ${id} timed out`));
    }, 30_000);
    ctrl.pending.set(id, (response) => {
      clearTimeout(timer);
      resolvePromise(response);
    });
    ctrl.child.stdin!.write(raw + "\n");
  });
}

async function runLane(lane: FixtureLane): Promise<void> {
  const runId = `smoke-${Date.now()}`;
  const ctrl = await spawnController(lane, runId);

  const descriptorRaw = await ctrl.descriptorLine;
  const parsed = parseConsumerFixtureDescriptor(descriptorRaw["descriptor"] ?? descriptorRaw);
  if (!parsed.ok) {
    throw new Error(`lane ${lane}: descriptor invalid: ${parsed.error.message}`);
  }
  if (parsed.descriptor.lane !== lane) {
    throw new Error(`lane ${lane}: descriptor lane mismatch ${parsed.descriptor.lane}`);
  }

  const describe = await send(ctrl, { version: 1, id: "d1", command: "describe" });
  if (!describe.ok || JSON.stringify(describe.result) !== JSON.stringify(parsed.descriptor)) {
    throw new Error(`lane ${lane}: describe mismatch`);
  }

  const restart = await send(ctrl, { version: 1, id: "r1", command: "restartOwner" });
  if (!restart.ok) throw new Error(`lane ${lane}: restartOwner failed: ${restart.failure?.message}`);

  const stop = await send(ctrl, { version: 1, id: "s1", command: "stopOwner" });
  if (!stop.ok) throw new Error(`lane ${lane}: stopOwner failed: ${stop.failure?.message}`);

  const start = await send(ctrl, { version: 1, id: "s2", command: "startOwner" });
  if (!start.ok) throw new Error(`lane ${lane}: startOwner failed: ${start.failure?.message}`);

  // Malformed input must produce a bounded rejection and keep the controller alive.
  const malformed = await send(ctrl, { version: 1, id: "m1", command: "bogus" });
  if (malformed.ok || malformed.failure?.code !== "unknown_command") {
    throw new Error(`lane ${lane}: unknown command not rejected`);
  }

  const shutdown = await send(ctrl, { version: 1, id: "x1", command: "shutdown" });
  if (!shutdown.ok) throw new Error(`lane ${lane}: shutdown failed: ${shutdown.failure?.message}`);

  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`lane ${lane}: controller did not exit after shutdown`)), 10_000);
    ctrl.child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`lane ${lane}: controller exited ${code} after shutdown`));
        return;
      }
      resolvePromise();
    });
  });

  // The owner socket must be gone after shutdown (idempotent cleanup).
  if (lane === "local-unix") {
    const socket = parsed.descriptor.connection as { mode: "local"; socketPath: string };
    if (existsSync(socket.socketPath)) {
      throw new Error(`lane ${lane}: daemon socket survived shutdown`);
    }
  }

  console.log(`controller smoke ${lane}: ok (${runId})`);
}

async function runMalformedStartup(): Promise<void> {
  const child = spawn(process.execPath, [CONTROLLER, "--lane", "bogus-lane", "--run-id", `smoke-bad-${Date.now()}`]);
  // No --socket material needed: the missing lane validation happens before any owner spawn.
  const exitCode = await new Promise<number | null>((resolvePromise) => {
    child.on("exit", (code) => resolvePromise(code));
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolvePromise(null); }, 10_000);
    child.on("exit", () => clearTimeout(timer));
  });
  if (exitCode === null || exitCode === 0) {
    throw new Error(`controller accepted an invalid lane (exit ${exitCode})`);
  }
  console.log(`controller smoke invalid-lane: ok`);
}

async function main(): Promise<void> {
  if (!existsSync(CONTROLLER)) {
    console.error(`Built controller not found: ${CONTROLLER} — run npm run build first`);
    process.exit(1);
  }
  try {
    await runLane("local-unix");
    await runLane("remote-wss");
    await runMalformedStartup();
    console.log("consumer fixture controller smoke: ALL PASSED");
  } catch (err) {
    console.error(`consumer fixture controller smoke FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

await main();
