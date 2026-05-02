/**
 * embedding-health.ts — Check ollama + embedding model availability.
 * Single source of truth for embedding health checks.
 */

export interface EmbeddingHealth {
  reachable: boolean;
  modelPulled: boolean;
  modelsAvailable: string[];
  error?: string;
}

export async function checkEmbeddingHealth(
  endpoint = "http://localhost:11434",
  model = "nomic-embed-text",
): Promise<EmbeddingHealth> {
  try {
    const res = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { reachable: false, modelPulled: false, modelsAvailable: [], error: `${res.status} ${res.statusText}` };
    const data = await res.json() as { models?: Array<{ name: string }> };
    const models = (data.models ?? []).map(m => m.name.replace(/:latest$/, ""));
    return { reachable: true, modelPulled: models.some(m => m === model || m.startsWith(model + ":")), modelsAvailable: models };
  } catch (err) {
    return { reachable: false, modelPulled: false, modelsAvailable: [], error: err instanceof Error ? err.message : String(err) };
  }
}
