/**
 * personal-readiness.ts — Fail-closed serving gate (C5).
 *
 * Until a dataset is ready, personal recall, hydration/context, store and
 * mutation, Dreamy learning and automatic pruning are refused, while
 * authenticated status and inspection for conversion and reviewed
 * maintenance remain available. Readiness is owner-enforced on every
 * transport and rechecked at restart. Operational APIs keep their own
 * contract while isolated from the blocked personal path.
 */

import type Database from "better-sqlite3";
import { getPersonalState, PERSONAL_MODEL_VERSION, type PersonalDataState } from "./personal-schema.js";

export type PersonalRoute =
  | "recall"
  | "hydration"
  | "store"
  | "mutation"
  | "learning"
  | "pruning";

const BLOCKED_ROUTES: ReadonlySet<PersonalRoute> = new Set(["recall", "hydration", "store", "mutation", "learning", "pruning"]);

export type ReadinessVerdict =
  | { ready: true }
  | { ready: false; state: PersonalDataState; reason: string; expectedVersion: number; actualVersion: number };

export function checkPersonalRoute(db: Database.Database, route: PersonalRoute): ReadinessVerdict {
  const row = getPersonalState(db);
  if (!row) return { ready: false, state: "legacy", reason: "readiness unknown: refusing personal serving", expectedVersion: 1, actualVersion: 0 };
  if (row.state === "ready" && row.actual_version === PERSONAL_MODEL_VERSION && row.expected_version === PERSONAL_MODEL_VERSION) return { ready: true };
  if (!BLOCKED_ROUTES.has(route)) return { ready: true };
  return {
    ready: false,
    state: row.state,
    reason: row.state === "ready" ? "personal model version mismatch" : row.reason ?? "conversion required",
    expectedVersion: row.expected_version,
    actualVersion: row.actual_version,
  };
}

/** Throwing guard for personal write/recall paths. */
export function requirePersonalRoute(db: Database.Database, route: PersonalRoute): void {
  const verdict = checkPersonalRoute(db, route);
  if (!verdict.ready) {
    throw new Error(
      `personal ${route} refused: dataset is ${(verdict as { state: string }).state} (${(verdict as { reason: string }).reason})`,
    );
  }
}

/** Status/inspection surface stays available while personal serving blocks. */
export function personalStatus(db: Database.Database): {
  state: PersonalDataState;
  reason: string | null;
  expectedVersion: number;
  actualVersion: number;
  progress: string;
} {
  const row = getPersonalState(db);
  if (!row) return { state: "legacy", reason: "readiness unknown", expectedVersion: 1, actualVersion: 0, progress: "{}" };
  return {
    state: row.state,
    reason: row.reason,
    expectedVersion: row.expected_version,
    actualVersion: row.actual_version,
    progress: row.progress,
  };
}
