import type Database from "better-sqlite3";
import type {
  PrivateMutationStatusV1,
  InstantStoreParams,
  InstantStoreResult,
  EffectivePrivateMutationContext,
  EditPrivateMemoryInputV1,
  ReclassifyPrivateMemoryInputV1,
  MergePrivateMemoriesInputV1,
  CascadeDeletePrivateMessagesInputV1,
  CascadeDeleteResultV1,
} from "./mem-types.js";
import { parseSourceMessageIds } from "./source-message-ids.js";
import { assertPrimaryMemoryOwner, assertSnapshotOwner, PrimaryIdentityError } from "./user-utils.js";
import { createEpisode, type EpisodeInput } from "./personal-episodes.js";
import { storeDurable, storeSealedDurable, supersedeDurable, type DurableInput, type DurableGraphInput } from "./personal-durable.js";
import { parseGraphEntities, parseGraphRelations } from "./recall-projection-build.js";
import { forgetPersonal as forgetPersonalImpl, type ForgetTarget } from "./personal-forget.js";
import { isPersonalReady, getPersonalState } from "./personal-schema.js";

/**
 * #1939 — the legacy extracted-memory mutation and edit surface is retired.
 * These methods keep their wire signatures as explicit refusals; owner
 * corrections use the personal correct/scope path (supersedePersonalDurable)
 * instead. No legacy row is read or written here.
 */
function refuseLegacyMutation(db: Database.Database): PrivateMutationStatusV1 {
  if (isPersonalReady(db)) {
    const state = getPersonalState(db);
    return {
      ok: false,
      code: "validation_error",
      message: `legacy memory mutation retired on the new model (dataset is ${state?.state ?? "ready"}); correct via personal correct/scope, restrict scope, or forget and re-store`,
    };
  }
  const state = getPersonalState(db);
  return {
    ok: false,
    code: "validation_error",
    message: `personal mutation refused: dataset is ${state?.state ?? "unknown"} (${state?.reason ?? "unconverted dataset (conversion retired)"})`,
  };
}

const TAG = "private-mutation-store";
const SECRET_SCAN_WINDOW = 10;

interface SemanticRow {
  id: number;
  user_id: string;
  semantic_revision: number;
  classification: number;
  content_en: string;
  content_original: string;
  preserved_keyword: string | null;
  encrypted: number;
  sealed_format_version: number;
}

interface MutationPatch {
  sets: string[];
  values: unknown[];
  derivedContent?: string;
}

export class PrivateMemoryMutationStore {
  constructor(
    private readonly db: Database.Database,
    private readonly ownerSnapshot?: string | null,
  ) {}

  /**
   * #1930 C1: the single personal writer for episodes, durable revisions,
   * corrections, scope changes, forgetting and reviewed conversion writes.
   * Sleep proposals, adapters, retention and restore route through these
   * methods rather than writing personal rows directly. Operational writes
   * stay in their own store/tables and are never mixed here.
   */
  createPersonalEpisode(input: EpisodeInput): { id: number; replayed: boolean } {
    this.assertOwner(input.userId);
    return createEpisode(this.db, input);
  }

  storePersonalDurable(input: DurableInput): { id: number; revision: number } {
    this.assertOwner(input.userId);
    return storeDurable(this.db, input);
  }

  supersedePersonalDurable(opts: {
    userId: string;
    memoryId: number;
    expectedRevision: number;
    content: string;
    authority: "user_statement" | "confirmed_decision" | "agent_proposal" | "inference";
    authorityBasis: string;
    applicabilityScope?: Record<string, unknown>;
    evidence: DurableInput["evidence"];
    actorId: string;
    graph?: DurableGraphInput;
  }): { id: number; revision: number } {
    this.assertOwner(opts.userId);
    return supersedeDurable(this.db, opts);
  }

  forgetPersonal(opts: { owner: string; targets: ForgetTarget[]; memoryDir?: string; actorId: string }): {
    operationId: string;
    state: "pending" | "complete";
  } {
    this.assertOwner(opts.owner);
    return forgetPersonalImpl(this.db, { ...opts, callerOwner: opts.owner });
  }

  /**
   * #1863 Step 0: owner check against the startup snapshot when one was
   * supplied (sleep/owner flows); legacy ambient-canonical check otherwise
   * (isolated tests without a manifest).
   */
  private assertOwner(requestedUserId: string): void {
    if (this.ownerSnapshot != null) assertSnapshotOwner(requestedUserId, this.ownerSnapshot);
    else assertPrimaryMemoryOwner(requestedUserId);
  }

  reclassify(_ctx: EffectivePrivateMutationContext, input: ReclassifyPrivateMemoryInputV1): PrivateMutationStatusV1 {
    const validLevels = new Set([0, 1, 2, 3]);
    if (!validLevels.has(input.classification) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, code: "validation_error", message: "classification must be 0-3" };
    }
    return refuseLegacyMutation(this.db);
  }

  edit(_ctx: EffectivePrivateMutationContext, input: EditPrivateMemoryInputV1): PrivateMutationStatusV1 {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      return { ok: false, code: "validation_error", message: "expectedRevision must be a positive integer" };
    }
    return refuseLegacyMutation(this.db);
  }

  merge(_ctx: EffectivePrivateMutationContext, _input: MergePrivateMemoriesInputV1): PrivateMutationStatusV1 {
    return refuseLegacyMutation(this.db);
  }

  cascadeDelete(
    ctx: EffectivePrivateMutationContext,
    input: CascadeDeletePrivateMessagesInputV1,
  ): CascadeDeleteResultV1 {
    // Message-driven cascade deletion would destroy episode evidence outside
    // the retention predicate and leave no forget markers. On ready datasets
    // the owner forgets through the personal controls instead.
    if (isPersonalReady(this.db)) {
      throw new CascadeValidationError(
        "legacy cascade delete retired on the new model: forget messages through the personal forget path so markers and derived cleanup apply",
      );
    }
    if (input.userId !== ctx.userId) throw new CascadeValidationError("cascade delete principal mismatch");
    const ids = input.messageIds;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 512) {
      throw new CascadeValidationError("cascade delete requires 1-512 message ids");
    }
    const unique = new Set<number>();
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id < 1) throw new CascadeValidationError("cascade delete requires positive safe integer message ids");
      unique.add(id);
    }
    if (unique.size !== ids.length) throw new CascadeValidationError("cascade delete requires unique message ids");

    // #1939: the legacy delete transaction is deleted. This surface refuses
    // on every dataset state; ready datasets forget through the personal path.
    const state = getPersonalState(this.db);
    throw new CascadeValidationError(
      `personal cascade delete refused: dataset is ${state?.state ?? "unknown"} (${state?.reason ?? "unconverted dataset (conversion retired)"})`,
    );
  }

  async appendInstant(
    ctx: EffectivePrivateMutationContext,
    input: InstantStoreParams,
  ): Promise<InstantStoreResult> {
    try {
      this.assertOwner(ctx.userId);
    } catch (err) {
      if (err instanceof PrimaryIdentityError) {
        return {
          stored: false,
          memoriesCount: 0,
          code: err.code === "non_primary_memory_owner" ? "unauthorized" : "unavailable",
          message: `[${err.code}] ${err.message}`,
        };
      }
      throw err;
    }
    const blockedUsers = new Set(["system", "agent", "unknown"]);
    if (blockedUsers.has(ctx.userId)) {
      return { stored: false, memoriesCount: 0, code: "unauthorized", message: "blocked: system userId cannot store memories" };
    }
    // #1939: on ready datasets direct stores land in durable knowledge
    // through the single personal writer. Unconverted datasets are
    // unconvertible and fail closed; the legacy extracted-memory path is gone.
    if (!isPersonalReady(this.db)) {
      const state = getPersonalState(this.db);
      return {
        stored: false,
        memoriesCount: 0,
        code: "unavailable",
        message: `personal store refused: dataset is ${state?.state ?? "unknown"} (${state?.reason ?? "unconverted dataset (conversion retired)"})`,
      };
    }
    return this.appendInstantPersonal(ctx, input);
  }

  /**
   * Sealed direct store (#1930 class-3 decision 2026-10-20). Writes an
   * encrypted sealed durable, then forgets every owned raw message whose
   * content contains the exact value. The forget runs through the reviewed
   * redaction mechanism, so episode excerpts are stripped, cumulative
   * artifacts invalidate, and projections re-index without the value.
   * Insert-first ordering: a redaction failure is reported loudly with the
   * sealed row id rather than deleting raw evidence without a sealed row
   * to show for it. Each seal creates a row; retries do not dedupe.
   */
  private async appendSealedPersonal(
    ctx: EffectivePrivateMutationContext,
    input: InstantStoreParams,
  ): Promise<InstantStoreResult> {
    const exactValue = input.contentOriginal;
    if (!exactValue || !exactValue.trim()) {
      return { stored: false, memoriesCount: 0, code: "validation_error", message: "sealed stores require the exact value in content-original" };
    }
    const label = input.sealedLabel?.trim();
    if (!label) {
      return { stored: false, memoriesCount: 0, code: "validation_error", message: "sealed stores require a descriptive sealedLabel (content-en is ignored)" };
    }
    let stored: { id: number; revision: number };
    try {
      stored = storeSealedDurable(this.db, {
        userId: ctx.userId,
        memoryType: input.memoryType || "fact",
        label,
        exactValue,
        keyword: input.sealedKeyword?.trim() || undefined,
        authority: "inference",
        authorityBasis: `sealed direct store via ${ctx.actorId}`,
        topic: input.topic,
        actorId: ctx.actorId,
      });
    } catch (err) {
      return { stored: false, memoriesCount: 0, code: "validation_error", message: err instanceof Error ? err.message : String(err) };
    }
    // Redact every surviving surface that copies the value: raw messages and
    // episode evidence excerpts. A message that also carries unrelated text
    // is deleted whole — the forget mechanism has no message-level redaction,
    // and leaving a readable copy of the value is not an option.
    const hits = this.db.prepare("SELECT id FROM messages WHERE user_id = ? AND instr(content, ?) > 0").all(ctx.userId, exactValue) as Array<{ id: number }>;
    const rawIds = hits.map((h) => h.id);
    const targets: ForgetTarget[] = rawIds.length > 0 ? [{ kind: "raw", messageIds: rawIds }] : [];
    let detailCount = 0;
    // Episode excerpts outlive their source message once raw input is pruned,
    // so they are targeted independently through the excerpt-level redaction.
    const episodes = this.db.prepare(
      "SELECT id, evidence_excerpts FROM short_term_memories WHERE user_id = ? AND classification < 3",
    ).all(ctx.userId) as Array<{ id: number; evidence_excerpts: string }>;
    for (const episode of episodes) {
      let entries: unknown;
      try {
        entries = JSON.parse(episode.evidence_excerpts);
      } catch {
        continue;
      }
      if (!Array.isArray(entries)) continue;
      for (const raw of entries) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry["messageId"] !== "number" || typeof entry["excerpt"] !== "string") continue;
        if (!entry["excerpt"].includes(exactValue)) continue;
        targets.push({ kind: "episode-detail", episodeId: episode.id, excerptMessageId: entry["messageId"] });
        detailCount++;
      }
    }
    if (rawIds.length + detailCount > 512) {
      return { stored: false, memoriesCount: 0, code: "unavailable", message: `sealed durable ${stored.id} stored but redaction refused: ${rawIds.length + detailCount} containing surfaces exceed the 512-target forget limit` };
    }
    if (targets.length > 0) {
      try {
        forgetPersonalImpl(this.db, {
          owner: ctx.userId,
          callerOwner: ctx.userId,
          targets,
          actorId: ctx.actorId,
        });
      } catch (err) {
        return { stored: false, memoriesCount: 0, code: "unavailable", message: `sealed durable ${stored.id} stored but redaction failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return { stored: true, memoriesCount: 1, memoryId: stored.id, semanticRevision: stored.revision };
  }

  /**
   * New-model direct store for ready datasets (MCP memory_store, host
   * lifecycle store, CLI store). Writes durable knowledge with `inference`
   * authority — a direct assertion is unvalidated until an owner correction
   * or sleep-validated user evidence says otherwise. Evidence is real source
   * quotes when the caller supplies owned source messages, otherwise
   * `direct` self-evidence (the stored excerpt itself, preserved alongside
   * the row). Classification 3 routes to the sealed path: the exact value
   * is encrypted into a sealed durable and redacted from raw sources.
   * Instant-store enrichment fields without a durable column (emotion,
   * confidence, trust, relevance) are intentionally dropped; authority and
   * evidence carry the semantics now.
   */
  private async appendInstantPersonal(
    ctx: EffectivePrivateMutationContext,
    input: InstantStoreParams,
  ): Promise<InstantStoreResult> {
    const classification = input.classification ?? 1;
    if (!Number.isSafeInteger(classification) || classification < 0 || classification > 3) {
      return { stored: false, memoriesCount: 0, code: "validation_error", message: "classification must be 0-3" };
    }
    if (classification >= 3) {
      return this.appendSealedPersonal(ctx, input);
    }
    const content = input.contentEn?.trim();
    if (!content) return { stored: false, memoriesCount: 0, code: "validation_error", message: "content-en is required" };

    let evidence: DurableInput["evidence"];
    if (input.sourceMessageIds?.trim()) {
      let ids: number[];
      try {
        ids = parseSourceMessageIds(input.sourceMessageIds);
      } catch {
        return { stored: false, memoriesCount: 0, code: "validation_error", message: "invalid source message ids" };
      }
      evidence = [];
      for (const id of ids) {
        const msg = this.db.prepare("SELECT role, content FROM messages WHERE id = ? AND user_id = ?").get(id, ctx.userId) as
          | { role: string; content: string } | undefined;
        if (!msg) {
          return { stored: false, memoriesCount: 0, code: "validation_error", message: `source message ${id} not found or not owned` };
        }
        evidence.push({
          kind: msg.role === "user" ? "user_message" : "agent_message",
          ref: `messages:${id}`,
          excerpt: msg.content.slice(0, 500),
          classification: 1,
        });
      }
      if (evidence.length === 0) {
        return { stored: false, memoriesCount: 0, code: "validation_error", message: "no usable source evidence" };
      }
    } else {
      evidence = [{ kind: "direct", ref: "direct", excerpt: content.slice(0, 500), classification }];
    }

    const duplicate = this.db.prepare(
      "SELECT id, revision FROM long_term_memories WHERE user_id = ? AND content = ? ORDER BY created_at DESC LIMIT 1",
    ).get(ctx.userId, content) as { id: number; revision: number } | undefined;
    if (duplicate) return { stored: true, memoriesCount: 1, memoryId: duplicate.id, semanticRevision: duplicate.revision };

    const provenance: Record<string, unknown> = { topic: input.topic ?? "general", actor: ctx.actorId, direct: true };
    // C8: carry step-04 graph proposals through for projection derivation.
    // Syntactic parse here; semantic appearance/bounds enforced in storeDurable.
    const graphEntities = parseGraphEntities(input.graphEntitiesRaw);
    const graphRelations = parseGraphRelations(input.graphRelationsRaw);
    if (graphEntities || graphRelations) {
      provenance["graph"] = {
        ...(graphEntities ? { entities: graphEntities } : {}),
        ...(graphRelations ? { relations: graphRelations } : {}),
      };
    }
    try {
      const stored = storeDurable(this.db, {
        userId: ctx.userId,
        memoryType: input.memoryType || "fact",
        content,
        contentOriginal: input.contentOriginal?.trim() || null,
        authority: "inference",
        authorityBasis: `direct ${ctx.actorId} store`,
        applicabilityScope: { scope: "general" },
        provenance,
        evidence,
        classification,
        actorId: ctx.actorId,
      });
      return { stored: true, memoriesCount: 1, memoryId: stored.id, semanticRevision: stored.revision };
    } catch (err) {
      return { stored: false, memoriesCount: 0, code: "validation_error", message: err instanceof Error ? err.message : String(err) };
    }
  }
}

class CascadeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CascadeValidationError";
  }
}

