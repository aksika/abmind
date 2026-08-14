/**
 * abmind ingest — Ingest a local file into memory.
 * Agent pre-summarizes, then calls this to store.
 * Usage: abmind ingest --file <path> --chat-id <id> [--topic <t>] [--source internet|private]
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { runCli } from "../src/cli-runner.js";
import type { FlagSpec } from "../src/cli-flags.js";
import { initializeDatabase } from "../src/memory-db.js";
import { abmindHome } from "../src/mem-paths.js";

const INGEST_FLAGS: readonly FlagSpec[] = [
  { name: "file", type: "string" },
  { name: "content", type: "string" },
  { name: "chat-id", type: "string" },
  { name: "identifier", type: "string" },
  { name: "topic", type: "string" },
  { name: "source", type: "string" },
  { name: "source-type", type: "string" },
];

await runCli(import.meta.url, {
  name: "abmind-ingest",
  help: `Usage:
  abmind ingest --file <path> --chat-id <id> [--topic <t>] [--source internet|private]
  abmind ingest --content <text> --chat-id <id> --identifier <name> [--topic <t>] [--source internet|private]

Options:
  --file <path>         Local file to ingest
  --content <text>      Direct text content to ingest
  --chat-id <id>        User ID (required)
  --identifier <name>   Document identifier for dedup (default: filename)
  --topic <t>           Topic tag (default: "ingested")
  --source <s>          Source preset: internet (trust=0,class=0) | private (trust=0,class=2)
  --source-type <t>     Source type: local_file | attachment | email | agent_report (default: local_file)`,
  flags: INGEST_FLAGS,
  handler: async ({ args }) => {
    const { IngestPipeline } = await import("../src/ingest-pipeline.js");

    const filePath = args["file"] as string | undefined;
    const directContent = args["content"] as string | undefined;
    const chatId = args["chat-id"] as string | undefined;
    const topic = args["topic"] as string | undefined;
    const source = args["source"] as string | undefined;
    const sourceType = (args["source-type"] as string) ?? "local_file";
    const identifier = (args["identifier"] as string) ?? (filePath ? basename(filePath) : undefined);

    if (!chatId) { console.error("Error: --chat-id required"); process.exit(1); }
    if (!filePath && !directContent) { console.error("Error: --file or --content required"); process.exit(1); }
    if (!identifier) { console.error("Error: --identifier required when using --content"); process.exit(1); }

    let content: string;
    if (filePath) {
      if (!existsSync(filePath)) { console.error(`Error: file not found: ${filePath}`); process.exit(1); }
      content = readFileSync(filePath, "utf-8");
    } else {
      content = directContent!;
    }

    // Source presets
    let trust = 2;
    let classification = 1;
    if (source === "internet") { trust = 0; classification = 0; }
    else if (source === "private") { trust = 0; classification = 2; }

    const db = initializeDatabase(join(abmindHome(), "memory", "memory.db"));

    const pipeline = new IngestPipeline(db);
    const result = pipeline.ingest(content, {
      userId: chatId,
      sourceType: sourceType as "local_file" | "attachment" | "email" | "agent_report",
      identifier: identifier!,
      trust,
      classification,
      topic,
    });

    if (result.refused) {
      console.error(`Error: ingest refused — ${result.reason}`);
      process.exit(1);
    }
    if (result.ingested) {
      console.log(`✅ Ingested: ${identifier} (${result.memoriesStored} memory stored)`);
    } else {
      console.log(`⏭️ Skipped: ${result.reason}`);
    }
  },
});
