/**
 * cli-flags — tiny typed flag parser for abmind CLI entry points.
 *
 * Intentional non-goals:
 * - No positional args.
 * - No --flag=value form (only --flag value).
 * - No dependency (no yargs/commander/zod).
 * - Unknown flags: warn to stderr, skip. Matches historical hand-rolled parsers.
 *
 * Correctness fix: rejects values starting with "--". Hand-rolled parsers did
 * `args[++i]` unconditionally, so `abmind store --translated --chat-id 1`
 * silently captured "--chat-id" as translated text. New behavior: throw.
 */

export type FlagType = "string" | "number" | "boolean";

export interface FlagSpec {
  /** Canonical flag name, without leading dashes. */
  readonly name: string;
  readonly type: FlagType;
  /** Alternate forms (with or without leading dashes). */
  readonly aliases?: readonly string[];
}

export type FlagValues = Record<string, string | number | boolean | undefined>;

/** Throws with a descriptive message; callers in runners catch + JSON-envelope. */
export class FlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagError";
  }
}

function normalizeKey(raw: string): string {
  return raw.startsWith("--") ? raw.slice(2) : raw.startsWith("-") ? raw.slice(1) : raw;
}

/** Build a lookup of `alias → canonical name` for fast matching. */
function buildAliasMap(specs: readonly FlagSpec[]): Map<string, FlagSpec> {
  const map = new Map<string, FlagSpec>();
  for (const spec of specs) {
    map.set(spec.name, spec);
    for (const alias of spec.aliases ?? []) {
      map.set(normalizeKey(alias), spec);
    }
  }
  return map;
}

/** Parse argv (sliced — no exec path / script path) against the given specs. */
export function parseFlags(argv: readonly string[], specs: readonly FlagSpec[]): FlagValues {
  const aliases = buildAliasMap(specs);
  const out: FlagValues = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token || !token.startsWith("-")) continue; // skip positional / stray
    const key = normalizeKey(token);
    const spec = aliases.get(key);
    if (!spec) {
      process.stderr.write(`warn: unknown flag ${token}\n`);
      continue;
    }
    if (spec.type === "boolean") {
      out[spec.name] = true;
      continue;
    }
    // string / number require a value
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new FlagError(`flag --${spec.name} requires a value`);
    }
    i++;
    if (spec.type === "number") {
      const n = Number(next);
      if (!Number.isFinite(n)) {
        throw new FlagError(`flag --${spec.name} requires a number, got "${next}"`);
      }
      out[spec.name] = n;
    } else {
      out[spec.name] = next;
    }
  }
  return out;
}
