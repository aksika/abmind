/**
 * tool-result-pruner.ts — In-memory tool result pruning at transport boundary.
 * Two-tier: outside tail → one-liner marker, inside tail → soft trim (4+6 lines).
 * Does NOT modify DB. Pure in-memory transformation.
 */

import { createHash } from "node:crypto";

const HEAD_LINES = 4;
const TAIL_LINES = 6;
const LINE_CAP = 80;
const MIN_PRUNE_LENGTH = 200;
const ARG_TRUNCATE_THRESHOLD = 200;

export interface PrunableMessage {
  role: string;
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}

export interface PruneResult {
  messages: PrunableMessage[];
  prunedCount: number;
}

/** Soft trim: keep first HEAD_LINES + last TAIL_LINES, cap each line at LINE_CAP. */
function softTrim(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= HEAD_LINES + TAIL_LINES) return capLines(lines).join("\n");

  const head = capLines(lines.slice(0, HEAD_LINES));
  const tail = capLines(lines.slice(-TAIL_LINES));
  const trimmedChars = content.length - head.join("\n").length - tail.join("\n").length;
  return [...head, `...[trimmed ${trimmedChars} chars]...`, ...tail].join("\n");
}

function capLines(lines: string[]): string[] {
  return lines.map(l => l.length > LINE_CAP ? l.slice(0, LINE_CAP) + "…" : l);
}

/** Truncate tool_call arguments JSON-safely. */
function truncateArgs(args: string): string {
  if (args.length <= ARG_TRUNCATE_THRESHOLD) return args;
  try {
    const parsed = JSON.parse(args);
    const shrunk = shrinkStrings(parsed);
    return JSON.stringify(shrunk);
  } catch { return args; }
}

function shrinkStrings(obj: unknown): unknown {
  if (typeof obj === "string") return obj.length > ARG_TRUNCATE_THRESHOLD ? obj.slice(0, ARG_TRUNCATE_THRESHOLD) + "...[truncated]" : obj;
  if (Array.isArray(obj)) return obj.map(shrinkStrings);
  if (obj && typeof obj === "object") return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, shrinkStrings(v)]));
  return obj;
}

/**
 * Prune tool results in a message array.
 * @param messages — full message array from buildContext
 * @param tailCount — number of messages in the protected tail (from end)
 * @param aggressive — if true (gap > 1hr), prune ALL tool results outside tail
 */
export function pruneToolResults(messages: PrunableMessage[], tailCount: number, aggressive: boolean = false): PruneResult {
  if (messages.length === 0) return { messages, prunedCount: 0 };

  const tailStart = Math.max(0, messages.length - tailCount);
  const result = messages.map(m => ({ ...m }));
  let prunedCount = 0;

  // Build tool name lookup from assistant tool_calls
  const callIdToName = new Map<string, string>();
  for (const msg of result) {
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) callIdToName.set(tc.id, tc.function.name);
    }
  }

  // Dedup pass: hash tool results, keep newest
  const contentHashes = new Map<string, number>(); // hash → newest index
  for (let i = result.length - 1; i >= 0; i--) {
    const msg = result[i]!;
    if (msg.role !== "tool" || msg.content.length < MIN_PRUNE_LENGTH) continue;
    const h = createHash("md5").update(msg.content).digest("hex").slice(0, 12);
    if (contentHashes.has(h)) {
      result[i] = { ...msg, content: "[dup]" };
      prunedCount++;
    } else {
      contentHashes.set(h, i);
    }
  }

  // Prune pass
  for (let i = 0; i < result.length; i++) {
    const msg = result[i]!;

    // Tool results
    if (msg.role === "tool" && msg.content.length > MIN_PRUNE_LENGTH && msg.content !== "[dup]") {
      if (i < tailStart || aggressive) {
        // Outside tail (or aggressive mode): one-liner
        const toolName = callIdToName.get(msg.tool_call_id ?? "") ?? "tool";
        result[i] = { ...msg, content: `[tool:${toolName}] (cleared, was ${msg.content.length}ch)` };
        prunedCount++;
      } else {
        // Inside tail: soft trim
        const trimmed = softTrim(msg.content);
        if (trimmed.length < msg.content.length) {
          result[i] = { ...msg, content: trimmed };
          prunedCount++;
        }
      }
    }

    // Truncate tool_call arguments outside tail
    if (i < tailStart && msg.tool_calls) {
      let modified = false;
      const newCalls = msg.tool_calls.map(tc => {
        if (tc.function.arguments.length > ARG_TRUNCATE_THRESHOLD) {
          modified = true;
          return { ...tc, function: { ...tc.function, arguments: truncateArgs(tc.function.arguments) } };
        }
        return tc;
      });
      if (modified) result[i] = { ...msg, tool_calls: newCalls };
    }
  }

  return { messages: result, prunedCount };
}
