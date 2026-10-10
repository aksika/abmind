#!/usr/bin/env node
/**
 * abmind mcp — start the MCP adapter over stdio (#1384).
 *
 * Deliberately not runCliRaw: stdout is exclusively MCP frames (except
 * intentional --help), so argument and startup errors use stderr and a
 * nonzero exit instead of the raw runner's generic stdout error path.
 */
import { isDirectRun } from "../src/cli-entry.js";
import { parseFlags, FlagError } from "../src/cli-flags.js";
import { resolveMcpPrincipal, validateInstanceId } from "../src/mcp-connection.js";
import { McpStartupError, startMcpServer } from "../src/mcp-server.js";

const HELP = `Usage:
  abmind mcp [--local <socket> | --remote <profile>] [--principal <id>] [--instance-id <id>]

Starts the MCP adapter over stdio. Exposes 5 tools:
  memory_recall, memory_store, memory_edit, memory_status, memory_context.

  --local <socket>    Local daemon socket (default: configured endpoint).
  --remote <profile>  Signed-WSS client profile name (remote mode).
  --principal <id>    Bound principal. Local default: ABMIND_USER_ID or the
                      saved manifest identity. Required in remote mode.
  --instance-id <id>  Stable id for one MCP host configuration. Required in
                      remote mode (each concurrent host needs its own);
                      defaults to "local" in local mode.

Configure in your MCP-capable host with:
  { "mcpServers": { "abmind": { "command": "abmind", "args": ["mcp"] } } }

Writes carry a caller-chosen operationId (1-128 chars): repeating the same
operationId with the same payload converges; changed input conflicts.
memory_context serves the primary memory owner only.`;

if (isDirectRun(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
  } else {
    let args: Record<string, string | number | boolean | undefined>;
    try {
      args = parseFlags(argv, [
        { name: "local", type: "string" },
        { name: "remote", type: "string" },
        { name: "principal", type: "string" },
        { name: "instance-id", type: "string" },
      ]);
    } catch (err) {
      process.stderr.write(`abmind mcp: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    }
    const local = args["local"] as string | undefined;
    const remote = args["remote"] as string | undefined;
    const exitStartup = (message: string): never => {
      process.stderr.write(`abmind mcp: ${message}\n`);
      process.exit(1);
    };
    if (local !== undefined && remote !== undefined) {
      exitStartup("--local and --remote are mutually exclusive");
    }
    const mode = remote !== undefined ? "remote" : "local";
    let principal: string;
    try {
      principal = resolveMcpPrincipal(mode, args["principal"] as string | undefined);
    } catch (err) {
      exitStartup(err instanceof Error ? err.message : String(err));
    }
    let instanceId: string;
    try {
      const raw = args["instance-id"] as string | undefined;
      if (raw === undefined && mode === "remote") {
        throw new Error("--remote requires --instance-id <id> (each concurrent remote host needs its own)");
      }
      instanceId = validateInstanceId(raw ?? "local");
    } catch (err) {
      exitStartup(err instanceof Error ? err.message : String(err));
    }
    try {
      await startMcpServer({ mode, socketPath: local, remoteProfile: remote, principal: principal!, instanceId: instanceId! });
    } catch (err) {
      const message = err instanceof McpStartupError || err instanceof Error ? err.message : String(err);
      process.stderr.write(`abmind mcp: ${message}\n`);
      process.exit(1);
    }
  }
}
