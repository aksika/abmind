/**
 * ingest-pipeline.ts — Document ingestion: scan → dedup → store → record.
 * Agent pre-summarizes content before calling this. Pipeline is pure data.
 */

import type Database from "better-sqlite3";
import { scanForInjection } from "./injection-scanner.js";
import { logInfo, logWarn } from "./mem-logger.js";
import { assertPrimaryMemoryOwner, PrimaryIdentityError } from "./user-utils.js";
import { createSealedProjection } from "./sealed-memory.js";
import { isPersonalReady } from "./personal-schema.js";
import { storeDurable } from "./personal-durable.js";

const TAG = "ingest";
const RATE_LIMIT_MS = 60_000; // 1 minute between ingestions per user

export interface IngestMetadata {
  userId: string;
  sourceType: "attachment" | "email" | "local_file" | "agent_report";
  identifier: string;
  trust: number;
  classification: number;
  topic?: string;
  /** Class-3 only (#1660): descriptive label stored in `content_en` — never the value. */
  sealedLabel?: string;
  /** Class-3 only (#1660): non-sensitive retrieval keyword. */
  sealedKeyword?: string;
}

export interface IngestResult {
  ingested: boolean;
  skipped: boolean;
  reason?: string;
  documentId?: number;
  memoriesStored?: number;
  /**
   * Policy/configuration refusal (non-primary owner or missing identity).
   * Distinct from a normal `skipped` dedup/rate-limit result: nothing was
   * written and the caller should surface this as an error.
   */
  refused?: boolean;
}

export class IngestPipeline {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Ingest pre-summarized content into memory.
   * Agent has already read + summarized the document. This just stores it safely.
   * @param content — the summary/text to store (NOT raw document — agent pre-processed it)
   * @param metadata — source info, trust, classification
   */
  ingest(content: string, metadata: IngestMetadata): IngestResult {
    // 0. Master-only creation gate: only the canonical primary identity may
    //    create memory rows. Runs before rate-limit/dedup, so a
    //    refusal writes neither table.
    let canonicalUserId: string;
    try {
      canonicalUserId = assertPrimaryMemoryOwner(metadata.userId);
    } catch (err) {
      if (err instanceof PrimaryIdentityError) {
        return { ingested: false, skipped: false, refused: true, reason: `[${err.code}] ${err.message}` };
      }
      throw err;
    }

    // 1. Rate limit
    const lastIngest = this.db.prepare(
      "SELECT MAX(ingested_at) as ts FROM ingested_documents WHERE user_id = ?"
    ).get(canonicalUserId) as { ts: number | null } | undefined;
    if (lastIngest?.ts && (Date.now() - lastIngest.ts) < RATE_LIMIT_MS) {
      return { ingested: false, skipped: true, reason: "rate_limit" };
    }

    // 2. Dedup
    const existing = this.db.prepare(
      "SELECT id FROM ingested_documents WHERE source_type = ? AND identifier = ? AND user_id = ?"
    ).get(metadata.sourceType, metadata.identifier, canonicalUserId);
    if (existing) {
      return { ingested: false, skipped: true, reason: "already_ingested" };
    }

    // 3. Injection scan
    const scanResult = scanForInjection(content);
    if (!scanResult.safe) {
      logWarn(TAG, `Injection detected in ${metadata.identifier}: score=${scanResult.score}`);
      return { ingested: false, skipped: true, reason: "injection_detected" };
    }

    // 4. Store as memory. Converted datasets store durable knowledge through
    //    the single personal writer, which indexes the row for recall in the
    //    same transaction and honors forget markers; the legacy table is not
    //    served there.
    if (isPersonalReady(this.db)) {
      return this.ingestDurable(content, metadata, canonicalUserId);
    }
    const now = Date.now();
    const isSecret = (metadata.classification ?? 1) >= 3;
    if (isSecret) {
      // #1660: class-3 ingest requires a descriptive label; the exact value
      // goes only into the sealed projection (encrypted content_original).
      if (!metadata.sealedLabel?.trim()) {
        return { ingested: false, skipped: false, refused: true, reason: "class-3 ingest requires sealedLabel" };
      }
      let projection: ReturnType<typeof createSealedProjection>;
      try {
        projection = createSealedProjection({
          exactValue: content,
          label: metadata.sealedLabel.trim(),
          keyword: metadata.sealedKeyword,
        });
      } catch (err) {
        return { ingested: false, skipped: false, refused: true, reason: `class-3 ingest refused: ${err instanceof Error ? err.message : String(err)}` };
      }
      const stmt = this.db.prepare(`
        INSERT INTO extracted_memories (
          user_id, content_original, content_en, memory_type, source_timestamp,
          created_at, emotion_score, confidence, classification, trust, integrity,
          credibility, source_type, topic, encrypted, preserved_keyword,
          sealed_format_version
        ) VALUES (?, ?, ?, 'fact', ?, ?, 0, 3, ?, ?, 2, 6, 'ingested', ?, 1, ?, ?)
      `);
      stmt.run(
        canonicalUserId, projection.contentOriginal, projection.contentEn, now, now,
        metadata.classification, metadata.trust, metadata.topic ?? "ingested",
        projection.preservedKeyword, projection.sealedFormatVersion
      );
    } else {
      const storeContent = content;
      const stmt = this.db.prepare(`
        INSERT INTO extracted_memories (
          user_id, content_original, content_en, memory_type, source_timestamp,
          created_at, emotion_score, confidence, classification, trust, integrity,
          credibility, source_type, topic, encrypted
        ) VALUES (?, ?, ?, 'fact', ?, ?, 0, 3, ?, ?, 2, 6, 'ingested', ?, 0)
      `);
      stmt.run(
        canonicalUserId, storeContent, storeContent, now, now,
        metadata.classification, metadata.trust, metadata.topic ?? "ingested"
      );
    }

    // 5. Record
    const record = this.db.prepare(
      "INSERT INTO ingested_documents (user_id, source_type, identifier, chunk_count, ingested_at) VALUES (?, ?, ?, 1, ?)"
    ).run(canonicalUserId, metadata.sourceType, metadata.identifier, now);

    logInfo(TAG, `Ingested: ${metadata.identifier} (${metadata.sourceType}, ${content.length} chars)`);

    return {
      ingested: true,
      skipped: false,
      documentId: Number(record.lastInsertRowid),
      memoriesStored: 1,
    };
  }

  /**
   * Ready-dataset ingest: one durable knowledge row plus the document record,
   * atomically. Ingested text is owner-supplied content without a
   * conversation source, so it carries `direct` evidence and inference
   * authority (never user authority). Sealed (class-3) ingest is refused like
   * every other sealed direct store on the new model.
   */
  private ingestDurable(content: string, metadata: IngestMetadata, userId: string): IngestResult {
    const classification = metadata.classification ?? 1;
    if (classification >= 3) {
      return { ingested: false, skipped: false, refused: true, reason: "sealed ingest is unsupported on the new model" };
    }
    const text = content.trim();
    if (!text) return { ingested: false, skipped: true, reason: "empty_content" };
    try {
      const documentId = this.db.transaction((): number => {
        storeDurable(this.db, {
          userId,
          memoryType: "fact",
          content: text,
          authority: "inference",
          authorityBasis: `ingested ${metadata.sourceType} document`,
          applicabilityScope: { scope: "general" },
          provenance: {
            topic: metadata.topic ?? "ingested",
            ingested: { sourceType: metadata.sourceType, identifier: metadata.identifier, trust: metadata.trust },
          },
          evidence: [{ kind: "direct", ref: "direct", excerpt: text.slice(0, 500), classification }],
          classification,
          actorId: "ingest",
        });
        const record = this.db.prepare(
          "INSERT INTO ingested_documents (user_id, source_type, identifier, chunk_count, ingested_at) VALUES (?, ?, ?, 1, ?)",
        ).run(userId, metadata.sourceType, metadata.identifier, Date.now());
        return Number(record.lastInsertRowid);
      })();
      logInfo(TAG, `Ingested: ${metadata.identifier} (${metadata.sourceType}, ${text.length} chars, durable)`);
      return { ingested: true, skipped: false, documentId, memoriesStored: 1 };
    } catch (err) {
      // storeDurable rejects forgotten sources, invalid classification and
      // unready stores; nothing was written (the transaction rolled back).
      return { ingested: false, skipped: false, refused: true, reason: `ingest refused: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
