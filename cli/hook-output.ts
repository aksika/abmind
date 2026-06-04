/**
 * hook-output.ts — Format hook output for different host CLIs (#522).
 *
 * --format codex  → {"systemMessage": "..."}
 * --format gemini → {"hookSpecificOutput": {"additionalContext": "..."}}
 * (default)       → raw text (Claude Code)
 */

export type HookFormat = "raw" | "codex" | "gemini";

export function resolveHookFormat(): HookFormat {
  const idx = process.argv.indexOf("--format");
  if (idx === -1 || !process.argv[idx + 1]) return "raw";
  const val = process.argv[idx + 1]!.toLowerCase();
  if (val === "codex") return "codex";
  if (val === "gemini") return "gemini";
  return "raw";
}

export function writeHookOutput(text: string, format: HookFormat): void {
  if (!text.trim()) return;
  switch (format) {
    case "codex":
      process.stdout.write(JSON.stringify({ systemMessage: text }));
      break;
    case "gemini":
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: text } }));
      break;
    default:
      process.stdout.write(text);
  }
}
