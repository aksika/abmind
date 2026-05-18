# abmind — Hermes-Agent Memory Plugin

Persistent cross-session memory for [Hermes-Agent](https://github.com/NousResearch/hermes-agent) via [abmind](https://github.com/aksika/abmind).

## What you get

- **Automatic recall** — relevant memories injected before every turn (no tool call needed)
- **Automatic recording** — every conversation turn stored automatically
- **Pre-compress capture** — saves context before Hermes discards it during compaction
- **Memory tools** — `abmind_recall` + `abmind_store` for explicit agent use
- **Sleep cycles** — nightly maintenance (extract facts, consolidate, detect contradictions)
- **Encrypted secrets** — class 3 memories encrypted at rest

## Install

```bash
# 1. Install abmind (if not already)
npm install -g abmind
abmind install

# 2. Copy plugin to Hermes
mkdir -p ~/.hermes/plugins/abmind
cp hermes-plugin/__init__.py hermes-plugin/plugin.yaml ~/.hermes/plugins/abmind/

# 3. Configure Hermes
# Add to ~/.hermes/config.yaml:
#   memory:
#     provider: abmind

# 4. Verify
hermes memory status    # should show "abmind" as active provider
```

## Known limitations

- Hermes does not validate `requires_bins` in plugin.yaml. If `abmind` is not on PATH, the plugin loads but all CLI calls fail silently at runtime. Ensure `which abmind` works before starting the gateway.

## Sleep (memory maintenance)

**If using `hermes gateway`** (daemon mode): sleep cron is auto-registered on first run (03:00 daily).

**If using CLI only**: add to your system cron:
```bash
crontab -e
# Add: 0 3 * * * abmind sleep --level normal
```

## Requirements

- `abmind` installed and on `$PATH`
- Node.js 22+ (for abmind)
- Optional: ollama with `nomic-embed-text` (for semantic search)

## How it works

| Event | What happens |
|-------|-------------|
| Session start | Wake-up context injected (recent facts, profile) |
| Before each turn | Relevant memories recalled and injected |
| After each turn | Turn recorded in background |
| Context compression | Messages captured before discard |
| Session end | Budget sleep triggered if >24h since last |
| Nightly (cron) | Full sleep cycle — extract, consolidate, age |
