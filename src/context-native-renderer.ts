/**
 * context-native-renderer.ts — pure suffix rendering for native checkpoint
 * projection (#1883).
 *
 * Renders an already-selected, ID-ordered eligible suffix with no database,
 * provider, mutable refinement cache, or legacy engine authority. Position
 * from the newest suffix row chooses rendering style only; every eligible
 * row is represented exactly once:
 *
 *   - newest `tailSize` rows: verbatim prose
 *   - next `middleSize` rows: deterministic ABM-L via the shared codec
 *   - older uncovered rows: verbatim prose (never silently dropped)
 *
 * With tiers disabled the entire suffix is verbatim. Timestamp metadata
 * supplies date rendering only; it never reorders rows or changes cursor
 * eligibility — the caller owns ID ordering.
 */

import {
  determineTier,
  renderMiddleTurn,
  CHARS_PER_TOKEN,
  type MessageWithHints,
} from "./context-render-primitives.js";

export interface NativeRenderConfig {
  tailSize: number;
  middleSize: number;
  tiersEnabled: boolean;
}

export interface NativeRenderResult {
  messages: Array<{ role: string; content: string }>;
  tailCount: number;
  middleCount: number;
  /** Older uncovered rows rendered verbatim (tiers on only). */
  olderRawCount: number;
  estimatedTokens: number;
}

export function renderNativeSuffix(
  rows: MessageWithHints[],
  config: NativeRenderConfig,
): NativeRenderResult {
  const messages: Array<{ role: string; content: string }> = [];
  let tailCount = 0;
  let middleCount = 0;
  let olderRawCount = 0;

  const total = rows.length;
  for (let idx = 0; idx < total; idx++) {
    const msg = rows[idx]!;
    if (!config.tiersEnabled) {
      messages.push({ role: msg.role, content: msg.content });
      tailCount++;
      continue;
    }
    const tier = determineTier(total - 1 - idx, config.tailSize, config.middleSize);
    if (tier === "tail") {
      messages.push({ role: msg.role, content: msg.content });
      tailCount++;
    } else if (tier === "middle") {
      messages.push({ role: msg.role, content: renderMiddleTurn(msg) });
      middleCount++;
    } else {
      // Older than tail+middle with no checkpoint coverage: verbatim raw
      // fallback. Preserves the bounded middle window's meaning while
      // restoring history the old renderer silently omitted (#1881).
      messages.push({ role: msg.role, content: msg.content });
      olderRawCount++;
    }
  }

  const estimatedTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(m.content.length / CHARS_PER_TOKEN),
    0,
  );

  return { messages, tailCount, middleCount, olderRawCount, estimatedTokens };
}
