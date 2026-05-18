# Contributing to abmind

Thanks for your interest in contributing!

## Getting started

```bash
git clone https://github.com/aksika/abmind.git
cd abmind
npm install
npm run build
npm test
```

Requires Node 22+.

## Development workflow

1. Fork the repo
2. Create a branch from `dev` (`git checkout -b feat/my-feature dev`)
3. Make your changes
4. Run `npm test` — all tests must pass
5. Run `npx tsc --noEmit` — no type errors
6. Commit with a descriptive message
7. Push and open a PR against `dev`

## Code style

- TypeScript strict mode
- Named exports (no default exports)
- `camelCase` for variables/functions, `PascalCase` for types/classes, `UPPER_SNAKE` for constants
- No `any` — use `unknown` and narrow
- Keep functions focused and small

## Testing

```bash
npm test              # full suite
npm test -- --silent  # quiet output
npx vitest run src/recall-engine.test.ts  # single file
```

Write tests for new features. Update tests when changing behavior.

## Commit messages

Format: `type(scope): description`

Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

Examples:
- `feat(#404): emotion boost in recall engine`
- `fix: sleep audit regex for 4-digit time`
- `refactor(#432): shrink public API exports`

## Architecture

- `src/` — library source (TypeScript)
- `cli/` — CLI entry points
- `prompts/sleep/` — sleep cycle step prompts
- `templates/core/` — default core files seeded on install
- `docs/` — documentation

## Questions?

Open an issue or join the Discord (link in README).
