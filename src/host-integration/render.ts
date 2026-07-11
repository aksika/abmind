import type { RecallHit } from "./types.js";
import type { MemoryManager } from "../memory-manager.js";

export function renderWakeUp(memory: MemoryManager, maxChars: number): string {
  return memory.buildWakeUp(maxChars);
}

export function renderRecallContext(hits: readonly RecallHit[], maxChars: number): string {
  if (hits.length === 0) return "";

  const lines: string[] = ["[abmind memory context]"];
  let total = lines[0]!.length + 1;

  for (const hit of hits) {
    const line = `- (${hit.date}) ${hit.content}`.replace(/\s+/g, " ").trim();
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }

  if (lines.length === 1) return "";

  return lines.join("\n") + "\n";
}
