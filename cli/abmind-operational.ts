#!/usr/bin/env node
/**
 * abmind operational — CLI for operational memory (scoped recall, drafts, mutations, history).
 *
 * Subcommands:
 *   draft submit|list
 *   recall
 *   promote|reject|revise|retire
 *   history
 *
 * Use --json for machine-readable output. Without --json, mutations render bounded human text.
 */

import type { FlagSpec } from "../src/cli-flags.js";
import { getMemoryClient, closeClient } from "../src/backend-factory.js";
import { MemoryManager } from "../src/memory-manager.js";

type CmdHandler = (api: import("../src/imemory-system.js").OperationalMemoryApi, args: Record<string, string | number | boolean | undefined>, renderJson: boolean) => Promise<void>;

const HELP = `abmind operational — Manage operational memory (lessons, guidance, ways-of-working)

Subcommands:
  draft submit   Submit a new operational lesson draft
  draft list     List drafts (optionally by status)
  recall         Search active operational memories by scope and/or content
  promote        Promote a draft to active operational memory
  reject         Reject a draft
  revise         Revise an active operational memory
  retire         Retire an active operational memory
  history        Show version history for a memory

Use 'abmind operational <subcommand> --help' for per-command usage.`;

const SUBCOMMAND_FLAGS: Record<string, readonly FlagSpec[]> = {
  "draft submit": [
    { name: "lesson", type: "string" },
    { name: "problem", type: "string" },
    { name: "recommendation", type: "string" },
    { name: "scope-level", type: "string" },
    { name: "scope-json", type: "string" },
    { name: "platform", type: "string" },
    { name: "host", type: "string" },
    { name: "workspace", type: "string" },
    { name: "repository", type: "string" },
    { name: "task-environment", type: "string" },
    { name: "confidence", type: "number" },
    { name: "evidence-json", type: "string" },
    { name: "provenance-json", type: "string" },
    { name: "source-task-id", type: "string" },
    { name: "source-session-id", type: "string" },
    { name: "source-executor", type: "string" },
    { name: "source-host", type: "string" },
    { name: "json", type: "boolean" },
  ],
  "draft list": [
    { name: "status", type: "string" },
    { name: "cursor", type: "string" },
    { name: "limit", type: "number" },
    { name: "json", type: "boolean" },
  ],
  recall: [
    { name: "query", type: "string" },
    { name: "platform", type: "string" },
    { name: "host", type: "string" },
    { name: "workspace", type: "string" },
    { name: "repository", type: "string" },
    { name: "task-environment", type: "string" },
    { name: "limit", type: "number" },
    { name: "cursor", type: "string" },
    { name: "json", type: "boolean" },
  ],
  promote: [
    { name: "draft-id", type: "string" },
    { name: "content", type: "string" },
    { name: "actor-id", type: "string" },
    { name: "reason", type: "string" },
    { name: "json", type: "boolean" },
  ],
  reject: [
    { name: "draft-id", type: "string" },
    { name: "rejected-by", type: "string" },
    { name: "reason", type: "string" },
    { name: "json", type: "boolean" },
  ],
  revise: [
    { name: "memory-id", type: "string" },
    { name: "expected-hash", type: "string" },
    { name: "content", type: "string" },
    { name: "scope-level", type: "string" },
    { name: "scope-json", type: "string" },
    { name: "platform", type: "string" },
    { name: "host", type: "string" },
    { name: "workspace", type: "string" },
    { name: "repository", type: "string" },
    { name: "task-environment", type: "string" },
    { name: "confidence", type: "number" },
    { name: "actor-id", type: "string" },
    { name: "reason", type: "string" },
    { name: "evidence-json", type: "string" },
    { name: "provenance-json", type: "string" },
    { name: "json", type: "boolean" },
  ],
  retire: [
    { name: "memory-id", type: "string" },
    { name: "expected-hash", type: "string" },
    { name: "actor-id", type: "string" },
    { name: "reason", type: "string" },
    { name: "json", type: "boolean" },
  ],
  history: [
    { name: "memory-id", type: "string" },
    { name: "cursor", type: "string" },
    { name: "limit", type: "number" },
    { name: "json", type: "boolean" },
  ],
};

function jsonOk(value: unknown): string {
  return JSON.stringify({ ok: true, value });
}

function jsonErr(code: string, message: string, current?: unknown): string {
  const out: Record<string, unknown> = { ok: false, error: { code, message } };
  if (current) (out.error as Record<string, unknown>).current = current;
  return JSON.stringify(out);
}

class CliValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliValidationError";
  }
}

function rejectUnknownFlags(argv: readonly string[], specs: readonly FlagSpec[]): void {
  const known = new Set(specs.flatMap(spec => [spec.name, ...(spec.aliases ?? [])].map(value => value.replace(/^-+/, ""))));
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("-")) throw new CliValidationError(`Unexpected argument ${token}`);
    const name = token.replace(/^-+/, "");
    if (name === "help" || name === "h") continue;
    if (!known.has(name)) throw new CliValidationError(`Unknown flag ${token}`);
    const spec = specs.find(candidate => candidate.name === name || (candidate.aliases ?? []).some(alias => alias.replace(/^-+/, "") === name));
    if (spec && spec.type !== "boolean") i++;
  }
}

async function main(): Promise<void> {
  const _argv = process.argv.slice(2);

  // Determine subcommand from positional args
  let cmd = "";
  let remainingStart = 0;
  if (_argv[0] === "draft" && (_argv[1] === "submit" || _argv[1] === "list")) {
    cmd = `draft ${_argv[1]}`;
    remainingStart = 2;
  } else if (_argv[0] === "recall" || _argv[0] === "promote" || _argv[0] === "reject" || _argv[0] === "revise" || _argv[0] === "retire" || _argv[0] === "history") {
    cmd = _argv[0];
    remainingStart = 1;
  } else {
    console.log(HELP);
    process.exit(0);
  }

  const flags = SUBCOMMAND_FLAGS[cmd];
  if (!flags) {
    console.error(`Unknown subcommand: ${cmd}`);
    process.exit(1);
  }

  const helpFlags = _argv.slice(remainingStart);
  if (helpFlags.includes("--help") || helpFlags.includes("-h")) {
    const helpTexts: Record<string, string> = {
      "draft submit": `Usage: abmind operational draft submit --lesson <text> --scope-level <level> [options] [--json]

Required:
  --lesson <text>            Lesson content
  --scope-level <level>      global|platform|host|workspace|repository|task_environment
  --scope-json <json>        Scope object (cannot duplicate individual scope flags)
  --confidence <0-100>       Confidence score

Options:
  --problem <text>           Problem description
  --recommendation <text>    Recommendation
  --platform <id>            Platform scope identifier
  --host <id>                Host scope identifier
  --workspace <id>           Workspace scope identifier
  --repository <id>          Repository scope identifier
  --task-environment <id>    Task environment scope identifier
  --evidence-json <json>     Evidence entries JSON
  --provenance-json <json>   Provenance map JSON
  --source-task-id <id>      Source task ID
  --source-session-id <id>   Source session ID
  --source-executor <id>     Source executor
  --source-host <id>         Source host
  --json                     Machine-readable JSON output`,
      "draft list": `Usage: abmind operational draft list [options] [--json]

Options:
  --status <level>           Filter: draft|promoted|rejected
  --cursor <cursor>          Pagination cursor
  --limit <n>                Max results (default 50, max 100)
  --json                     Machine-readable JSON output`,
      recall: `Usage: abmind operational recall [options] [--json]

Options:
  --query <text>             Content substring search
  --platform <id>            Current platform
  --host <id>                Current host
  --workspace <id>           Current workspace
  --repository <id>          Current repository
  --task-environment <id>    Current task environment
  --limit <n>                Max results (default 50, max 100)
  --cursor <cursor>          Pagination cursor
  --json                     Machine-readable JSON output`,
      promote: `Usage: abmind operational promote --draft-id <id> --content <text> --actor-id <id> --reason <text> [--json]

Required:
  --draft-id <id>            Draft to promote
  --content <text>           Curated lesson content
  --actor-id <id>            Promoting actor identity
  --reason <text>            Why promoting

Options:
  --json                     Machine-readable JSON output`,
      reject: `Usage: abmind operational reject --draft-id <id> --rejected-by <id> --reason <text> [--json]

Required:
  --draft-id <id>            Draft to reject
  --rejected-by <id>         Rejecting actor identity
  --reason <text>            Why rejecting

Options:
  --json                     Machine-readable JSON output`,
      revise: `Usage: abmind operational revise --memory-id <id> --expected-hash <hash> --content <text> --scope-level <level> --confidence <0-100> --actor-id <id> --reason <text> [options] [--json]

Required:
  --memory-id <id>           Memory to revise
  --expected-hash <hash>     Current content hash (CAS guard)
  --content <text>           New content
  --scope-level <level>      global|platform|host|workspace|repository|task_environment
  --scope-json <json>        Scope object (cannot duplicate individual scope flags)
  --confidence <0-100>       Confidence score
  --actor-id <id>            Revising actor identity
  --reason <text>            Why revising

Options:
  --platform <id>            Platform scope identifier
  --host <id>                Host scope identifier
  --workspace <id>           Workspace scope identifier
  --repository <id>          Repository scope identifier
  --task-environment <id>    Task environment scope identifier
  --evidence-json <json>     Evidence entries JSON
  --provenance-json <json>   Provenance map JSON
  --json                     Machine-readable JSON output`,
      retire: `Usage: abmind operational retire --memory-id <id> --expected-hash <hash> --actor-id <id> --reason <text> [--json]

Required:
  --memory-id <id>           Memory to retire
  --expected-hash <hash>     Current content hash (CAS guard)
  --actor-id <id>            Retiring actor identity
  --reason <text>            Why retiring

Options:
  --json                     Machine-readable JSON output`,
      history: `Usage: abmind operational history --memory-id <id> [options] [--json]

Options:
  --memory-id <id>           Memory to show history for
  --cursor <cursor>          Pagination cursor
  --limit <n>                Max results (default 50, max 100)
  --json                     Machine-readable JSON output`,
    };
    console.log(helpTexts[cmd] ?? `No help available for: ${cmd}`);
    return;
  }

  // Parse flags from remaining args
  const { parseFlags, FlagError } = await import("../src/cli-flags.js");

  let args: Record<string, string | number | boolean | undefined>;
  try {
    rejectUnknownFlags(helpFlags, flags);
    args = parseFlags(helpFlags, flags) as Record<string, string | number | boolean | undefined>;
  } catch (err) {
    if (err instanceof FlagError || err instanceof CliValidationError) {
      const message = err.message;
      if (helpFlags.includes("--json")) console.log(jsonErr("validation_error", message));
      else console.error(`validation_error: ${message}`);
      process.exit(1);
    }
    throw err;
  }

  const renderJson = args.json === true;

  try {
    validateStructuredArgs(cmd, args);
  } catch (err) {
    if (err instanceof CliValidationError) {
      if (renderJson) console.log(jsonErr("validation_error", err.message));
      else console.error(`validation_error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  // Build MemoryManager and access operational API
  const client = await getMemoryClient(false);
  const mm = client as MemoryManager;

  try {
    await mm.initialize({ skipEmbeddingCheck: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (renderJson) console.log(jsonErr("validation_error", `Failed to initialize memory: ${msg}`));
    else console.error(`Failed to initialize memory: ${msg}`);
    process.exit(1);
  }

  if (!mm.operational) {
    if (renderJson) console.log(jsonErr("not_found", "Operational memory is not available (memory disabled or init failed)"));
    else console.error("Operational memory is not available (memory disabled or init failed)");
    process.exit(1);
  }

  const api = mm.operational;

  try {
    await routeCommand(cmd, api, args, renderJson);
  } catch (err) {
    if (err instanceof CliValidationError) {
      if (renderJson) console.log(jsonErr("validation_error", err.message));
      else console.error(`validation_error: ${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    closeClient(client);
  }
}

async function routeCommand(
  cmd: string,
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  switch (cmd) {
    case "draft submit":
      return handleDraftSubmit(api, args, renderJson);
    case "draft list":
      return handleDraftList(api, args, renderJson);
    case "recall":
      return handleRecall(api, args, renderJson);
    case "promote":
      return handlePromote(api, args, renderJson);
    case "reject":
      return handleReject(api, args, renderJson);
    case "revise":
      return handleRevise(api, args, renderJson);
    case "retire":
      return handleRetire(api, args, renderJson);
    case "history":
      return handleHistory(api, args, renderJson);
    default:
      console.error(`Unknown subcommand: ${cmd}`);
      process.exit(1);
  }
}

async function handleDraftSubmit(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  if (!args.lesson || !args["scope-level"] || args.confidence === undefined) {
    const msg = "Required: --lesson, --scope-level, --confidence";
    if (renderJson) { console.log(jsonErr("validation_error", msg)); process.exit(1); }
    console.error(msg);
    process.exit(1);
  }

  const evidence = args["evidence-json"] ? parseJsonArg(args["evidence-json"] as string, "evidence-json") as import("../src/operational-memory-types.js").EvidenceEntry[] : undefined;
  const provenance = args["provenance-json"] ? parseJsonArg(args["provenance-json"] as string, "provenance-json") as import("../src/operational-memory-types.js").ProvenanceMap : undefined;
  const scope = parseScopeArgs(args);

  const result = await api.submitDraft({
    lesson: args.lesson as string,
    problem: args.problem as string | undefined,
    recommendation: args.recommendation as string | undefined,
    scopeLevel: args["scope-level"] as import("../src/operational-memory-types.js").ScopeLevel,
    ...scope,
    confidence: args.confidence as number,
    evidence,
    provenance,
    sourceTaskId: args["source-task-id"] as string | undefined,
    sourceSessionId: args["source-session-id"] as string | undefined,
    sourceExecutor: args["source-executor"] as string | undefined,
    sourceHost: args["source-host"] as string | undefined,
  });

  renderResult(result, "Draft submitted", renderJson);
}

async function handleDraftList(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  const result = await api.listDrafts({
    status: args.status as import("../src/operational-memory-types.js").DraftStatus | undefined,
    cursor: args.cursor as string | undefined,
    limit: args.limit as number | undefined,
  });

  if (!renderJson && result.ok) {
    for (const d of result.value.items) {
      console.log(`[${d.id.slice(0, 8)}] ${d.status} | ${d.lesson.slice(0, 80)}`);
    }
    if (result.value.nextCursor) console.log(`(next: ${result.value.nextCursor.slice(0, 40)}...)`);
  } else {
    renderResult(result, "", renderJson);
  }
}

async function handleRecall(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  const result = await api.recall({
    query: args.query as string | undefined,
    platform: args.platform as string | undefined,
    host: args.host as string | undefined,
    workspace: args.workspace as string | undefined,
    repository: args.repository as string | undefined,
    taskEnvironment: args["task-environment"] as string | undefined,
    limit: args.limit as number | undefined,
    cursor: args.cursor as string | undefined,
  });

  if (!renderJson && result.ok) {
    for (const h of result.value.items) {
      console.log(`[${h.memoryId.slice(0, 8)}] ${h.matchedScopeLevel} | ${h.lesson.slice(0, 80)}`);
    }
    if (result.value.nextCursor) console.log(`(next: ${result.value.nextCursor.slice(0, 40)}...)`);
  } else {
    renderResult(result, "", renderJson);
  }
}

async function handlePromote(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  if (!args["draft-id"] || !args.content || !args["actor-id"] || !args.reason) {
    const msg = "Required: --draft-id, --content, --actor-id, --reason";
    if (renderJson) { console.log(jsonErr("validation_error", msg)); process.exit(1); }
    console.error(msg);
    process.exit(1);
  }

  const result = await api.promoteDraft({
    draftId: args["draft-id"] as string,
    actorId: args["actor-id"] as string,
    mutationReason: args.reason as string,
    curate: { lesson: args.content as string },
  });

  renderResult(result, "Draft promoted", renderJson);
}

async function handleReject(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  if (!args["draft-id"] || !args["rejected-by"] || !args.reason) {
    const msg = "Required: --draft-id, --rejected-by, --reason";
    if (renderJson) { console.log(jsonErr("validation_error", msg)); process.exit(1); }
    console.error(msg);
    process.exit(1);
  }

  const result = await api.rejectDraft({
    draftId: args["draft-id"] as string,
    rejectedBy: args["rejected-by"] as string,
    rejectionReason: args.reason as string,
  });

  renderResult(result, "Draft rejected", renderJson);
}

async function handleRevise(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  if (!args["memory-id"] || !args["expected-hash"] || !args.content || !args["scope-level"] || args.confidence === undefined || !args["actor-id"] || !args.reason) {
    const msg = "Required: --memory-id, --expected-hash, --content, --scope-level, --confidence, --actor-id, --reason";
    if (renderJson) { console.log(jsonErr("validation_error", msg)); process.exit(1); }
    console.error(msg);
    process.exit(1);
  }

  const evidence = args["evidence-json"] ? parseJsonArg(args["evidence-json"] as string, "evidence-json") as import("../src/operational-memory-types.js").EvidenceEntry[] : undefined;
  const provenance = args["provenance-json"] ? parseJsonArg(args["provenance-json"] as string, "provenance-json") as import("../src/operational-memory-types.js").ProvenanceMap : undefined;

  const result = await api.revise({
    memoryId: args["memory-id"] as string,
    expectedContentHash: args["expected-hash"] as string,
    content: args.content as string,
    scopeLevel: args["scope-level"] as import("../src/operational-memory-types.js").ScopeLevel,
    ...parseScopeArgs(args),
    confidence: args.confidence as number,
    mutationReason: args.reason as string,
    actorId: args["actor-id"] as string,
    evidence,
    provenance,
  });

  renderResult(result, "Memory revised", renderJson);
}

async function handleRetire(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  if (!args["memory-id"] || !args["expected-hash"] || !args["actor-id"] || !args.reason) {
    const msg = "Required: --memory-id, --expected-hash, --actor-id, --reason";
    if (renderJson) { console.log(jsonErr("validation_error", msg)); process.exit(1); }
    console.error(msg);
    process.exit(1);
  }

  const result = await api.retire({
    memoryId: args["memory-id"] as string,
    expectedContentHash: args["expected-hash"] as string,
    mutationReason: args.reason as string,
    actorId: args["actor-id"] as string,
  });

  renderResult(result, "Memory retired", renderJson);
}

async function handleHistory(
  api: import("../src/imemory-system.js").OperationalMemoryApi,
  args: Record<string, string | number | boolean | undefined>,
  renderJson: boolean,
): Promise<void> {
  if (!args["memory-id"]) {
    const msg = "Required: --memory-id";
    if (renderJson) { console.log(jsonErr("validation_error", msg)); process.exit(1); }
    console.error(msg);
    process.exit(1);
  }

  const result = await api.getHistory(args["memory-id"] as string, {
    cursor: args.cursor as string | undefined,
    limit: args.limit as number | undefined,
  });

  if (!renderJson && result.ok) {
    for (const v of result.value.items) {
      console.log(`[${v.id.slice(0, 8)}] ${v.status} | ${v.content.slice(0, 80)}`);
    }
    if (result.value.nextCursor) console.log(`(next: ${result.value.nextCursor.slice(0, 40)}...)`);
  } else {
    renderResult(result, "", renderJson);
  }
}

function renderResult<T>(result: import("../src/operational-memory-types.js").OperationalResult<T>, humanLabel: string, renderJson: boolean): void {
  if (result.ok) {
    if (renderJson) {
      console.log(jsonOk(result.value));
    } else if (humanLabel) {
      console.log(`${humanLabel} — OK`);
    }
  } else {
    if (renderJson) {
      console.log(jsonErr(result.code, result.message, result.current));
    } else {
      console.error(`${result.code}: ${result.message}`);
    }
    process.exit(1);
  }
}

function parseJsonArg(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new CliValidationError(`Invalid JSON for --${label}`);
  }
}

function validateStructuredArgs(cmd: string, args: Record<string, string | number | boolean | undefined>): void {
  if (cmd === "draft submit" || cmd === "revise") {
    parseScopeArgs(args);
    if (args["evidence-json"] !== undefined) parseJsonArg(args["evidence-json"] as string, "evidence-json");
    if (args["provenance-json"] !== undefined) parseJsonArg(args["provenance-json"] as string, "provenance-json");
  }
}

function parseScopeArgs(args: Record<string, string | number | boolean | undefined>): {
  platform?: string;
  host?: string;
  workspace?: string;
  repository?: string;
  taskEnvironment?: string;
} {
  const result: {
    platform?: string;
    host?: string;
    workspace?: string;
    repository?: string;
    taskEnvironment?: string;
  } = {};
  const jsonValue = args["scope-json"];
  if (jsonValue !== undefined) {
    const parsed = parseJsonArg(jsonValue as string, "scope-json");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new CliValidationError("--scope-json must be a JSON object");
    const allowed: Record<string, keyof typeof result> = {
      platform: "platform",
      host: "host",
      workspace: "workspace",
      repository: "repository",
      task_environment: "taskEnvironment",
      taskEnvironment: "taskEnvironment",
    };
    for (const [key, value] of Object.entries(parsed)) {
      const target = allowed[key];
      if (!target || typeof value !== "string") throw new CliValidationError(`Invalid scope-json field: ${key}`);
      if (result[target] !== undefined) throw new CliValidationError(`Duplicate scope-json field: ${key}`);
      result[target] = value;
    }
  }
  const flags: Array<[keyof typeof result, string]> = [
    ["platform", "platform"],
    ["host", "host"],
    ["workspace", "workspace"],
    ["repository", "repository"],
    ["taskEnvironment", "task-environment"],
  ];
  for (const [target, flag] of flags) {
    const value = args[flag];
    if (value === undefined) continue;
    if (result[target] !== undefined) throw new CliValidationError(`Conflicting scope flags: --${flag} and --scope-json`);
    result[target] = value as string;
  }
  return result;
}

await main();
