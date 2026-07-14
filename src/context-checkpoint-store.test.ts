/**
 * context-checkpoint-store.test.ts — Tests for cumulative checkpoint lineage (#1335).
 *
 * Covers: commit, CAS generation guard, active pointer, stable context view,
 * reset, and digest verification.
 */

import { describe, it, expect, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { CheckpointStore, CHECKPOINT_SCHEMA_SQL, type StableContextView } from "./context-checkpoint-store.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(CHECKPOINT_SCHEMA_SQL);
  return db;
}

const CHAT_ID = "test-session-1335";
const BASE_MSG_ID = 1000;

function makeMessages(count: number): Array<{ id: number; role: string; content: string }> {
  const msgs: Array<{ id: number; role: string; content: string }> = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      id: BASE_MSG_ID + i,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Turn ${i} content: sample message data for cache-stable testing.`,
    });
  }
  return msgs;
}

describe("CheckpointStore", () => {
  let db: Database.Database;
  let store: CheckpointStore;

  beforeAll(() => {
    db = createDb();
    store = new CheckpointStore(db);
  });

  it("starts with no active checkpoint", () => {
    expect(store.getActivePointer(CHAT_ID)).toBeNull();
  });

  it("commits a first checkpoint and advances active pointer", () => {
    const msgs = makeMessages(10);
    const sourceText = msgs.map(m => `${m.role}:${m.content}`).join("\n");
    const sourceDigest = require("node:crypto").createHash("sha256").update(sourceText).digest("hex").slice(0, 16);

    const cpId = store.commitCheckpoint(CHAT_ID, {
      previousCheckpointId: null,
      sourceMessageStart: BASE_MSG_ID,
      sourceMessageEnd: BASE_MSG_ID + 9,
      firstKeptMessageId: BASE_MSG_ID + 10,
      content: "Checkpoint summary of first 10 turns.",
      sourceTokenCount: 1000,
      checkpointTokenCount: 50,
      sourceDigest,
      checkpointDigest: "cp-digest-001",
      summarizerModel: "gpt-4",
      summarizerProvider: "openai",
      activeRequestModel: "gpt-4",
      reason: "headroom",
      budgetJson: JSON.stringify({ maxHistoryTokens: 10000, minRecentTokens: 2000 }),
      classification: 1,
      promptVersion: "v1",
      schemaVersion: 1,
      serializerVersion: "v1",
    }, 0);

    expect(cpId).toBeGreaterThan(0);

    const ptr = store.getActivePointer(CHAT_ID);
    expect(ptr).not.toBeNull();
    expect(ptr!.checkpointId).toBe(cpId);
    // #1335 finding #4: first commit advances the pointer from the absent
    // state (generation 0) to generation 1 so a concurrent expected-zero
    // writer is stale and rejected.
    expect(ptr!.generation).toBe(1);
  });

  it("rejects a concurrent first commit that also expected generation 0 (#1335 finding #4)", () => {
    // Two writers each observed an absent pointer (expectedGeneration 0) for a
    // fresh session. The first commits successfully; the second's commit must
    // be rejected and must not insert a second null-previous checkpoint.
    const raceChat = "two-writer-initial";
    const msgs = makeMessages(6);
    const sourceText = msgs.map(m => `${m.role}:${m.content}`).join("\n");
    const sourceDigest = require("node:crypto").createHash("sha256").update(sourceText).digest("hex").slice(0, 16);

    const firstId = store.commitCheckpoint(raceChat, {
      previousCheckpointId: null,
      sourceMessageStart: BASE_MSG_ID,
      sourceMessageEnd: BASE_MSG_ID + 5,
      firstKeptMessageId: BASE_MSG_ID + 6,
      content: "First writer checkpoint.",
      sourceTokenCount: 600,
      checkpointTokenCount: 40,
      sourceDigest,
      checkpointDigest: "race-cp-001",
      summarizerModel: "gpt-4",
      summarizerProvider: "openai",
      activeRequestModel: "gpt-4",
      reason: "headroom",
      budgetJson: JSON.stringify({ maxHistoryTokens: 10000, minRecentTokens: 2000 }),
      classification: 1,
      promptVersion: "v1",
      schemaVersion: 1,
      serializerVersion: "v1",
    }, 0);
    expect(firstId).toBeGreaterThan(0);

    // Second writer also observed no pointer and expected generation 0.
    const secondId = store.commitCheckpoint(raceChat, {
      previousCheckpointId: null, // stale: it never saw the first pointer
      sourceMessageStart: BASE_MSG_ID,
      sourceMessageEnd: BASE_MSG_ID + 5,
      firstKeptMessageId: BASE_MSG_ID + 6,
      content: "Second writer checkpoint.",
      sourceTokenCount: 600,
      checkpointTokenCount: 40,
      sourceDigest,
      checkpointDigest: "race-cp-002",
      summarizerModel: "gpt-4",
      summarizerProvider: "openai",
      activeRequestModel: "gpt-4",
      reason: "headroom",
      budgetJson: JSON.stringify({ maxHistoryTokens: 10000, minRecentTokens: 2000 }),
      classification: 1,
      promptVersion: "v1",
      schemaVersion: 1,
      serializerVersion: "v1",
    }, 0);
    expect(secondId).toBe(-1);

    // Active pointer is the first writer's, at generation 1.
    const ptr = store.getActivePointer(raceChat);
    expect(ptr!.checkpointId).toBe(firstId);
    expect(ptr!.generation).toBe(1);

    // Only one checkpoint record exists for this session (the stale loser was
    // not inserted).
    expect(store.getCheckpoints(raceChat).length).toBe(1);
  });

  it("rejects a stale absent-pointer commit that expected a non-zero generation", () => {
    // Caller observed a pointer at generation 5, but the pointer was since
    // reset/removed. An absent pointer must only accept expectedGeneration 0.
    const resetChat = "absent-stale";
    const cpId = store.commitCheckpoint(resetChat, {
      previousCheckpointId: null,
      sourceMessageStart: 0,
      sourceMessageEnd: 0,
      firstKeptMessageId: 1,
      content: "x",
      sourceTokenCount: 1,
      checkpointTokenCount: 1,
      sourceDigest: "d",
      checkpointDigest: "d",
      summarizerModel: null,
      summarizerProvider: null,
      activeRequestModel: "m",
      reason: "headroom",
      budgetJson: "{}",
      classification: 1,
      promptVersion: "v1",
      schemaVersion: 1,
      serializerVersion: "v1",
    }, 0);
    expect(cpId).toBeGreaterThan(0);
    store.resetCheckpoints(resetChat);

    const staleId = store.commitCheckpoint(resetChat, {
      previousCheckpointId: cpId,
      sourceMessageStart: 0,
      sourceMessageEnd: 0,
      firstKeptMessageId: 1,
      content: "y",
      sourceTokenCount: 1,
      checkpointTokenCount: 1,
      sourceDigest: "d2",
      checkpointDigest: "d2",
      summarizerModel: null,
      summarizerProvider: null,
      activeRequestModel: "m",
      reason: "headroom",
      budgetJson: "{}",
      classification: 1,
      promptVersion: "v1",
      schemaVersion: 1,
      serializerVersion: "v1",
    }, 5); // observed generation 5 before reset
    expect(staleId).toBe(-1);
    expect(store.getActivePointer(resetChat)).toBeNull();
  });

  it("rejects stale generation (CAS guard)", () => {
    const msgs = makeMessages(5);
    const sourceText = msgs.map(m => `${m.role}:${m.content}`).join("\n");
    const sourceDigest = require("node:crypto").createHash("sha256").update(sourceText).digest("hex").slice(0, 16);

    // Try to commit with wrong generation
    const cpId = store.commitCheckpoint(CHAT_ID, {
      previousCheckpointId: null,
      sourceMessageStart: BASE_MSG_ID + 10,
      sourceMessageEnd: BASE_MSG_ID + 14,
      firstKeptMessageId: BASE_MSG_ID + 15,
      content: "Checkpoint summary of next 5 turns.",
      sourceTokenCount: 500,
      checkpointTokenCount: 30,
      sourceDigest,
      checkpointDigest: "cp-digest-002-stale",
      summarizerModel: "gpt-4",
      summarizerProvider: "openai",
      activeRequestModel: "gpt-4",
      reason: "headroom",
      budgetJson: JSON.stringify({ maxHistoryTokens: 10000, minRecentTokens: 2000 }),
      classification: 1,
      promptVersion: "v1",
      schemaVersion: 1,
      serializerVersion: "v1",
    }, 42); // wrong generation

    expect(cpId).toBe(-1);

    // Pointer should be unchanged (first commit left it at generation 1)
    const ptr = store.getActivePointer(CHAT_ID);
    expect(ptr!.generation).toBe(1);
  });

  it("commits second checkpoint with correct generation", () => {
    const ptr = store.getActivePointer(CHAT_ID);
    const gen = ptr!.generation;

    const msgs = makeMessages(5);
    const sourceText = msgs.map(m => `${m.role}:${m.content}`).join("\n");
    const sourceDigest = require("node:crypto").createHash("sha256").update(sourceText).digest("hex").slice(0, 16);

    const prevCpId = ptr!.checkpointId;
    const cpId = store.commitCheckpoint(CHAT_ID, {
      previousCheckpointId: prevCpId,
      sourceMessageStart: BASE_MSG_ID + 10,
      sourceMessageEnd: BASE_MSG_ID + 14,
      firstKeptMessageId: BASE_MSG_ID + 15,
      content: "Checkpoint summary of next 5 turns (cumulative).",
      sourceTokenCount: 500,
      checkpointTokenCount: 30,
      sourceDigest,
      checkpointDigest: "cp-digest-002",
      summarizerModel: "gpt-4",
      summarizerProvider: "openai",
      activeRequestModel: "gpt-4",
      reason: "headroom",
      budgetJson: JSON.stringify({ maxHistoryTokens: 8000, minRecentTokens: 1500 }),
      classification: 1,
      promptVersion: "v1",
      schemaVersion: 1,
      serializerVersion: "v1",
    }, gen);

    expect(cpId).toBeGreaterThan(0);

    const newPtr = store.getActivePointer(CHAT_ID);
    expect(newPtr!.checkpointId).toBe(cpId);
    expect(newPtr!.generation).toBe(gen + 1);
  });

  it("getStableContext returns checkpoint + verbatim suffix", () => {
    const msgs = makeMessages(25);
    const view = store.getStableContext(CHAT_ID, msgs, { beforeMessageId: BASE_MSG_ID + 20 });

    expect(view.checkpoint).not.toBeUndefined();
    expect(view.checkpoint!.content).toContain("Checkpoint summary");
    expect(view.messages.length).toBeGreaterThan(0);
    // All returned messages should be within the cursor
    for (const m of view.messages) {
      expect(m.id).toBeLessThan(BASE_MSG_ID + 20);
      expect(m.id).toBeGreaterThanOrEqual(view.checkpoint!.firstKeptMessageId);
    }
    expect(view.stablePrefixDigest).toBeTruthy();
  });

  it("getStableContext without checkpoint returns only raw messages", () => {
    const chat2 = "no-checkpoint-session";
    const msgs = makeMessages(5);
    const view = store.getStableContext(chat2, msgs);

    expect(view.checkpoint).toBeUndefined();
    expect(view.messages.length).toBe(5);
    expect(view.stablePrefixDigest).toBeTruthy();
  });

  it("reset removes active pointer but keeps checkpoint records", () => {
    // Checkpoints should still be queryable
    const checkpointsBefore = store.getCheckpoints(CHAT_ID);
    expect(checkpointsBefore.length).toBeGreaterThan(0);

    store.resetCheckpoints(CHAT_ID);
    expect(store.getActivePointer(CHAT_ID)).toBeNull();

    // Checkpoint records persist
    const checkpointsAfter = store.getCheckpoints(CHAT_ID);
    expect(checkpointsAfter.length).toBe(checkpointsBefore.length);
  });

  it("getCheckpoints returns newest first", () => {
    const checkpoints = store.getCheckpoints(CHAT_ID, 5);
    expect(checkpoints.length).toBeGreaterThan(0);
    for (let i = 1; i < checkpoints.length; i++) {
      expect(checkpoints[i]!.createdAt).toBeLessThanOrEqual(checkpoints[i - 1]!.createdAt);
    }
  });
});
