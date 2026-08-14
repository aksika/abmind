// #354 Phase 2: when a credential is stored as class=3, scan the last N user messages
// for this user and redact any pattern matches from messages.content.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "./memory-manager.js";
import { makeMemoryTestConfig } from "./test-helpers.js";
import type { MemoryConfig } from "./memory-config.js";

const CREDENTIAL = "sk-1234567890abcdef1234567890abcdef";
const REDACTED_PREFIX = "sk-***REDACTED***";

async function makeManager(tmpDir: string, overrides: Partial<MemoryConfig> = {}): Promise<MemoryManager> {
  const cfg = { ...makeMemoryTestConfig(tmpDir), ...overrides };
  const mgr = new MemoryManager(cfg);
  await mgr.initialize();
  return mgr;
}

describe("#354 Phase 2 — instantStore redacts recent messages on class=3 store", () => {
  let tmpDir: string;
  let manager: MemoryManager;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "354-"));
    process.env.ABMIND_USER_ID = "aksika";
    // Ensure an encryption key exists so class=3 stores can proceed.
    process.env.ABMIND_DB_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    manager = await makeManager(tmpDir);
  });

  afterEach(() => {
    manager.close();
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ABMIND_DB_KEY;
  });

  it("redacts credential from the most recent user message when stored as class=3", async () => {
    const now = Date.now();
    manager.recordMessage({
      userId: "aksika",
      sessionId: "s1",
      role: "user",
      content: `my API key is ${CREDENTIAL}`,
      timestamp: now,
    });

    const result = await manager.editor.instantStore({
      userId: "aksika",
      sealedLabel: "API credential",
      contentOriginal: CREDENTIAL,
      memoryType: "fact",
      emotionScore: 0,
      classification: 3,
    });

    expect(result.stored).toBe(true);

    const db = (manager as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare("SELECT content FROM messages WHERE user_id = 'aksika' LIMIT 1").get() as { content: string };
    expect(row.content).toContain(REDACTED_PREFIX);
    expect(row.content).not.toContain(CREDENTIAL);
  });

  it("redacts credential when it's in message 3 of 10", async () => {
    const now = Date.now();
    const db = (manager as unknown as { db: import("better-sqlite3").Database }).db;

    // Insert 10 user messages; the 8th (3rd from newest) has the credential
    for (let i = 0; i < 10; i++) {
      const isCredMsg = i === 7;
      manager.recordMessage({
        userId: "aksika",
        sessionId: "s1",
        role: "user",
        content: isCredMsg ? `here is my token: ${CREDENTIAL}` : `random message ${i}`,
        timestamp: now + i * 1000,
      });
    }

    await manager.editor.instantStore({
      userId: "aksika",
      sealedLabel: "API credential",
      contentOriginal: CREDENTIAL,
      memoryType: "fact",
      emotionScore: 0,
      classification: 3,
    });

    const all = db.prepare("SELECT content FROM messages WHERE user_id = 'aksika' ORDER BY timestamp ASC").all() as Array<{ content: string }>;
    // The credential-bearing message should be redacted
    expect(all[7]!.content).toContain(REDACTED_PREFIX);
    expect(all[7]!.content).not.toContain(CREDENTIAL);
    // Other messages should be untouched
    expect(all[0]!.content).toBe("random message 0");
    expect(all[9]!.content).toBe("random message 9");
  });

  it("does not redact when no recent message matches a pattern", async () => {
    const now = Date.now();
    manager.recordMessage({
      userId: "aksika",
      sessionId: "s1",
      role: "user",
      content: "please remember my nickname is Aksi",
      timestamp: now,
    });

    const result = await manager.editor.instantStore({
      userId: "aksika",
      sealedLabel: "user's nickname is Aksi",
      contentOriginal: "please remember my nickname is Aksi",
      memoryType: "fact",
      emotionScore: 0,
      classification: 3, // stored as SECRET but content isn't actually credential-shaped
    });

    expect(result.stored).toBe(true);

    const db = (manager as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare("SELECT content FROM messages WHERE user_id = 'aksika' LIMIT 1").get() as { content: string };
    expect(row.content).toBe("please remember my nickname is Aksi");
  });

  it("does NOT scan or redact when classification < 3", async () => {
    const now = Date.now();
    manager.recordMessage({
      userId: "aksika",
      sessionId: "s1",
      role: "user",
      content: `random: ${CREDENTIAL}`,
      timestamp: now,
    });

    await manager.editor.instantStore({
      userId: "aksika",
      contentEn: "something unrelated",
      contentOriginal: "something unrelated",
      memoryType: "fact",
      emotionScore: 0,
      classification: 2, // NOT secret
    });

    const db = (manager as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare("SELECT content FROM messages WHERE user_id = 'aksika' LIMIT 1").get() as { content: string };
    // Credential still present — no redaction triggered
    expect(row.content).toContain(CREDENTIAL);
  });

  it("cross-user isolation — aksika's class=3 store does not touch adrika's messages", async () => {
    const now = Date.now();
    manager.recordMessage({
      userId: "aksika",
      sessionId: "s1",
      role: "user",
      content: `aksika's key: ${CREDENTIAL}`,
      timestamp: now,
    });
    // Adrika's message also contains the same credential (contrived, but tests the filter)
    manager.recordMessage({
      userId: "adrika",
      sessionId: "s2",
      role: "user",
      content: `adrika's key: ${CREDENTIAL}`,
      timestamp: now + 500,
    });

    await manager.editor.instantStore({
      userId: "aksika",
      sealedLabel: "API credential",
      contentOriginal: CREDENTIAL,
      memoryType: "fact",
      emotionScore: 0,
      classification: 3,
    });

    const db = (manager as unknown as { db: import("better-sqlite3").Database }).db;
    const aksikaMsg = db.prepare("SELECT content FROM messages WHERE user_id = 'aksika' LIMIT 1").get() as { content: string };
    const adrikaMsg = db.prepare("SELECT content FROM messages WHERE user_id = 'adrika' LIMIT 1").get() as { content: string };

    // aksika's message redacted
    expect(aksikaMsg.content).not.toContain(CREDENTIAL);
    expect(aksikaMsg.content).toContain(REDACTED_PREFIX);
    // adrika's message NOT redacted — it belongs to a different user
    expect(adrikaMsg.content).toContain(CREDENTIAL);
  });

  it("is idempotent — second class=3 store does not break already-redacted messages", async () => {
    const now = Date.now();
    manager.recordMessage({
      userId: "aksika",
      sessionId: "s1",
      role: "user",
      content: `my key: ${CREDENTIAL}`,
      timestamp: now,
    });

    // First store: redacts
    await manager.editor.instantStore({
      userId: "aksika",
      sealedLabel: "API credential",
      contentOriginal: CREDENTIAL,
      memoryType: "fact",
      emotionScore: 0,
      classification: 3,
    });

    // Second store: should be a no-op on the already-redacted message
    const result = await manager.editor.instantStore({
      userId: "aksika",
      sealedLabel: "API credential",
      contentOriginal: CREDENTIAL + "ABC",
      memoryType: "fact",
      emotionScore: 0,
      classification: 3,
    });

    expect(result.stored).toBe(true);

    const db = (manager as unknown as { db: import("better-sqlite3").Database }).db;
    const row = db.prepare("SELECT content FROM messages WHERE user_id = 'aksika' LIMIT 1").get() as { content: string };
    expect(row.content).toContain(REDACTED_PREFIX);
    // Still not containing the original credential
    expect(row.content).not.toContain(CREDENTIAL);
  });

  it("catches the credential when assistant echoes it back", async () => {
    const now = Date.now();
    // User asks without directly including the credential in this turn
    manager.recordMessage({
      userId: "aksika",
      sessionId: "s1",
      role: "user",
      content: "can you confirm my key?",
      timestamp: now,
    });
    // Assistant echoes the credential in its response
    manager.recordMessage({
      userId: "aksika",
      sessionId: "s1",
      role: "assistant",
      content: `sure — your key is ${CREDENTIAL}`,
      timestamp: now + 100,
    });

    await manager.editor.instantStore({
      userId: "aksika",
      sealedLabel: "API credential",
      contentOriginal: CREDENTIAL,
      memoryType: "fact",
      emotionScore: 0,
      classification: 3,
    });

    const db = (manager as unknown as { db: import("better-sqlite3").Database }).db;
    const assistantMsg = db.prepare("SELECT content FROM messages WHERE user_id = 'aksika' AND role = 'assistant'").get() as { content: string };
    // Assistant echo is redacted (scan includes both roles)
    expect(assistantMsg.content).toContain(REDACTED_PREFIX);
    expect(assistantMsg.content).not.toContain(CREDENTIAL);
  });
});
