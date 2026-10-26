#!/usr/bin/env node
/**
 * abmind bundle — Print session bundle (SOUL + memory-tools + profile + notes + core_facts) to stdout.
 * For kiro-cli, claude_code, or any host that needs the bundle via execute_bash.
 *
 * #1869 — consumes the single abmind-owned composition (getSessionParts +
 * joinCoreParts) instead of joining its own subset; core_facts.md reaches
 * this surface for the first time. Under MEMORY_TEST=ON only memory-tools
 * survives, so the agent still knows how to query.
 */

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("Usage: abmind bundle\n\nPrint session bundle (SOUL + memory-tools + profile + notes + core_facts) to stdout.");
  process.exit(0);
}

import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager } from "../src/memory-manager.js";
import { joinCoreParts } from "../src/core-composition.js";

const client = await getMemoryClient(false);
const mm = client as MemoryManager;
try {
  const text = joinCoreParts(mm.getSessionParts());
  if (!text) {
    console.error("[abmind bundle] No core files found at", mm.getConfig().memoryDir + "/core/");
    process.exit(1);
  }
  console.log(text);
} finally {
  closeClient(client);
}
