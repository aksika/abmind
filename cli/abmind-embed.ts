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
import { loadEmbedConfig } from "../src/ollama-embed.js";
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
    try {
      try { db.exec("ALTER TABLE extracted_memories ADD COLUMN embedding BLOB"); } catch { /* already exists */ }

      if (args.reset) {
        const result = db.prepare("UPDATE extracted_memories SET embedding = NULL WHERE embedding IS NOT NULL").run();
        // Also drop the vec_memories table contents if present, so it gets rebuilt fresh on next init
        try { db.exec("DELETE FROM vec_memories"); } catch { /* vec extension not loaded — ok */ }
        console.log(`Reset: cleared ${result.changes} embeddings. They will be re-computed below.`);
      }

      const provider = createEmbeddingProvider();
      const rows = db.prepare("SELECT id, user_id, semantic_revision, content_en FROM extracted_memories WHERE embedding IS NULL").all() as Array<{ id: number; user_id: string; semantic_revision: number; content_en: string }>;
      if (rows.length === 0) { console.log("No memories to embed."); return; }

      console.log(`Embedding ${rows.length} memories via ${provider.name} (${provider.dimensions} dims)...`);
      const vectors = await provider.batchEmbed(rows.map(r => r.content_en));
      const update = db.prepare("UPDATE extracted_memories SET embedding = ? WHERE id = ? AND user_id = ? AND semantic_revision = ?");
      let count = 0;
      for (let i = 0; i < rows.length; i++) {
        const vec = vectors[i];
        if (vec) {
          const result = update.run(Buffer.from(vec.buffer), rows[i]!.id, rows[i]!.user_id, rows[i]!.semantic_revision);
          if (result.changes === 1) count++;
        }
      }
      console.log(`Embedded ${count}/${rows.length} memories`);
      if (count === 0 && rows.length > 0) { process.exitCode = 1; }
    } finally {
      db.close();
    }
  },
});
