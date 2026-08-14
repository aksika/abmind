/**
 * extracted-memory-attribution-repair.ts — deterministic, operator-reviewed
 * attribution repair for legacy `extracted_memories` rows.
 *
 * The service is pure SQL over the provided database and is fully testable.
 * It never infers owners: only rows owned by the explicitly supplied source
 * user ids are eligible, and every collision / private (classification >= 2)
 * row must carry an explicit per-row operator decision before apply.
 */

import type Database from "better-sqlite3";

export type CollisionAction = "merge" | "drop-source";
export type PrivateRowAction = "relabel" | "leave" | "delete";

export type CollisionDecision = {
  readonly sourceMemoryId: number;
  readonly action: CollisionAction;
};

export type PrivateRowDecision = {
  readonly sourceMemoryId: number;
  readonly action: PrivateRowAction;
};

export type AttributionRepairRequest = {
  readonly targetUserId: string;
  readonly sourceUserIds: readonly string[];
  readonly collisionDecisions: readonly CollisionDecision[];
  readonly privateRowDecisions: readonly PrivateRowDecision[];
};

export type AttributionRepairPlan = {
  readonly rows: readonly { id: number; sourceUserId: string; contentEn: string }[];
  readonly collisions: readonly {
    sourceMemoryId: number;
    targetMemoryId: number;
    contentEn: string;
  }[];
  readonly privateRows: readonly {
    sourceMemoryId: number;
    classification: number;
    contentEnLength: number;
  }[];
  readonly staleWatermarkUserIds: readonly string[];
};

export type AttributionRepairResult = {
  readonly corrected: readonly number[];
  readonly merged: readonly number[];
  readonly dropped: readonly number[];
  readonly privateRelabeled: readonly number[];
  readonly privateLeft: readonly number[];
  readonly watermarksRemoved: readonly string[];
  readonly dismissedQuestions: readonly string[];
  readonly redirectedGraphEdges: readonly number[];
  readonly clearedGraphEdges: readonly number[];
};

type MutableResult = {
  corrected: number[];
  merged: number[];
  dropped: number[];
  privateRelabeled: number[];
  privateLeft: number[];
  watermarksRemoved: string[];
  dismissedQuestions: string[];
  redirectedGraphEdges: number[];
  clearedGraphEdges: number[];
};

type SourceRow = {
  id: number;
  user_id: string;
  content_en: string;
  classification: number;
  semantic_revision: number;
  recall_count: number;
  relevance_score: number;
  confidence: number;
  integrity: number;
};

type PlanWatermarkRow = {
  user_id: string;
  last_processed_timestamp: number;
};

const PLAN_STATE = Symbol("attribution-repair-plan-state");
type PlanWithState = AttributionRepairPlan & { readonly [PLAN_STATE]?: string };

function planShape(plan: AttributionRepairPlan): string {
  return JSON.stringify({
    rows: plan.rows,
    collisions: plan.collisions,
    privateRows: plan.privateRows,
    staleWatermarkUserIds: plan.staleWatermarkUserIds,
  });
}

/**
 * Keep the complete inspected row state attached to the in-process plan
 * without printing private content in the CLI's JSON plan. This catches
 * changes to aggregates/revisions and same-length private content changes,
 * not just changes to the visible id categories.
 */
function planStateFingerprint(
  sources: readonly SourceRow[],
  targets: readonly SourceRow[],
  watermarks: readonly PlanWatermarkRow[],
): string {
  return JSON.stringify({ sources, targets, watermarks });
}

function validateRequest(request: AttributionRepairRequest): void {
  if (!request.targetUserId || request.targetUserId.trim() === "") {
    throw new Error("repair requires a non-empty target user id");
  }
  if (request.sourceUserIds.length === 0) {
    throw new Error("repair requires at least one source user id");
  }
  const unique = new Set(request.sourceUserIds);
  if (unique.size !== request.sourceUserIds.length) {
    throw new Error("source user ids must be distinct");
  }
  if (unique.has(request.targetUserId)) {
    throw new Error("target user id must not be among the source user ids");
  }
}

function fetchSourceRows(db: Database.Database, request: AttributionRepairRequest): SourceRow[] {
  const placeholders = request.sourceUserIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT id, user_id, content_en, classification, semantic_revision,
            recall_count, relevance_score, confidence, integrity
     FROM extracted_memories WHERE user_id IN (${placeholders})
     ORDER BY id`,
  ).all(...request.sourceUserIds) as SourceRow[];
}

/** Build the dry-run plan. Deterministic: row order follows id. */
export function inspectAttributionRepair(
  db: Database.Database,
  request: AttributionRepairRequest,
): AttributionRepairPlan {
  validateRequest(request);
  const sources = fetchSourceRows(db, request);

  const targetContents = new Set<string>();
  const targetRows = db.prepare(
    `SELECT id, user_id, content_en, classification, semantic_revision,
            recall_count, relevance_score, confidence, integrity
     FROM extracted_memories WHERE user_id = ? ORDER BY id`,
  ).all(request.targetUserId) as SourceRow[];
  const targetIdByContent = new Map<string, number>();
  for (const row of targetRows) {
    targetContents.add(row.content_en);
    targetIdByContent.set(row.content_en, row.id);
  }

  const rows: Array<{ id: number; sourceUserId: string; contentEn: string }> = [];
  const collisions: Array<{ sourceMemoryId: number; targetMemoryId: number; contentEn: string }> = [];
  const privateRows: Array<{ sourceMemoryId: number; classification: number; contentEnLength: number }> = [];

  for (const source of sources) {
    if (source.classification >= 2) {
      privateRows.push({
        sourceMemoryId: source.id,
        classification: source.classification,
        contentEnLength: source.content_en.length,
      });
      continue;
    }
    const targetMemoryId = targetIdByContent.get(source.content_en);
    if (targetMemoryId !== undefined) {
      collisions.push({
        sourceMemoryId: source.id,
        targetMemoryId,
        contentEn: source.content_en,
      });
      continue;
    }
    rows.push({ id: source.id, sourceUserId: source.user_id, contentEn: source.content_en });
  }

  const watermarkRows = db.prepare(
    `SELECT user_id, last_processed_timestamp
       FROM extraction_watermarks
      WHERE user_id IN (${request.sourceUserIds.map(() => "?").join(",")})
      ORDER BY user_id`,
  ).all(...request.sourceUserIds) as PlanWatermarkRow[];

  const plan: AttributionRepairPlan = {
    rows,
    collisions,
    privateRows,
    staleWatermarkUserIds: watermarkRows.map((row) => row.user_id),
  };
  Object.defineProperty(plan, PLAN_STATE, {
    value: planStateFingerprint(sources, targetRows, watermarkRows),
    enumerable: false,
  });
  return plan;
}

function rejectApply(message: string): never {
  throw new Error(`repair apply refused: ${message}`);
}

function validateDecisions(request: AttributionRepairRequest, plan: AttributionRepairPlan): void {
  const collisionIds = new Set(plan.collisions.map((c) => c.sourceMemoryId));
  const privateIds = new Set(plan.privateRows.map((p) => p.sourceMemoryId));

  const seenCollision = new Set<number>();
  for (const decision of request.collisionDecisions) {
    if (decision.action !== "merge" && decision.action !== "drop-source") {
      rejectApply(`invalid collision decision action for memory ${decision.sourceMemoryId}`);
    }
    if (seenCollision.has(decision.sourceMemoryId)) {
      rejectApply(`duplicate collision decision for memory ${decision.sourceMemoryId}`);
    }
    seenCollision.add(decision.sourceMemoryId);
    if (!collisionIds.has(decision.sourceMemoryId)) {
      rejectApply(`collision decision references unknown or non-collision memory ${decision.sourceMemoryId}`);
    }
  }

  const seenPrivate = new Set<number>();
  for (const decision of request.privateRowDecisions) {
    if (decision.action !== "relabel" && decision.action !== "leave" && decision.action !== "delete") {
      rejectApply(`invalid private-row decision action for memory ${decision.sourceMemoryId}`);
    }
    if (seenPrivate.has(decision.sourceMemoryId)) {
      rejectApply(`duplicate private-row decision for memory ${decision.sourceMemoryId}`);
    }
    seenPrivate.add(decision.sourceMemoryId);
    if (!privateIds.has(decision.sourceMemoryId)) {
      rejectApply(`private-row decision references unknown or non-private memory ${decision.sourceMemoryId}`);
    }
  }

  for (const id of collisionIds) {
    if (!seenCollision.has(id)) {
      rejectApply(`collision memory ${id} has no per-row decision`);
    }
  }
  for (const id of privateIds) {
    if (!seenPrivate.has(id)) {
      rejectApply(`classification >= 2 memory ${id} has no per-row decision`);
    }
  }
}

/** Verify the stored rows still match the inspected plan before mutating. */
function verifyPlanMatchesState(db: Database.Database, request: AttributionRepairRequest, inspected: AttributionRepairPlan): void {
  const current = inspectAttributionRepair(db, request);
  const expectedState = (inspected as PlanWithState)[PLAN_STATE];
  const currentState = (current as PlanWithState)[PLAN_STATE];
  if (!expectedState) {
    rejectApply("inspection state snapshot is missing — re-run the dry run");
  }
  if (expectedState !== currentState || planShape(current) !== planShape(inspected)) {
    rejectApply("source state changed since inspection — re-run the dry run");
  }
}

/** Reconcile references to a source row that is being deleted or merged. */
function reconcileReferences(
  db: Database.Database,
  sourceMemoryId: number,
  keptTargetId: number | null,
  now: number,
  state: {
    dismissedQuestions: string[];
    redirectedGraphEdges: number[];
    clearedGraphEdges: number[];
  },
): void {
  const questions = db.prepare(
    `SELECT id FROM dream_questions
     WHERE (memory_a_id = ? OR memory_b_id = ?) AND status IN ('pending','asked')`,
  ).all(sourceMemoryId, sourceMemoryId) as Array<{ id: string }>;
  for (const question of questions) {
    db.prepare(
      "UPDATE dream_questions SET status = 'dismissed', dismissed_at = ? WHERE id = ? AND status IN ('pending','asked')",
    ).run(now, question.id);
    state.dismissedQuestions.push(question.id);
  }

  if (keptTargetId !== null) {
    const edges = db.prepare(
      "SELECT id FROM entity_graph WHERE source_memory_id = ?",
    ).all(sourceMemoryId) as Array<{ id: number }>;
    db.prepare("UPDATE entity_graph SET source_memory_id = ? WHERE source_memory_id = ?").run(keptTargetId, sourceMemoryId);
    state.redirectedGraphEdges.push(...edges.map((edge) => edge.id));
  } else {
    const edges = db.prepare(
      "SELECT id FROM entity_graph WHERE source_memory_id = ?",
    ).all(sourceMemoryId) as Array<{ id: number }>;
    db.prepare("UPDATE entity_graph SET source_memory_id = NULL WHERE source_memory_id = ?").run(sourceMemoryId);
    state.clearedGraphEdges.push(...edges.map((edge) => edge.id));
  }
}

/**
 * Apply the reviewed repair in one transaction. Re-inspects and verifies the
 * plan still matches, refuses any unresolved decision, and rolls back the
 * entire apply on any precondition failure.
 */
export function applyAttributionRepair(
  db: Database.Database,
  request: AttributionRepairRequest,
  inspected: AttributionRepairPlan,
): AttributionRepairResult {
  validateRequest(request);
  validateDecisions(request, inspected);

  const collisionAction = new Map(request.collisionDecisions.map((d) => [d.sourceMemoryId, d.action]));
  const privateAction = new Map(request.privateRowDecisions.map((d) => [d.sourceMemoryId, d.action]));

  const collisionTarget = new Map(inspected.collisions.map((c) => [c.sourceMemoryId, c.targetMemoryId]));

  const result: MutableResult = {
    corrected: [],
    merged: [],
    dropped: [],
    privateRelabeled: [],
    privateLeft: [],
    watermarksRemoved: [],
    dismissedQuestions: [],
    redirectedGraphEdges: [],
    clearedGraphEdges: [],
  };

  const txn = db.transaction(() => {
    // Keep verification and source reads in the same SQLite transaction as
    // the writes. A plan cannot pass verification and then be applied to a
    // different database snapshot.
    verifyPlanMatchesState(db, request, inspected);
    const now = Date.now();
    const state = result;
    const sources = fetchSourceRows(db, request);
    const byId = new Map(sources.map((row) => [row.id, row]));

    for (const row of inspected.rows) {
      const source = byId.get(row.id);
      if (!source) rejectApply(`memory ${row.id} disappeared before apply`);
      const update = db.prepare(
        "UPDATE extracted_memories SET user_id = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?",
      ).run(request.targetUserId, source.id, source.user_id, source.semantic_revision);
      if (update.changes !== 1) rejectApply(`owner correction of memory ${source.id} failed`);
      result.corrected.push(source.id);
    }

    for (const collision of inspected.collisions) {
      const source = byId.get(collision.sourceMemoryId);
      const targetMemoryId = collisionTarget.get(collision.sourceMemoryId);
      if (!source || targetMemoryId === undefined) rejectApply(`collision memory ${collision.sourceMemoryId} vanished`);
      const action = collisionAction.get(collision.sourceMemoryId);
      if (!action) rejectApply(`collision memory ${collision.sourceMemoryId} has no decision`);

      if (action === "merge") {
        const target = db.prepare(
          "SELECT id, recall_count, relevance_score, confidence, integrity, classification, semantic_revision FROM extracted_memories WHERE id = ? AND user_id = ?",
        ).get(targetMemoryId, request.targetUserId) as
          | { id: number; recall_count: number; relevance_score: number; confidence: number; integrity: number; classification: number; semantic_revision: number }
          | undefined;
        if (!target) rejectApply(`collision target memory ${targetMemoryId} vanished`);
        // #1660: a collision merge can raise classification via
        // MAX(classification, ?) without touching content_en, which would mint
        // a format-0 class-3 row. Refuse any pair with a class-3 side and
        // report the ids for a separate operator decision.
        if (source.classification >= 3 || target.classification >= 3) {
          rejectApply(`collision merge refused: source ${source.id} (class ${source.classification}) or target ${target.id} (class ${target.classification}) is class 3 — requires a separate #1660 decision`);
        }
        const merged = db.prepare(
          `UPDATE extracted_memories SET
             recall_count = recall_count + ?,
             relevance_score = MAX(relevance_score, ?),
             confidence = MAX(confidence, ?),
             integrity = 3,
             classification = MAX(classification, ?),
             edited_at = ?, edited_by = ?,
             semantic_revision = semantic_revision + 1
           WHERE id = ? AND user_id = ? AND semantic_revision = ?`,
        ).run(
          source.recall_count,
          source.relevance_score,
          source.confidence,
          source.classification,
          now, "attribution-repair",
          target.id, request.targetUserId, target.semantic_revision,
        );
        if (merged.changes !== 1) rejectApply(`collision merge into memory ${target.id} failed`);
        reconcileReferences(db, source.id, target.id, now, state);
        const deleted = db.prepare(
          "DELETE FROM extracted_memories WHERE id = ? AND user_id = ? AND semantic_revision = ?",
        ).run(source.id, source.user_id, source.semantic_revision);
        if (deleted.changes !== 1) rejectApply(`collision source memory ${source.id} delete failed`);
        result.merged.push(source.id);
      } else {
        reconcileReferences(db, source.id, null, now, state);
        const deleted = db.prepare(
          "DELETE FROM extracted_memories WHERE id = ? AND user_id = ? AND semantic_revision = ?",
        ).run(source.id, source.user_id, source.semantic_revision);
        if (deleted.changes !== 1) rejectApply(`collision source memory ${source.id} delete failed`);
        result.dropped.push(source.id);
      }
    }

    for (const privateRow of inspected.privateRows) {
      const source = byId.get(privateRow.sourceMemoryId);
      if (!source) rejectApply(`private memory ${privateRow.sourceMemoryId} vanished`);
      const action = privateAction.get(privateRow.sourceMemoryId);
      if (!action) rejectApply(`classification >= 2 memory ${privateRow.sourceMemoryId} has no decision`);

      if (action === "relabel") {
        const update = db.prepare(
          "UPDATE extracted_memories SET user_id = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?",
        ).run(request.targetUserId, source.id, source.user_id, source.semantic_revision);
        if (update.changes !== 1) rejectApply(`private relabel of memory ${source.id} failed`);
        result.privateRelabeled.push(source.id);
      } else if (action === "leave") {
        result.privateLeft.push(source.id);
      } else {
        reconcileReferences(db, source.id, null, now, state);
        const deleted = db.prepare(
          "DELETE FROM extracted_memories WHERE id = ? AND user_id = ? AND semantic_revision = ?",
        ).run(source.id, source.user_id, source.semantic_revision);
        if (deleted.changes !== 1) rejectApply(`private memory ${source.id} delete failed`);
        result.dropped.push(source.id);
      }
    }

    if (inspected.staleWatermarkUserIds.length > 0) {
      const placeholders = inspected.staleWatermarkUserIds.map(() => "?").join(",");
      db.prepare(
        `DELETE FROM extraction_watermarks WHERE user_id IN (${placeholders})`,
      ).run(...inspected.staleWatermarkUserIds);
      result.watermarksRemoved.push(...inspected.staleWatermarkUserIds);
    }
  });

  txn();
  return result as AttributionRepairResult;
}
