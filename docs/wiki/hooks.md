# Hooks

abmind integrates with AI coding agents via lifecycle hooks. When the agent reaches a specific point in its workflow, it fires a hook — abmind intercepts it to inject memories, extract knowledge, or log context.

## Supported Events

All 12 Claude Code lifecycle events are covered:

| Event | When it fires | What abmind does |
|-------|--------------|-----------------|
| **PreUserPrompt** | Before user message reaches model | Injects relevant memories (active recall) |
| **PreToolUse** | Before a tool executes | Security gate — blocks unauthorized writes |
| **PostToolUse** | After tool succeeds | Captures tool context to sidecar |
| **PostToolUseFailure** | After tool fails | Stores novel failure patterns as lessons (24h dedup) |
| **PreCompact** | Before context compaction | Extracts memories from transcript before it's lost |
| **PostCompact** | After context compaction | Injects fresh recall to re-ground the agent |
| **PostUserPrompt** | After model responds | Real-time extraction on high-signal exchanges |
| **SubagentStart** | Subagent spawned | Logs delegation as session breadcrumb |
| **SubagentStop** | Subagent finishes | Captures subagent output as memory |
| **Notification** | Agent shows notification | Logs as session breadcrumb |
| **AgentSpawn** | Agent session starts | Wakeup recall — injects identity + recent context |
| **Stop** | Session ends | Final memory flush — stores the last exchange |

## How it works

Each hook is a standalone Node.js script in `cli/abmind-hook-*.ts`. The agent config (`agents/abmind.json`) maps events to commands:

```json
{
  "hooks": {
    "PreUserPrompt": [{"command": "node dist/cli/abmind-hook-preuserprompt.js"}],
    "PreToolUse": [{"command": "node dist/cli/abmind-hook-preToolUse.js", "matcher": "memory_store"}],
    "Stop": [{"command": "node dist/cli/abmind-hook-store.js"}]
  }
}
```

### Input/Output protocol

- **Input:** Hook receives JSON on stdin (event-specific payload)
- **Output:** Hook writes to stdout (injected into agent context)
- **Exit codes:** `0` = success, `2` = skip (don't inject output)

## Key behaviors

### PreUserPrompt (active recall)

Fires on every user message. Extracts English tokens from the prompt, runs a multi-query recall (FTS + vector + entity graph), returns top matches capped at 2000 chars. Secrets (classification=3) are never surfaced.

### PreCompact (memory preservation)

The most critical hook. When the context window fills up and the agent compacts, this hook fires FIRST — extracting memories from the transcript that's about to be discarded. Without it, long conversations lose knowledge.

### PostUserPrompt (real-time extraction)

Uses a heuristic gate — only fires the extraction pipeline when the exchange contains high-signal patterns:
- "remember this", "I prefer", "I decided", "my X is Y"
- Secrets/credentials mentioned
- High emotion score

Cost: ~1 LLM call per 10-20 messages (not every exchange).

### PostToolUseFailure (learning from mistakes)

Stores failure patterns as "lesson" memories. Deduplicates: same tool+error within 24h is stored only once. Prevents noise from flaky networks while capturing genuinely novel failures.

### Security (PreToolUse)

Gates `memory_store` calls — validates classification level, blocks unauthorized writes to high-classification memories. Configurable via `matcher` field.

## Configuration

### Disable all hooks

```bash
export ABMIND_HOOKS_DISABLED=true
```

### Per-hook env vars

| Variable | Default | Description |
|----------|---------|-------------|
| `ABMIND_HOOKS_DISABLED` | false | Kill switch for all hooks |
| `ABMIND_HOOK_RECALL_LIMIT` | 5 | Max memories returned by PreUserPrompt |
| `ABMIND_HOOK_RECALL_MAX_CHARS` | 2000 | Max output chars for recall injection |

## Installation

Hooks ship with abmind. After `abmind install`, copy the agent config to your CLI's agents directory:

```bash
# For Kiro CLI
cp node_modules/abmind/agents/abmind.json ~/.kiro/agents/

# For Claude Code
cp node_modules/abmind/agents/abmind.json ~/.claude/agents/
```

Or reference it in your agent configuration. The hooks resolve paths relative to the abmind package.

## Compatibility

| Agent Host | Supported | Notes |
|-----------|-----------|-------|
| Kiro CLI | ✅ | Full 12-event support |
| Claude Code | ✅ | PostCompact pending official support |
| Gemini CLI | ✅ | Maps to BeforeAgent/AfterAgent |
| Codex | Partial | PreToolUse + PostToolUse only |

## Troubleshooting

**Hook not firing:** Check `agents/abmind.json` is in the correct directory for your CLI. Verify with `cat ~/.kiro/agents/abmind.json | jq '.hooks | keys'`.

**Slow response:** Hooks add latency (DB query per message). If recall takes >500ms, check `~/.abmind/memory/memory.db` size and run `abmind doctor`.

**No memories returned:** The DB may be empty. Send a few messages first, then trigger sleep (`abmind sleep`) to extract memories.
