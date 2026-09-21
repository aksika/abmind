import type { RecallHit } from "./types.js";
import type { MemoryManager } from "../memory-manager.js";

export function renderWakeUp(memory: MemoryManager, maxChars: number, userId: string): string {
  return memory.buildWakeUp(userId, maxChars);
}

export function renderRecallContext(hits: readonly RecallHit[], maxChars: number): string {
  return renderRecallContextCounted(hits, maxChars).text;
}

/**
 * #1383 — same rendering, plus how many hits were fully included inside the
 * budget. Callers must distinguish retrieved hits from rendered ones:
 * retrieval is not delivery.
 */
export function renderRecallContextCounted(
  hits: readonly RecallHit[], maxChars: number,
): { text: string; rendered: number } {
  if (hits.length === 0) return { text: "", rendered: 0 };

  const lines: string[] = ["[abmind memory context]"];
  let total = lines[0]!.length + 1;
  let rendered = 0;

  for (const hit of hits) {
    const line = `- (${hit.date}) ${hit.content}`.replace(/\s+/g, " ").trim();
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
    rendered++;
  }

  if (lines.length === 1) return { text: "", rendered: 0 };

  return { text: lines.join("\n") + "\n", rendered };
}
