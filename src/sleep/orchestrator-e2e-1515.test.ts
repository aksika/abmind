/**
 * orchestrator-e2e-1515.test.ts — #1515 largest practical cross-repo lifecycle.
 *
 * Production composition (fixture only the model edges):
 *   real sleep review + store -> private local protocol -> simulated restart ->
 *   nextPending -> simulated platform delivery (durable assistant record) ->
 *   asked CAS -> normal user reply -> next-sleep transcript (marker stripped,
 *   question retained beside the reply). Plus the crash-window recovery
 *   scenario: durable assistant write followed by a failed asked mutation —
 *   restart may repeat, stored context survives, later CAS remains safe.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSleepCycle } from "./orchestrator.js";
import { setupTestEnv, type TestEnv, type MockRuntime } from "./test-harness.js";
import type { SleepRunOptions, SleepCompletionRequest } from "./contracts.js";
import { getMemoryDb } from "../memory-manager.js";
import { AbmindService } from "../abmind-service.js";
import { EmbeddedTransport } from "../embedded-transport.js";
import { AbmindClient } from "../abmind-client.js";

function baseOpts(env: TestEnv, overrides: Partial<SleepRunOptions> = {}): SleepRunOptions {
  return {
    runtime: env.runtime,
    now: () => env.now,
    timeoutMs: 60_000,
    fresh: false,
    betweenStepBackoffMs: () => 0,
    memoryConfigOverride: { memoryDir: env.memoryDir, memoryEnabled: true },
    ...overrides,
  };
}

function defaultCannedResponses(env: TestEnv): void {
  env.runtime.setDefault("ok");
  env.runtime.setResponse("Update the summary incorporating", "- user asked about X\n- decision Y made\n- a second durable fact worth remembering across sessions");
  env.runtime.setResponse("store a memory using abmind store", "2 memories stored");
  env.runtime.setResponse("retrospective", "Today went well. Flagged nothing.");
}

function seedExistingMemory(env: TestEnv, id: number): void {
  const db = getMemoryDb(env.memory)!;
  const yesterday = env.now - 86_400_000;
  db.prepare(
    `INSERT INTO extracted_memories
       (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at,
        valid_to, classification, semantic_revision)
     VALUES (?, 'master', ?, ?, 'fact', ?, ?, NULL, 1, 1)`,
  ).run(id, "flummox seed fact 99", "flummox seed fact 99", yesterday, yesterday);
}

function seedRunTimeExtractions(env: TestEnv, ids: number[]): void {
  const inserted = new Set<number>();
  const origComplete = env.runtime.complete.bind(env.runtime);
  env.runtime.complete = async (request: SleepCompletionRequest) => {
    if (request.prompt.includes("store a memory using abmind store")) {
      const db = getMemoryDb(env.memory)!;
      for (const id of ids) {
        if (inserted.has(id)) continue;
        inserted.add(id);
        db.prepare(
          `INSERT INTO extracted_memories
             (id, user_id, content_original, content_en, memory_type, source_timestamp, created_at)
           VALUES (?, 'master', ?, ?, 'fact', ?, ?)`,
        ).run(id, `flummox contradiction event ${id}`, `flummox contradiction event ${id}`, env.now, env.now);
      }
      return "2 memories stored";
    }
    return origComplete(request);
  };
}

/** Build an embedded client over a fresh AbmindService (simulated restart). */
function restartClient(env: TestEnv): { client: AbmindClient; service: AbmindService } {
  const service = new AbmindService({
    serverInstanceId: "e2e-restart",
    mode: "embedded",
    manager: env.memory,
    operational: null,
    requestLedgerDb: getMemoryDb(env.memory)!,
  });
  const transport = new EmbeddedTransport(service, {
    principalId: "master",
    role: "local_user",
    grantedDomains: new Set(["system", "private"]),
    authenticatedBy: "embedded",
  });
  return { client: new AbmindClient(transport), service };
}

describe("#1515 cross-repo lifecycle E2E", () => {
  it("sleep -> store -> protocol -> restart -> boot -> delivery -> asked CAS -> reply -> clean transcript", async () => {
    // The harness "today" is pinned to the real date so the question row's
    // seven-day expiry holds against the protocol layer's real clock.
    const env = await setupTestEnv({ seedMessages: 5, today: new Date().toISOString().slice(0, 10) });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions",
      'ASK old_id=1001 new_id=2001 question="Did you prefer the older or the newer living arrangement?"\nNO_QUESTIONS\n');
    try {
      // 1. Production sleep review + store.
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      const db = getMemoryDb(env.memory)!;
      const row = db.prepare("SELECT id, status, question FROM dream_questions").get() as { id: string; status: string; question: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.status).toBe("pending");
      const questionId = row!.id;

      // 2. Simulated restart: a fresh service over the same DB.
      const { client } = restartClient(env);

      // 3. Boot preload reads at most one pending question for the owner.
      const pending = await client.privateMemory.dreamQuestions.nextPending("master");
      expect(pending?.id).toBe(questionId);

      // 4. Simulated platform delivery: the abtars pipeline stores the
      // composed text with the storage-only wake-up marker.
      const stored = await client.privateMemory.recordMessage({
        userId: "master", sessionId: "master_A_01", role: "assistant",
        content: `[WAKE-UP QUESTION id=${questionId}] Hello! How are you today?\n\nDreamy needs your help with one memory: Did you prefer the older or the newer living arrangement?`,
        timestamp: Date.now(),
      });
      expect(stored.id).toBeGreaterThan(0);

      // 5. Asked CAS settles once with the delivery key; replay is idempotent.
      const asked = await client.privateMemory.dreamQuestions.markAsked(
        { userId: "master", questionId, deliveryKey: "delivery-key-1" }, "idem-ask-1",
      );
      expect(asked.status).toBe("asked");
      const replay = await client.privateMemory.dreamQuestions.markAsked(
        { userId: "master", questionId, deliveryKey: "delivery-key-1" }, "idem-ask-1",
      );
      expect(replay.status).toBe("asked");

      // 6. The user's normal reply follows the question.
      await client.privateMemory.recordMessage({
        userId: "master", sessionId: "master_A_01", role: "user",
        content: "I preferred the newer one, actually.",
        timestamp: Date.now(),
      });

      // 7. Next sleep: the transcript keeps the assistant question beside the
      // reply but strips the storage marker. Fresh cycle so the whole step
      // loop re-renders; the mock captures the retrospective prompt which
      // renders CLEAN_MESSAGES.
      env.runtime.setResponse("Clarification Questions", "NO_CONTRADICTIONS\nNO_RELATIONS\nNO_QUESTIONS\n");
      env.runtime.setResponse("Update the summary incorporating", "- user answered a clarification question with a durable preference worth remembering");
      const second = await runSleepCycle(baseOpts(env, { fresh: true }));
      expect(second.status).toBe("completed");
      // Select by exact stepId, not prompt substring: on curation days
      // (default Sunday) later weekly steps (e.g. consolidation) also mention
      // "retrospective" in their prompts and would shadow the real transcript.
      const retroPrompts = env.runtime.allCalls().filter(c => c.stepId === "retrospective").map(c => c.prompt);
      const transcript = retroPrompts.at(-1) ?? "";
      expect(transcript).toContain("I preferred the newer one, actually.");
      expect(transcript).toContain("Dreamy needs your help with one memory: Did you prefer the older or the newer living arrangement?");
      expect(transcript).not.toContain("[WAKE-UP QUESTION");
      expect(transcript).not.toContain(questionId);
    } finally { env.cleanup(); }
  });

  it("durable assistant write followed by a failed asked mutation — stored context survives, row stays pending, later CAS is safe", async () => {
    const env = await setupTestEnv({ seedMessages: 5, today: new Date().toISOString().slice(0, 10) });
    defaultCannedResponses(env);
    seedExistingMemory(env, 1001);
    seedRunTimeExtractions(env, [2001, 2002]);
    env.runtime.setResponse("Clarification Questions",
      'ASK old_id=1001 new_id=2001 question="Did you prefer the older or the newer living arrangement?"\nNO_QUESTIONS\n');
    try {
      const result = await runSleepCycle(baseOpts(env));
      expect(result.status).toBe("completed");
      const db = getMemoryDb(env.memory)!;
      const row = db.prepare("SELECT id FROM dream_questions").get() as { id: string };
      const questionId = row.id;

      const { client } = restartClient(env);

      // Durable assistant write succeeds...
      const stored = await client.privateMemory.recordMessage({
        userId: "master", sessionId: "master_A_01", role: "assistant",
        content: `[WAKE-UP QUESTION id=${questionId}] Greeting text with question appended.`,
        timestamp: Date.now(),
      });
      expect(stored.id).toBeGreaterThan(0);

      // ...but the asked CAS fails (injected table drop, as if the mutation
      // path broke mid-window).
      db.exec("DROP TABLE dream_questions");

      // A restart repeat may re-ask, but the stored answer context survives.
      const survivor = await client.privateMemory.getRecentConversation({ userId: "master", since: 0, limit: 10 });
      expect(survivor.some(m => m.role === "assistant" && m.content.includes("Greeting text with question appended."))).toBe(true);

      // Recreate the table; the pending row is gone with the drop, so the
      // crash-window contract is at-least-once — never a fake exactly-once.
      db.exec(`
        CREATE TABLE dream_questions (
          id TEXT PRIMARY KEY, user_id TEXT NOT NULL, memory_a_id INTEGER NOT NULL,
          memory_b_id INTEGER NOT NULL, memory_a_revision INTEGER NOT NULL,
          memory_b_revision INTEGER NOT NULL, question TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','asked','resolved','expired','dismissed')),
          source_run_id TEXT NOT NULL, source_step TEXT NOT NULL CHECK (source_step = 'contradiction-and-graph'),
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, asked_at INTEGER,
          resolved_at INTEGER, dismissed_at INTEGER, delivery_key TEXT,
          CHECK (memory_a_id < memory_b_id)
        )
      `);
      // A later CAS against the recreated table is safe and bounded.
      const later = await client.privateMemory.dreamQuestions.markAsked(
        { userId: "master", questionId, deliveryKey: "delivery-key-2" }, "idem-ask-2",
      );
      expect(later.status).toBe("not_found");
    } finally { env.cleanup(); }
  });
});
