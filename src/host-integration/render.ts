import type { MemoryManager } from "../memory-manager.js";
import { isMemoryTestMode } from "../core-composition.js";

export function renderWakeUp(memory: MemoryManager, maxChars: number, userId: string): string {
  // #1869 — lifecycle session context is model-bound: the flashback drops
  // out under MEMORY_TEST=ON while the computed time line stays.
  return memory.buildWakeUp(userId, maxChars, isMemoryTestMode() ? { suppressFlashback: true } : undefined);
}
