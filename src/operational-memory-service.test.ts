import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { initializeDatabase } from "./memory-db.js";
import { OperationalMemoryService } from "./operational-memory-service.js";
import { OperationalMemoryStore } from "./operational-memory-store.js";

describe("OperationalMemoryService", () => {
  let directory: string;
  let db: Database.Database;
  let service: OperationalMemoryService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "op-mem-service-"));
    db = initializeDatabase(join(directory, "memory.db"));
    service = new OperationalMemoryService(new OperationalMemoryStore(db));
  });

  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("canonicalizes the selected write scope and rejects conflicting dimensions", async () => {
    const created = await service.submitDraft({
      lesson: "Use the shared scope helper",
      scopeLevel: "platform",
      platform: "  TELEGRAM ",
      confidence: 80,
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.value.suggestedPlatform).toBe("telegram");

    const conflicting = await service.submitDraft({
      lesson: "Must fail closed",
      scopeLevel: "platform",
      platform: "telegram",
      host: "molty",
      confidence: 80,
    });
    expect(conflicting).toMatchObject({ ok: false, code: "validation_error" });

    const empty = await service.recall({ platform: "   " });
    expect(empty).toMatchObject({ ok: false, code: "validation_error" });
  });

  it("returns the memory identity in stale CAS conflicts", async () => {
    const draft = await service.submitDraft({ lesson: "Initial", scopeLevel: "global", confidence: 80 });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const promoted = await service.promoteDraft({ draftId: draft.value.id, actorId: "agent", mutationReason: "curate" });
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;

    const stale = await service.revise({
      memoryId: promoted.value.id,
      expectedContentHash: "stale",
      content: "Changed",
      scopeLevel: "global",
      confidence: 80,
      actorId: "agent",
      mutationReason: "test",
    });
    expect(stale).toMatchObject({
      ok: false,
      code: "conflict",
      current: { kind: "memory", memoryId: promoted.value.id },
    });
  });

  it("rejects invalid page limits and never emits a cursor after exhaustion", async () => {
    expect(await service.listDrafts({ limit: 0 })).toMatchObject({ ok: false, code: "validation_error" });
    expect(await service.listDrafts({ limit: 101 })).toMatchObject({ ok: false, code: "validation_error" });

    const draft = await service.submitDraft({ lesson: "One", scopeLevel: "global", confidence: 80 });
    expect(draft.ok).toBe(true);
    const page = await service.listDrafts({ limit: 100 });
    expect(page).toMatchObject({ ok: true, value: { items: [{ lesson: "One" }] } });
    if (page.ok) expect(page.value.nextCursor).toBeUndefined();
  });

  it("recalls exact canonical scopes in specificity order", async () => {
    const global = await service.submitDraft({ lesson: "Global guidance", scopeLevel: "global", confidence: 80 });
    const platform = await service.submitDraft({ lesson: "Platform guidance", scopeLevel: "platform", platform: " TELEGRAM ", confidence: 80 });
    expect(global.ok && platform.ok).toBe(true);
    if (!global.ok || !platform.ok) return;
    expect((await service.promoteDraft({ draftId: global.value.id, actorId: "agent", mutationReason: "curate" })).ok).toBe(true);
    expect((await service.promoteDraft({ draftId: platform.value.id, actorId: "agent", mutationReason: "curate" })).ok).toBe(true);

    const recalled = await service.recall({ platform: " telegram ", limit: 10 });
    expect(recalled.ok).toBe(true);
    if (!recalled.ok) return;
    expect(recalled.value.items.map(item => item.matchedScopeLevel)).toEqual(["platform", "global"]);
    expect(recalled.value.nextCursor).toBeUndefined();
  });
});
