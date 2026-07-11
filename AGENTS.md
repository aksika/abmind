# AGENTS.md — abmind

## What this is

SQLite-backed persistent memory system for AI agents. TypeScript (strict, ESM). Not a library you call into — it's a full memory engine with CLI, MCP server, hooks, and sleep maintenance.

## Commands

```bash
npm run build          # tsc → dist/
npm run typecheck      # tsc --noEmit (must pass before tests)
npm test               # vitest run --dir src
npx vitest run src/recall-engine  # run single test file
npx vitest run --reporter=verbose  # detailed output
```

CI order: `typecheck` → `test`. Always run typecheck first — tests won't catch type errors in non-test files.

## Branch model

- `dev` — active development. All PRs go here.
- `main` — stable releases only. Never target PRs here.

## Code style

- TypeScript strict, `"type": "module"` (ESM). No `any` — use `unknown` and narrow.
- Named exports over default exports.
- `tsconfig.json` compiles `src/**/*.ts` and `cli/**/*.ts` to `dist/`.
- No secrets, API keys, or hardcoded paths.

## Structure

- `src/` — core library (recall, sleep, memory management, crypto, ingestion)
- `cli/` — CLI subcommands (`abmind.ts` is entry, one file per subcommand)
- `templates/` — shipped prompt files and memory templates (included in npm package)
- `agents/` — agent instruction files for external hosts
- `claude-code-extension/`, `gemini-extension/`, `codex-extension/` — host-specific integrations
- `hermes-plugin/` — Hermes Agent plugin (Python YAML)
- `openclaw.plugin.json` — OpenClaw plugin manifest

## Testing

Tests live next to source as `*.test.ts` in `src/`. Integration tests use `.integration.test.ts` suffix. Tests mock external deps (ollama, filesystem) — do NOT require a running ollama instance.

`vitest.config.ts` sets `testTimeout: 10_000`. Some integration tests (sleep, lifecycle) may be slower.

## Native deps

`better-sqlite3` and `sqlite-vec` are NOT bundled. Install via `abmind deps install` (targets `~/.local/lib/node_modules/`, shared with abtars). Both products resolve from this shared location at runtime.

## Key entry points

- `src/index.ts` — public API (source of truth per SUPPORTED-SURFACE.md)
- `cli/abmind.ts` — CLI entry point
- `src/mcp-server.ts` — MCP server
- `src/sleep-pipeline.ts` — sleep orchestration
- `src/recall-engine.ts` — 4-layer recall
- `src/memory-manager.ts` — main facade

## Conventional commits

Scope and commit: `fix(recall): ...`, `feat(sleep): ...`, `docs: ...`, `test(memory): ...`
Scopes: `recall`, `memory`, `sleep`, `cli`, `openclaw`, `hooks`, `mcp`, `docs`, `test`

## Smoke test

`scripts/smoke-publish.sh` — packs, installs to scratch dir, verifies exports and CLI. Run before publishing: `bash scripts/smoke-publish.sh`

## Project Governance

This repo is governed by **abproject** (`../abproject/` — private repo `github.com/aksika/abproject`).

- **Ways of working** (planning tiers, approval gates, branching, deployment, commit discipline): `abproject/steering/`
- **Backlog**: `abproject/backlog.db` — SQLite, source of truth for all tickets
- **Specs**: `abproject/specs/NNN/` (Tier 3) and `abproject/docs/plans/NNN-slug.md` (legacy)

Read `abproject/steering/000-start-here.md` first when onboarding.
