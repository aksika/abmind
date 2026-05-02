/**
 * wake-up-renderer.ts — Compression Level 2 rendering for wake-up context.
 * Entity header + topic grouping + elide defaults.
 * Operates on stored ABM-L, produces ultra-compact output.
 */

export type CompressionLevel = "signal" | "full" | "compact" | "ultra";

/** Pick compression level based on token budget. */
export function pickLevel(budgetTokens: number): CompressionLevel {
  if (budgetTokens > 5000) return "full";
  if (budgetTokens > 500) return "compact";
  if (budgetTokens > 100) return "ultra";
  return "signal";
}

interface MemoryEntry {
  content_compressed: string;
  topic: string;
  emotion_arc?: string | null;
}

/** Build entity header from recurring @references. */
function buildEntityHeader(entries: ReadonlyArray<MemoryEntry>): { header: string; replace: Map<string, string> } {
  const counts = new Map<string, number>();
  for (const e of entries) {
    const refs = e.content_compressed.match(/@[\w-]+/g) ?? [];
    for (const ref of refs) {
      counts.set(ref, (counts.get(ref) ?? 0) + 1);
    }
  }

  // Only alias entities that appear 3+ times
  const replace = new Map<string, string>();
  const aliases: string[] = [];
  for (const [ref, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    if (count < 3) break;
    const name = ref.slice(1); // remove @
    const code = name.slice(0, 2).toUpperCase();
    replace.set(ref, code);
    aliases.push(`${code}=${name}`);
  }

  return {
    header: aliases.length > 0 ? `@: ${aliases.join(", ")}` : "",
    replace,
  };
}

/** Extract prefix fields from ABM-L string. */
function parsePrefix(abml: string): { flags: string; topic: string; emotion: string; confidence: string; date: string; body: string } {
  const m = abml.match(/^\[([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^\]]*)\]\s*(.*)/s);
  if (!m) return { flags: "", topic: "", emotion: "", confidence: "", date: "", body: abml };
  return { flags: m[1]!, topic: m[2]!, emotion: m[3]!, confidence: m[4]!, date: m[5]!, body: m[6]! };
}

/** Render entries at "compact" level: topic grouping, elide defaults, entity codes. */
function renderCompact(entries: ReadonlyArray<MemoryEntry>, entityReplace: Map<string, string>): string {
  const byTopic = new Map<string, { arc: string; lines: string[] }>();

  for (const e of entries) {
    const parsed = parsePrefix(e.content_compressed);
    if (!byTopic.has(e.topic)) byTopic.set(e.topic, { arc: e.emotion_arc ?? "", lines: [] });

    // Elide: date (unless <7d), confidence (unless != 3), neutral emotion
    let prefix = `[${parsed.flags}`;
    if (parsed.emotion && parsed.emotion !== "—") prefix += `|${parsed.emotion}`;
    if (parsed.confidence && parsed.confidence !== "3") prefix += `|${parsed.confidence}`;
    prefix += "]";

    // Apply entity short codes
    let body = parsed.body;
    for (const [ref, code] of entityReplace) {
      body = body.replace(new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), code);
    }

    byTopic.get(e.topic)!.lines.push(`${prefix} ${body}`);
  }

  const parts: string[] = [];
  for (const [topic, { arc, lines }] of byTopic) {
    parts.push(`## ${topic}${arc ? " " + arc : ""}`);
    for (const line of lines) parts.push(line);
  }
  return parts.join("\n");
}

/** Render entries at "full" level: no compression tricks, just the stored ABM-L. */
function renderFull(entries: ReadonlyArray<MemoryEntry>): string {
  return entries.map(e => e.content_compressed).join("\n");
}

/**
 * Render core memories for wake-up context at the given compression level.
 */
export function renderWakeUp(entries: ReadonlyArray<MemoryEntry>, level: CompressionLevel): string {
  if (entries.length === 0) return "";

  if (level === "signal") return renderSignal(entries);
  if (level === "full") return `[CORE MEMORY — ${entries.length} entries]\n${renderFull(entries)}`;

  // compact and ultra both use topic grouping + entity header
  const { header, replace } = buildEntityHeader(entries);
  const body = renderCompact(entries, replace);
  const headerLine = header ? header + "\n" : "";
  return `[CORE MEMORY — ${entries.length} entries]\n${headerLine}${body}`;
}

/** Render L0 signal level: structured tag cloud. ~50 tokens for entire memory. */
function renderSignal(entries: ReadonlyArray<MemoryEntry>): string {
  const topics = new Map<string, { types: Map<string, number>; entities: Set<string> }>();

  for (const e of entries) {
    if (!topics.has(e.topic)) topics.set(e.topic, { types: new Map(), entities: new Set() });
    const t = topics.get(e.topic)!;
    const parsed = parsePrefix(e.content_compressed);
    const flag = parsed.flags.charAt(0) || "F";
    t.types.set(flag, (t.types.get(flag) ?? 0) + 1);
    const refs = e.content_compressed.match(/@[\w-]+/g) ?? [];
    for (const ref of refs) t.entities.add(ref);
  }

  const lines: string[] = [`[MEMORY MAP — ${entries.length} entries]`];
  for (const [topic, { types, entities }] of [...topics.entries()].sort((a, b) => b[1].types.size - a[1].types.size)) {
    const count = [...types.values()].reduce((a, b) => a + b, 0);
    const entityStr = [...entities].slice(0, 4).join(" ");
    const typeStr = [...types.entries()].map(([f, c]) => `${f}:${c}`).join(" ");
    lines.push(`${topic}(${count}): ${entityStr} — ${typeStr}`);
  }
  return lines.join("\n");
}

/**
 * Compress a daily summary to ABM-L bullet points.
 * Input: raw markdown daily. Output: compact ABM-L lines.
 */
export function compressDailySummary(markdown: string, date: string): string {
  const lines = markdown.split("\n").filter(l => l.trim() && !l.startsWith("#"));
  const bullets: string[] = [];

  for (const line of lines) {
    const trimmed = line.replace(/^[-*]\s*/, "").trim();
    if (trimmed.length < 10) continue;
    // Abbreviate
    const compressed = trimmed
      .replace(/\bTelegram\b/g, "TG")
      .replace(/\bDiscord\b/g, "DC")
      .replace(/\bauthentication\b/gi, "auth")
      .replace(/\bconfiguration\b/gi, "config")
      .replace(/\b(the|a|an|was|were|been|being|also|very|really|just|quite|basically|essentially)\b/gi, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (compressed.length > 5) bullets.push(compressed);
  }

  if (bullets.length === 0) return "";
  // Cap at ~10 most important lines
  return `## ${date}\n${bullets.slice(0, 10).map(b => `- ${b}`).join("\n")}`;
}

/**
 * Generate compressed SOUL for ultra-small context windows (<32K).
 * Extracts only rules and facts from full SOUL.md.
 */
export function compressSoul(fullSoul: string): string {
  const lines = fullSoul.split("\n");
  const sections: string[] = [];
  let currentSection = "";
  let collecting = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentSection = line.replace("## ", "").trim().toLowerCase();
      collecting = true;
      sections.push(`## ${currentSection}`);
      continue;
    }
    if (!collecting) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Keep only lines that are rules (start with - or contain "must", "never", "always", "don't")
    if (trimmed.startsWith("-") || /\b(must|never|always|don't|do not|MUST)\b/.test(trimmed)) {
      // Compress the line
      const compressed = trimmed
        .replace(/\b(the|a|an|is|are|was|were|been|being|also|very|really|just|quite)\b/gi, "")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (compressed.length > 5) sections.push(compressed);
    }
  }

  return sections.join("\n");
}
