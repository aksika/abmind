/**
 * public-artifacts.ts — enumerate abmind's human-readable output files for
 * OpenClaw's MemoryPluginCapability.publicArtifacts.listArtifacts.
 *
 * abmind writes prose files under $ABMIND_HOME/memory/:
 *   daily/*.md          — nightly daily summaries
 *   consolidation/*.md  — weekly / quarterly consolidations
 *   sleep/*.md          — sleep audit logs
 *
 * OpenClaw's UI / CLI can surface these to users as "memory artifacts"
 * alongside any native ones it knows about.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getRuntime } from "../runtime-store.js";
import type { AbmindPluginRuntime } from "./types.js";

interface ArtifactEntry {
  path: string;
  relPath: string;
  category: "daily" | "consolidation" | "sleep";
  sizeBytes: number;
  modifiedMs: number;
}

function listMarkdownFiles(root: string, category: ArtifactEntry["category"]): ArtifactEntry[] {
  const dir = join(root, category);
  try {
    const entries = readdirSync(dir).filter((e) => e.endsWith(".md"));
    return entries.map((name) => {
      const full = join(dir, name);
      const stat = statSync(full);
      return {
        path: full,
        relPath: `${category}/${name}`,
        category,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
      };
    });
  } catch {
    // Directory missing / unreadable — return empty, not an error. Fresh
    // installs won't have any artifacts yet.
    return [];
  }
}

/**
 * List all abmind public artifacts (daily + consolidation + sleep markdown
 * files). Returned as a flat array; caller can group or filter.
 *
 * OpenClaw's MemoryPluginPublicArtifact shape is `any` at our boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildListArtifacts(pluginId: string): (cfg?: any) => Promise<any[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async function listArtifacts(_cfg?: any): Promise<any[]> {
    const runtime = getRuntime<AbmindPluginRuntime>(pluginId);
    const root = runtime.memoryConfig.memoryDir;
    const all: ArtifactEntry[] = [
      ...listMarkdownFiles(root, "daily"),
      ...listMarkdownFiles(root, "consolidation"),
      ...listMarkdownFiles(root, "sleep"),
    ];
    all.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return all;
  };
}
