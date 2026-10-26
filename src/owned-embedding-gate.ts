/**
 * owned-embedding-gate — #1928 C3 foreground query-embedding limits (M3).
 *
 * At most two outstanding calls per principal and four per owner process,
 * shared across profiles and provider instances, with no waiting queue.
 * Active and abandoned calls count together; admission failure degrades Se
 * without blocking deterministic recall. Each admitted call has a 30,000-ms
 * maximum transport lifetime from its actual start. Permits release only
 * when the underlying operation settles or confirms termination — never on
 * a foreground wait expiry — so a hung provider degrades Se instead of
 * admitting unbounded replacements. Abandoned completions never publish.
 */

export const OWNED_EMBED_MAX_PER_PRINCIPAL = 2;
export const OWNED_EMBED_MAX_PER_PROCESS = 4;
export const OWNED_EMBED_TRANSPORT_LIFETIME_MS = 30_000;

export interface EmbedPermit {
  readonly principal: string;
  readonly startedAt: number;
  readonly transportDeadAt: number;
  release(): void;
}

const inFlight = new Map<string, number>();
let inFlightTotal = 0;

export function embedGateStatus(): { total: number; byPrincipal: Record<string, number> } {
  const byPrincipal: Record<string, number> = {};
  for (const [principal, count] of inFlight) byPrincipal[principal] = count;
  return { total: inFlightTotal, byPrincipal };
}

/**
 * Admit one foreground query embedding. Returns null when saturated —
 * the caller reports Se busy/unavailable and continues deterministic
 * stages. Never queues.
 */
export function acquireEmbedPermit(principal: string): EmbedPermit | null {
  const held = inFlight.get(principal) ?? 0;
  if (inFlightTotal >= OWNED_EMBED_MAX_PER_PROCESS || held >= OWNED_EMBED_MAX_PER_PRINCIPAL) {
    return null;
  }
  inFlight.set(principal, held + 1);
  inFlightTotal++;
  const startedAt = Date.now();
  let released = false;
  return {
    principal,
    startedAt,
    transportDeadAt: startedAt + OWNED_EMBED_TRANSPORT_LIFETIME_MS,
    release(): void {
      if (released) return;
      released = true;
      const current = inFlight.get(principal) ?? 0;
      if (current <= 1) inFlight.delete(principal);
      else inFlight.set(principal, current - 1);
      inFlightTotal = Math.max(0, inFlightTotal - 1);
    },
  };
}

/** Test/operator introspection only: outstanding foreground calls. */
export function resetEmbedGateForTests(): void {
  inFlight.clear();
  inFlightTotal = 0;
}
