#!/usr/bin/env node
import { loadClientProfiles } from "../src/remote/remote-config.js";
import { SignedWssTransport } from "../src/remote/signed-wss-transport.js";
import { AbmindClient } from "../src/abmind-client.js";
import { LocalTransport } from "../src/local-transport.js";
import { ClientBridgeServer } from "../src/client-bridge/server.js";
import { logError, logInfo } from "../src/mem-logger.js";

const HELP = `abmind-client-bridge — Persistent JSON-RPC stdio bridge for Abmind

Usage:
  abmind-client-bridge --local <socket-path>
  abmind-client-bridge --remote <profile-name>

Exactly one mode is required. Credentials and keys are read from config files,
never from command-line arguments.

Methods:
  bridge.status        — return bridge and transport status
  bridge.negotiate     — negotiate capabilities with server
  abmind.call          — call a registered Abmind method
  bridge.close         — initiate graceful shutdown

Stdin: newline-delimited JSON-RPC 2.0 requests
Stdout: newline-delimited JSON-RPC 2.0 responses
Stderr: redacted diagnostics
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(HELP);
    process.exit(0);
  }

  const localIdx = args.indexOf("--local");
  const remoteIdx = args.indexOf("--remote");

  if (localIdx === -1 && remoteIdx === -1) {
    logError("client-bridge", "Must specify --local or --remote");
    process.exit(1);
  }
  if (localIdx !== -1 && remoteIdx !== -1) {
    logError("client-bridge", "Cannot specify both --local and --remote");
    process.exit(1);
  }

  let client: AbmindClient;
  let transportName: string;

  if (localIdx !== -1) {
    const socketPath = args[localIdx + 1];
    if (!socketPath) {
      logError("client-bridge", "--local requires a socket path");
      process.exit(1);
    }
    const transport = new LocalTransport(socketPath);
    client = new AbmindClient(transport);
    transportName = `local:${socketPath}`;
  } else {
    const profileName = args[remoteIdx + 1];
    if (!profileName) {
      logError("client-bridge", "--remote requires a profile name");
      process.exit(1);
    }
    const profiles = loadClientProfiles();
    const profile = profiles.find(p => p.name === profileName);
    if (!profile) {
      logError("client-bridge", `Remote profile not found: ${profileName}`);
      process.exit(1);
    }
    const transport = new SignedWssTransport(profile);
    client = new AbmindClient(transport);
    transportName = `wss:${profile.url}`;
  }

  logInfo(TAG, `Bridge starting (${transportName})`);
  const server = new ClientBridgeServer(client, transportName);
  await server.run();
  await client.close();
  logInfo(TAG, "Bridge closed");
}

const TAG = "client-bridge";
main().catch((err) => {
  logError("client-bridge", "Fatal error", err);
  process.exit(1);
});
