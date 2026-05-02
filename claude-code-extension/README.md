# abmind Claude Code extension

> ⚠️ **ALPHA — unverified end-to-end.** Structure, hooks, and MCP wiring are validated, but we have not yet confirmed that Claude Code injects hook stdout into the model's context as expected (blocked on API key access). Config will work; model behavior may need tuning. See "Alpha caveats" at the bottom. Ticket: #365.

Configuration-only integration of abmind's persistent memory with Anthropic's Claude Code CLI (`@anthropic-ai/claude-code`). Same deliverable shape as the gemini-cli extension (#363): lifecycle hooks + MCP server + ground-truth context file.

See `abproject/docs/plans/365-claude-code-extension.md` for the design rationale.

## What this does

Three lifecycle hooks wire abmind into every Claude Code session:

| Event | Command | Purpose |
|---|---|---|
| `SessionStart` | `abmind hook-wakeup` | Inject wake-up brief on session open |
| `UserPromptSubmit` | `abmind hook-recall` | Recall + inject `[abmind memory context]` before every turn |
| `Stop` | `abmind hook-store` | Record user prompt + model response after each turn |

Plus the `abmind` MCP server is registered, exposing `memory_recall`, `memory_store`, `memory_edit`, `memory_status`, `memory_wakeup` as tools the model can call mid-turn.

Plus `CLAUDE.md` teaches Claude that injected memory blocks are ground truth (prevents confabulation).

## Prerequisites

- `abmind` installed and on `$PATH` (see abmind's top-level `README.md` / `docs/install.md`)
- Node.js (Claude Code requires 18+)

## Install

```bash
# 1. Install Claude Code globally
npm install -g @anthropic-ai/claude-code

# 2. Verify the binary works
claude --version    # should print e.g. "2.1.126 (Claude Code)"

# 3. Create ~/.claude/ if it doesn't exist (first-run would do this too)
mkdir -p ~/.claude

# 4. Install CLAUDE.md (pick one)
#    Option A: symlink for live updates from this repo
ln -sf "$(pwd)/CLAUDE.md" ~/.claude/CLAUDE.md
#    Option B: copy
# cp CLAUDE.md ~/.claude/CLAUDE.md

# 5. Install settings.json (hooks only — MCP server is added separately)
#
#    ⚠️  WARNING: plain `cp` overwrites any existing ~/.claude/settings.json.
#    Check first:
if [ -s ~/.claude/settings.json ]; then
    echo "existing settings — MERGE, don't overwrite:"
    jq -s '.[0] * .[1]' ~/.claude/settings.json settings.json > /tmp/merged.json \
        && mv /tmp/merged.json ~/.claude/settings.json \
        && echo "merged"
else
    cp settings.json ~/.claude/settings.json && echo "installed"
fi

# 6. Register the abmind MCP server (stored in ~/.claude.json, separate from settings.json)
claude mcp add abmind abmind mcp

# 7. Verify
claude mcp list                                  # should show "abmind: ... ✓ Connected"
cat ~/.claude/settings.json | jq .hooks          # should show 3 event entries
```

The above example uses `$(pwd)` assuming you're inside `abmind/claude-code-extension/`. Adjust paths if you're elsewhere.

## First-time test

```bash
# Requires ANTHROPIC_API_KEY set in env (or OAuth via `claude login`)
claude -p "ki Morgenson a viccbol?"
```

Expected behavior if everything's wired:
1. `SessionStart` hook fires → wake-up brief injected
2. `UserPromptSubmit` hook fires → `[abmind memory context]` with the Morgenson joke memory at the top
3. Claude answers from the injected memory (not from training data — no "Viggo Mortensen" confabulation)
4. `Stop` hook fires → turn recorded to abmind

If the joke memory doesn't land, run `abmind hook-doctor` to diagnose.

## Kill-switches

```bash
# Disable all abmind hooks for one run (exits 0 immediately, no DB touched)
ABMIND_HOOKS_DISABLED=true claude -p "..."

# Skip hooks + auto-memory + CLAUDE.md entirely (Claude Code's bare mode)
claude --bare -p "..."

# Remove the MCP server
claude mcp remove abmind
```

## Environment variables

All `ABMIND_HOOK*` env vars from the Kiro Pattern B / gemini-cli integrations apply unchanged — the hook commands are identical binaries.

| Variable | Default | Effect |
|---|---|---|
| `ABMIND_HOOKS_DISABLED` | `false` | All hooks exit 0, no memory touched |
| `ABMIND_HOOK_RECALL_LIMIT` | `5` | Max results from recall hook |
| `ABMIND_HOOK_RECALL_MAX_CHARS` | `2000` | Cap on injected recall text |
| `ABMIND_HOOK_WAKEUP_MAX_CHARS` | `5000` | Cap on wake-up injection |

## Known limitations

- **No recording on Ctrl+C / crash.** `Stop` only fires on normal turn completion. Inherited gap from abmind's hook model (see #344).
- **Stdout log leak workaround.** The `grep -vE '^\[(env|memory-db|memory-manager|ollama-)'` filter in `settings.json` strips abmind's boot-log lines that currently leak onto stdout. Will be removed once #364 lands.

## See also

- `abmind/gemini-extension/` — same pattern for gemini-cli
- `abmind/docs/integration-guide.md` — Kiro + OpenClaw + Gemini + Claude Code
- `abproject/docs/plans/365-claude-code-extension.md` — design rationale

## Alpha caveats

1. **End-to-end model test not yet run.** Hooks fire, MCP connects, stdout pipeline produces the right memory — but whether Claude Code actually places that into the model's attention window in a way the model respects is not yet confirmed. Will be validated as soon as an Anthropic API key is available.
2. **Stdout log leak workaround still in place** (ticket #364). If abmind's boot-log prefixes change, the `grep -vE` filter could let noise through. Monitor `abmind hook-doctor` for anything unexpected.
3. **No install script yet** (ticket #368). The README's manual steps are defensive but not atomic. If a step fails mid-way, state could be inconsistent — run uninstall manually.
4. **`Stop` hook does not fire on Ctrl+C / crash.** Cancelled turns are never recorded. Inherited limitation from all abmind hook integrations (#344).
