#!/usr/bin/env node
import { loadMemoryConfig, type MemoryConfig } from "../src/memory-config.js";
import { AbmindServiceHost } from "../src/abmind-service-host.js";
import { LocalEndpointServer } from "../src/local-endpoint-server.js";
import { logError, logInfo } from "../src/mem-logger.js";

const HELP = `abmind daemon — Start the abmind memory daemon

Start the long-running abmind process that owns memory.db and serves
local clients over a Unix socket.

Usage: abmind daemon [options]

Options:
  --help          Show this help
  --foreground    Run in foreground (default)
  --socket PATH   Socket path (default: ~/.abmind/run/abmind.sock)
  --principal peer_uid|self  Principal mapping (default: self)

The daemon acquires the #1379 exclusive owner lease, initializes the
memory manager, and listens for V1 protocol requests on the Unix socket.
Shutdown order: reject new calls, drain, close listener, close DB, release lease.
`;

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(HELP);
  process.exit(0);
}

const config = loadMemoryConfig();
const socketIndex = args.indexOf("--socket");
const socketPath = socketIndex !== -1 ? args[socketIndex + 1] : undefined;
const principalMapping = args.includes("--principal")
  ? (args[args.indexOf("--principal") + 1] === "peer_uid" ? "peer_uid" as const : "self" as const)
  : "self" as const;

const host = new AbmindServiceHost({
  mode: "daemon",
  memory: config,
  policy: { principalId: "daemon", role: "service", grantedDomains: ["system", "private", "operational", "operator"], authenticatedBy: "embedded" },
});

try {
  await host.start();
  logInfo("daemon", "Abmind daemon started");
} catch (err) {
  logError("daemon", "Failed to start daemon", err);
  process.exit(1);
}

const server = new LocalEndpointServer({
  socketPath,
  service: host.service!,
  principalMapping,
});

try {
  await server.start();
  logInfo("daemon", `Listening on ${server.address}`);
} catch (err) {
  logError("daemon", "Failed to start endpoint server", err);
  await host.stop();
  process.exit(1);
}

process.on("SIGINT", async () => {
  logInfo("daemon", "Shutting down (SIGINT)");
  await server.stop();
  await host.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logInfo("daemon", "Shutting down (SIGTERM)");
  await server.stop();
  await host.stop();
  process.exit(0);
});
