#!/usr/bin/env node
/**
 * abmind-embed — one-time batch embedding of all extracted_memories.
 *
 * Flags:
 *   --reset  NULL out all embeddings first, then re-embed. Use after switching
 *            EMBEDDING_PROVIDER or EMBEDDING_DIMENSIONS (boot-time dim assertion
 *            in MemoryManager will otherwise refuse to start).
 */
import { requireNativeDep } from "./lib/native-dep.js";
const Database = requireNativeDep("better-sqlite3");
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCliRaw } from "../src/cli-runner-raw.js";
import { abmindHome } from "../src/mem-paths.js";
import { loadEmbedConfig, initVec, vecInsert } from "../src/ollama-embed.js";
import { createEmbeddingProvider } from "../src/embedding-provider.js";

await runCliRaw(import.meta.url, {
  name: "abmind-embed",
  help: `Usage:
  abmind embed [--reset]

Batch-embeds all extracted_memories that don't have an embedding yet.
Requires EMBEDDING_ENABLED=true and a reachable embedding provider.

Flags:
  --reset    NULL out all existing embeddings first, then re-embed everything.
             Use after switching EMBEDDING_PROVIDER or EMBEDDING_DIMENSIONS.`,
  flags: [
    { name: "reset", type: "boolean" },
  ],
  handler: async ({ args }) => {
    const dbPath = join(abmindHome(), "memory", "memory.db");
    if (!existsSync(dbPath)) {
      console.error(`Memory database not found: ${dbPath}`);
      process.exitCode = 1; return;
    }
    const config = loadEmbedConfig();
    if (!config.enabled) {
      console.error("EMBEDDING_ENABLED is not true. Set EMBEDDING_ENABLED=true in .env");
      process.exitCode = 1; return;
    }

    const db = new Database(dbPath);
    const provider = createEmbeddingProvider();
    try {
      try { db.exec("ALTER TABLE extracted_memories ADD COLUMN embedding BLOB"); } catch { /* already exists */ }

      // #1874 — keep the derived vec index aligned with the writes below.
      // The extension is loaded only when the virtual table already exists:
      // the CLI never creates the derived table itself, and without sqlite-vec
      // every vec helper is a no-op.
      let vecReady = false;
      try {
        const hasVecTable = !!db.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'vec_memories'",
        ).get();
        if (hasVecTable) {
          initVec(db, provider.dimensions);
          vecReady = true;
        }
      } catch { /* best effort — no index maintenance without sqlite-vec */ }

      if (args.reset) {
        const result = db.prepare("UPDATE extracted_memories SET embedding = NULL WHERE embedding IS NOT NULL").run();
        // #1876 — with an existing vec table, re-run initVec after nulling so
        // a dimension switch rebuilds at the new provider width (no embeddings
        // remain, so the effective width is the requested width) without a
        // daemon restart. Then clear any rows a same-width reset left stale.
        if (vecReady) {
          try { initVec(db, provider.dimensions); } catch { /* best effort */ }
          try { db.exec("DELETE FROM vec_memories"); } catch { /* best effort */ }
        }
        console.log(`Reset: cleared ${result.changes} embeddings. They will be re-computed below.`);
      }

      // #1660: sealed class-3 rows keep embedding NULL for their whole life.
      const rows = db.prepare("SELECT id, user_id, semantic_revision, content_en FROM extracted_memories WHERE embedding IS NULL AND classification < 3").all() as Array<{ id: number; user_id: string; semantic_revision: number; content_en: string }>;
      if (rows.length === 0) { console.log("No memories to embed."); return; }

      console.log(`Embedding ${rows.length} memories via ${provider.name} (${provider.dimensions} dims)...`);
      const vectors = await provider.batchEmbed(rows.map(r => r.content_en));
      const update = db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?");
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i];
        if (vec) {
          const buf = Buffer.from(vec.buffer);
          // #1874 — the vec row follows only a successful guarded source write.
          const result = update.run(buf, rows[i]!.id, rows[i]!.user_id, rows[i]!.semantic_revision);
          if (result.changes === 1) {
            if (vecReady) vecInsert(db, rows[i]!.id, buf);
            count++;
          }
        }
      }
      console.log(`Embedded ${count}/${rows.length} memories`);
      if (count === 0 && rows.length > 0) { process.exitCode = 1; }
    } finally {
      db.close();
    }
  },
});
