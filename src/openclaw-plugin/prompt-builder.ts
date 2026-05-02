/**
 * prompt-builder.ts — contributes static prompt lines to the agent's system
 * prompt when abmind is the registered memory plugin.
 *
 * Called by OpenClaw on every turn via MemoryPluginCapability.promptBuilder.
 * Return value: an array of prompt lines (joined by the host into the
 * broader memory section of the system prompt).
 *
 * Note: runtime capabilities (search, store) are surfaced to the agent via
 * the tool surface (see tools.ts) — this builder only writes descriptive
 * guidance, not tool schemas.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPromptSection(_params: { availableTools?: Set<string>; citationsMode?: unknown }): string[] {
  return [
    "You have persistent long-term memory via abmind (SQLite + FTS5 + trigram + optional embeddings).",
    "Use abmind_recall to search past conversations, decisions, preferences, and facts before responding to anything that references prior context.",
    "Memories are classification-aware: SECRET items never surface; CONFIDENTIAL items only on direct request.",
    "When you store a memory, include a short, factual summary in English — not a transcript. Note WHY for decisions.",
  ];
}
