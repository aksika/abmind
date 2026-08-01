/**
 * consumer-fixture-controller.ts — #1528 process-neutral owner controller.
 *
 * Spawns and owns a disposable abmind owner (local Unix or signed WSS) on
 * behalf of an external consumer harness. Talks newline-delimited JSON on
 * stdin/stdout; owner logs stay in bounded files inside the disposable root.
 *
 * The controller is consumer-agnostic: it never imports a consumer package,
 * never creates a consumer home, and never writes a consumer config file. It
 * only knows the generic fixture descriptor contract in contracts.ts.
 *
 * Protocol:
 *   - On startup (after owner readiness) the controller writes one
 *     `{type:"descriptor", ...}` line to stdout.
 *   - Commands arrive on stdin as FixtureCommandV1 JSON lines; every command
 *     gets exactly one FixtureResponseV1 line, echoing the command id.
 *   - EOF, malformed input, parent disconnect, SIGINT, and SIGTERM all run
 *     the same idempotent cleanup before the process exits.
 *
 * Run: node dist/tests/acceptance/consumer-fixture-controller.js --lane <lane> --run-id <id>
 */

import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { LocalDaemonFixture } from "./local-daemon-fixture.js";
import { RemoteWssFixture } from "./remote-wss-fixture.js";
import type { AcceptanceFixture } from "./contracts.js";
import {
  parseFixtureCommand,
  type ConsumerFixtureDescriptorV1,
  type FixtureCommandV1,
  type FixtureConnectionDescriptor,
  type FixtureLane,
  type FixtureResponseV1,
} from "./contracts.js";

const PRINCIPAL_ID = "e2e-user-a";
const FINGERPRINT_LENGTH = 12;

function parseArgs(argv: string[]): { lane: FixtureLane; runId: string } {
  let lane: FixtureLane | null = null;
  let runId = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--lane") {
      const value = argv[++i];
      if (value !== "local-unix" && value !== "remote-wss") {
        throw new Error(`--lane must be local-unix or remote-wss (got ${JSON.stringify(value)})`);
      }
      lane = value;
    } else if (arg === "--run-id") {
      runId = argv[++i] ?? "";
    }
  }
  if (!lane) throw new Error("--lane is required");
  if (!runId) throw new Error("--run-id is required");
  return { lane, runId };
}

function buildDescriptor(fixture: AcceptanceFixture, runId: string, lane: FixtureLane): ConsumerFixtureDescriptorV1 {
  let connection: FixtureConnectionDescriptor;
  let endpointFingerprint: string;
  if (fixture instanceof LocalDaemonFixture) {
    connection = { mode: "local", socketPath: fixture.socketPath };
    endpointFingerprint = `local-${sha256(fixture.socketPath).slice(0, FINGERPRINT_LENGTH)}`;
  } else if (fixture instanceof RemoteWssFixture) {
    connection = {
      mode: "wss",
      url: `wss://127.0.0.1:${fixture.endpointPort}`,
      peerId: fixture.userAPeerId,
      signingKeyPath: fixture.peerSigningKeyPath(fixture.userAPeerId),
      serverCertSha256: fixture.certificatePin,
    };
    endpointFingerprint = `wss-${fixture.certificatePin.slice(0, FINGERPRINT_LENGTH)}`;
  } else {
    throw new Error(`Unknown fixture type for lane ${lane}`);
  }
  return {
    version: 1,
    lane,
    runId,
    principalId: PRINCIPAL_ID,
    connection,
    endpointFingerprint,
  };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

async function executeCommand(
  fixture: AcceptanceFixture,
  descriptor: ConsumerFixtureDescriptorV1,
  command: FixtureCommandV1,
): Promise<FixtureResponseV1> {
  try {
    switch (command.command) {
      case "describe":
        return { version: 1, id: command.id, ok: true, result: descriptor };
      case "startOwner":
        await fixture.startOwner();
        return { version: 1, id: command.id, ok: true, result: { started: true } };
      case "stopOwner":
        await fixture.stopOwner();
        return { version: 1, id: command.id, ok: true, result: { stopped: true } };
      case "restartOwner":
        await fixture.restartOwner();
        return { version: 1, id: command.id, ok: true, result: { restarted: true } };
      case "copyFailureArtifacts": {
        const logDir = await fixture.copyFailureArtifacts(command.stage);
        return { version: 1, id: command.id, ok: true, result: { artifactDirectory: logDir } };
      }
      case "conversationRows": {
        const client = await fixture.createClient(command.userId);
        try {
          const rows = await client.privateMemory.getRecentConversation({
            userId: command.userId,
            since: command.since,
            limit: command.limit,
          });
          const bounded = rows.slice(0, command.limit).map((row) => ({
            role: String(row.role),
            content: String(row.content),
            timestamp: typeof row.timestamp === "number" ? row.timestamp : 0,
          }));
          return { version: 1, id: command.id, ok: true, result: { rows: bounded } };
        } finally {
          await client.close().catch(() => {});
        }
      }
      case "shutdown":
        await fixture.cleanup();
        return { version: 1, id: command.id, ok: true, result: { shutdown: true } };
    }
  } catch (err) {
    return {
      version: 1,
      id: command.id,
      ok: false,
      failure: {
        stage: command.command,
        code: "controller_error",
        message: err instanceof Error ? err.message.slice(0, 1000) : String(err),
      },
    };
  }
}

async function main(): Promise<void> {
  const { lane, runId } = parseArgs(process.argv.slice(2));

  const fixture: AcceptanceFixture = lane === "local-unix"
    ? new LocalDaemonFixture()
    : new RemoteWssFixture();

  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await fixture.cleanup();
    } catch {
      // idempotent cleanup — ignore secondary failures
    }
    process.exitCode = code;
  };

  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));
  process.on("SIGHUP", () => void shutdown(129));
  process.stdin.on("close", () => void shutdown(0));

  try {
    await fixture.startOwner();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`controller: owner start failed: ${message}`);
    await shutdown(1);
    return;
  }

  // The WSS endpoint port is allocated during startOwner — build the
  // descriptor only after the owner is ready so the URL is live.
  const descriptor = buildDescriptor(fixture, runId, lane);

  process.stdout.write(JSON.stringify({ type: "descriptor", version: 1, descriptor }) + "\n");

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (shuttingDown) return;
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (Buffer.byteLength(trimmed, "utf-8") > 64 * 1024) {
      const id = `oversized-${randomUUID().slice(0, 8)}`;
      process.stdout.write(JSON.stringify({
        version: 1,
        id,
        ok: false,
        failure: { stage: "protocol", code: "oversized", message: "command line exceeds 64 KiB bound" },
      }) + "\n");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      const id = `malformed-${randomUUID().slice(0, 8)}`;
      process.stdout.write(JSON.stringify({
        version: 1,
        id,
        ok: false,
        failure: { stage: "protocol", code: "malformed", message: "command line is not valid JSON" },
      }) + "\n");
      return;
    }
    const result = parseFixtureCommand(parsed);
    if (!result.ok) {
      process.stdout.write(JSON.stringify({
        version: 1,
        id: typeof (parsed as { id?: unknown })?.id === "string" ? (parsed as { id: string }).id : `invalid-${randomUUID().slice(0, 8)}`,
        ok: false,
        failure: { stage: "protocol", code: result.error.code, message: result.error.message },
      }) + "\n");
      return;
    }
    void executeCommand(fixture, descriptor, result.command).then((response) => {
      if (result.command.command === "shutdown") {
        // Command-driven shutdown already ran idempotent cleanup.
        process.stdout.write(JSON.stringify(response) + "\n", () => process.exit(0));
        return;
      }
      process.stdout.write(JSON.stringify(response) + "\n");
    });
  });

  await new Promise<void>((resolve) => {
    rl.on("close", resolve);
    if (process.stdin.readableEnded) resolve();
  });
}

await main();
