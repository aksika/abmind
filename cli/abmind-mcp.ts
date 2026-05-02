#!/usr/bin/env node
/**
 * abmind mcp — start MCP server over stdio.
 *
 * runCliRaw gives us --help + isDirectRun gate. The handler runs the
 * MCP server loop, which never returns under normal operation.
 */
import { runCliRaw } from "../src/cli-runner-raw.js";
import { startMcpServer } from "../src/mcp-server.js";

await runCliRaw(import.meta.url, {
  name: "abmind-mcp",
  help: `Usage:
  abmind mcp

Starts the MCP server over stdio. Exposes 5 tools:
  memory_recall, memory_store, memory_edit, memory_status, memory_wakeup.

Configure in your MCP-capable host (Claude Desktop / Cursor / OpenCode /
kiro-cli) with:
  { "mcpServers": { "abmind": { "command": "abmind", "args": ["mcp"] } } }`,
  flags: [],
  handler: async () => {
    await startMcpServer();
  },
});
