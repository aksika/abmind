/**
 * ingest-pipeline.ts — Document ingestion: scan → dedup → store → record.
 * Agent pre-summarizes content before calling this. Pipeline is pure data.
 */

import type Database from "better-sqlite3";
import { scanForInjection } from "./injection-scanner.js";
import { logInfo, logWarn } from "./mem-logger.js";
import { encrypt, hasKey } from "./crypto.js";

const TAG = "ingest";
const RATE_LIMIT_MS = 60_000; // 1 minute between ingestions per user

export interface IngestMetadata {
  userId: string;
  sourceType: "attachment" | "email" | "local_file" | "agent_report";
  identifier: string;
  trust: number;
  classification: number;
  topic?: string;
}

export interface IngestResult {
  ingested: boolean;
  skipped: boolean;
  reason?: string;
  documentId?: number;
  memoriesStored?: number;
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
    // 1. Rate limit
    const lastIngest = this.db.prepare(
      "SELECT MAX(ingested_at) as ts FROM ingested_documents WHERE user_id = ?"
    ).get(metadata.userId) as { ts: number | null } | undefined;
    if (lastIngest?.ts && (Date.now() - lastIngest.ts) < RATE_LIMIT_MS) {
      return { ingested: false, skipped: true, reason: "rate_limit" };
    }

    // 2. Dedup
    const existing = this.db.prepare(
      "SELECT id FROM ingested_documents WHERE source_type = ? AND identifier = ? AND user_id = ?"
    ).get(metadata.sourceType, metadata.identifier, metadata.userId);
    if (existing) {
      return { ingested: false, skipped: true, reason: "already_ingested" };
    }

    // 3. Injection scan
    const scanResult = scanForInjection(content);
    if (!scanResult.safe) {
      logWarn(TAG, `Injection detected in ${metadata.identifier}: score=${scanResult.score}`);
      return { ingested: false, skipped: true, reason: "injection_detected" };
    }

    // 4. Store as memory
    const now = Date.now();
    const isSecret = (metadata.classification ?? 1) >= 3 && hasKey();
    const storeContent = isSecret ? encrypt(content) : content;
    const stmt = this.db.prepare(`
      INSERT INTO extracted_memories (
        user_id, content_original, content_en, memory_type, source_timestamp,
        created_at, emotion_score, confidence, classification, trust, integrity,
        credibility, source_type, topic, encrypted
      ) VALUES (?, ?, ?, 'fact', ?, ?, 0, 3, ?, ?, 2, 6, 'ingested', ?, ?)
    `);
    stmt.run(
      metadata.userId, storeContent, storeContent, now, now,
      metadata.classification, metadata.trust, metadata.topic ?? "ingested",
      isSecret ? 1 : 0
    );

    // 5. Record
    const record = this.db.prepare(
      "INSERT INTO ingested_documents (user_id, source_type, identifier, chunk_count, ingested_at) VALUES (?, ?, ?, 1, ?)"
    ).run(metadata.userId, metadata.sourceType, metadata.identifier, now);

    logInfo(TAG, `Ingested: ${metadata.identifier} (${metadata.sourceType}, ${content.length} chars)`);

    return {
      ingested: true,
      skipped: false,
      documentId: Number(record.lastInsertRowid),
      memoriesStored: 1,
    };
  }
}
