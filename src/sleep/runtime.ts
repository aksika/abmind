/**
 * SleepRuntime — one-method LLM injection interface for the sleep orchestrator.
 *
 * Callers (bridge in-process, standalone CLI shell-out, Openclaw plugin, MCP) provide
 * their own implementation. Abmind ships no default; the library never spawns a child
 * process itself. See docs/plans/163-sleep-to-abmind.md for the injection rationale.
 */
export interface SleepRuntime {
  /**
   * Send the prompt to an LLM, return the full text response.
   * Must reject on transport failure; the orchestrator handles retry/backoff via LlmBudget.
   */
  complete(prompt: string): Promise<string>;
}
