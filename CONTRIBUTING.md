# Contributing to abmind

Thanks for your interest in contributing! abmind is the memory engine behind abtars — persistent recall, extraction, and maintenance for AI agents.

## Quick Start

```bash
git clone https://github.com/aksika/abmind.git
cd abmind
npm install
npm run build
npx vitest run
```

## Development Workflow

1. Fork the repo
2. Create a branch from `dev` (not `main`)
3. Make your changes
4. Run checks: `npx tsc --noEmit && npx vitest run`
5. Commit with conventional commits: `fix(recall): ...`, `feat(sleep): ...`
6. Open a PR to `dev`

## Branch Model

- `main` — stable releases only. Don't target PRs here.
- `dev` — active development. All PRs go here.

## Code Style

- TypeScript strict mode
- No `any` — use `unknown` and narrow
- Named exports over default exports
- No secrets, API keys, or hardcoded paths
- Tests for new features and bug fixes

## What Goes Where

| Change | Repo |
|--------|------|
| Memory recall, storage, extraction | **abmind** (this repo) |
| Sleep/Dreamy prompts and orchestration | **abmind** |
| Platform adapters (Telegram, Discord) | abtars |
| Skills, tools, bridge runtime | abtars |
| CLI commands (`abmind recall`, `abmind store`) | **abmind** |

## Issue First

For anything beyond a small bug fix, open an issue first to discuss the approach. This saves everyone time.

## Tests

```bash
npx vitest run                    # all tests
npx vitest run src/recall          # specific file/pattern
npx vitest run --reporter=verbose  # detailed output
```

Tests use vitest. Mock external dependencies (ollama, filesystem). Don't require a running ollama instance for CI.

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
fix(recall): handle empty query gracefully
feat(sleep): add contradiction detection parser
docs: update integration guide FAQ
test(memory): add cosine dedup edge cases
```

Scopes: `recall`, `memory`, `sleep`, `cli`, `openclaw`, `hooks`, `mcp`, `docs`, `test`
