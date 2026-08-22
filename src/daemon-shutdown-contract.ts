/**
 * #1701: single shared daemon/launchd shutdown timing contract.
 *
 * One absolute deadline governs every cleanup phase so no phase receives a
 * fresh full timeout after a previous phase has consumed time, and daemon
 * cleanup always finishes before launchd's kill deadline. This module is pure:
 * constants and deadline arithmetic only — no environment reads, timers, or
 * mutable module-level state.
 */

export const SERVICE_DRAIN_TIMEOUT_MS = 30_000;
export const DAEMON_SHUTDOWN_BUDGET_MS = 35_000;
export const LEASE_RELEASE_RESERVE_MS = 1_000;
export const LAUNCHD_EXIT_TIMEOUT_SECONDS = 40;

export interface ShutdownDeadline {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly releaseBy: number;
}

/** Anchor one absolute shutdown deadline at `now`. */
export function createShutdownDeadline(now: number): ShutdownDeadline {
  const deadlineAt = now + DAEMON_SHUTDOWN_BUDGET_MS;
  return {
    startedAt: now,
    deadlineAt,
    releaseBy: deadlineAt - LEASE_RELEASE_RESERVE_MS,
  };
}

/**
 * Remaining time for a phase ending at `phaseEnd` (default: the overall
 * deadline). Never exceeds the overall deadline and never goes below zero.
 */
export function remainingMs(deadline: ShutdownDeadline, now: number, phaseEnd?: number): number {
  return Math.max(0, Math.min(phaseEnd ?? deadline.deadlineAt, deadline.deadlineAt) - now);
}

/**
 * The service drain phase ends at the earlier of its own limit and the
 * pre-reserve boundary, so drain can never consume the lease-release tail.
 */
export function serviceDrainEnd(deadline: ShutdownDeadline): number {
  return Math.min(deadline.startedAt + SERVICE_DRAIN_TIMEOUT_MS, deadline.releaseBy);
}
