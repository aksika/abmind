#!/usr/bin/env node
/**
 * abmind bundle — Print session bundle (SOUL + profile + notes + memory-tools) to stdout.
 * For kiro-cli, claude_code, or any host that needs the bundle via execute_bash.
 */

import { loadMemoryConfig } from "../src/memory-config.js";
import { MemoryManager } from "../src/memory-manager.js";

const config = loadMemoryConfig();
const mm = new MemoryManager(config);
const bundle = mm.getSessionBundle();
const parts = [bundle.soul, bundle.memoryTools, bundle.profile, bundle.notes].filter(Boolean);
if (parts.length === 0) {
  console.error("[abmind bundle] No core files found at", config.memoryDir + "/core/");
  process.exit(1);
}
console.log(parts.join("\n\n---\n\n"));
