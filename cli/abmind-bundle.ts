#!/usr/bin/env node
/**
 * abmind bundle — Print session bundle (SOUL + profile + notes + memory-tools) to stdout.
 * For kiro-cli, claude_code, or any host that needs the bundle via execute_bash.
 */

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: abmind bundle\n\nPrint session bundle (SOUL + profile + notes + memory-tools) to stdout.");
  process.exit(0);
}

import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager } from "../src/memory-manager.js";

const client = await getMemoryClient(false);
const mm = client as MemoryManager;
try {
  const bundle = mm.getSessionBundle();
  const parts = [bundle.soul, bundle.memoryTools, bundle.profile, bundle.notes].filter(Boolean);
  if (parts.length === 0) {
    console.error("[abmind bundle] No core files found at", mm.getConfig().memoryDir + "/core/");
    process.exit(1);
  }
  console.log(parts.join("\n\n---\n\n"));
} finally {
  closeClient(client);
}
