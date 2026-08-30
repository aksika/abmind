#!/usr/bin/env node
/**
 * Baseline-pinned guard for floating and misused promises in production TypeScript.
 * Existing debt may shrink, but adding a violation requires fixing the promise
 * handling rather than raising the baseline.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const BASELINE_PATH = resolve(SCRIPT_DIR, "check-async-promises.baseline.json");
const SOURCE_GLOBS = ["src/**/*.ts", "cli/**/*.ts"];
const PROMISE_RULES = new Set([
  "@typescript-eslint/no-floating-promises",
  "@typescript-eslint/no-misused-promises",
]);
const WRITE_BASELINE = process.argv.slice(2).includes("--write-baseline");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--write-baseline");

if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}`);
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    if (WRITE_BASELINE) return { files: {} };
    throw new Error(`Baseline is missing: ${relative(REPO_ROOT, BASELINE_PATH)}`);
  }

  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Baseline is unreadable: ${relative(REPO_ROOT, BASELINE_PATH)}`, { cause: error });
  }

  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) {
    throw new Error("Baseline must be a JSON object");
  }
  if (!baseline.files || typeof baseline.files !== "object" || Array.isArray(baseline.files)) {
    throw new Error("Baseline must contain a files object");
  }

  for (const [filePath, count] of Object.entries(baseline.files)) {
    if (!filePath || !Number.isInteger(count) || count < 0) {
      throw new Error(`Baseline entry is invalid: ${filePath}`);
    }
  }

  return baseline;
}

function relativeFilePath(filePath) {
  return relative(REPO_ROOT, filePath).split("\\").join("/");
}

function formatMessage(filePath, message) {
  const rule = message.ruleId ?? "parser";
  return `${relativeFilePath(filePath)}:${message.line}:${message.column}: ${rule}: ${message.message}`;
}

async function lintPromiseRules() {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const results = await eslint.lintFiles(SOURCE_GLOBS);
  const counts = {};
  const violations = [];

  for (const result of results) {
    const filePath = relativeFilePath(result.filePath);
    for (const message of result.messages) {
      if (message.fatal || !PROMISE_RULES.has(message.ruleId)) {
        throw new Error(formatMessage(result.filePath, message));
      }
      counts[filePath] = (counts[filePath] ?? 0) + 1;
      violations.push({ filePath, message });
    }
  }

  return { counts, violations };
}

function writeBaseline(counts) {
  const files = Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
  );
  const baseline = {
    _comment:
      "Existing floating/misused-promise debt, frozen by #1733. May shrink, never grow. A baseline increase is a review red flag.",
    _recorded: new Date().toISOString().slice(0, 10),
    files,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  return Object.values(files).reduce((total, count) => total + count, 0);
}

async function main() {
  const baseline = readBaseline();
  const { counts, violations } = await lintPromiseRules();
  const failures = [];

  for (const violation of violations) {
    const baselineCount = baseline.files[violation.filePath] ?? 0;
    const currentCount = counts[violation.filePath];
    if (currentCount > baselineCount) {
      failures.push(
        `${formatMessage(resolve(REPO_ROOT, violation.filePath), violation.message)} (count ${currentCount} exceeds baseline ${baselineCount}; handle the promise instead of raising the baseline)`,
      );
    }
  }

  if (WRITE_BASELINE) {
    const increasedFiles = Object.entries(counts).filter(
      ([filePath, count]) => count > (baseline.files[filePath] ?? 0),
    );
    if (increasedFiles.length > 0) {
      console.error(
        `WARNING: --write-baseline would increase ${increasedFiles.length} baseline file(s); review and fix the new promise violations before committing the baseline.`,
      );
    }
    const total = writeBaseline(counts);
    console.log(`check-async-promises: baseline written (${total} violation(s)).`);
    return;
  }

  for (const [filePath, baselineCount] of Object.entries(baseline.files)) {
    const currentCount = counts[filePath] ?? 0;
    if (currentCount < baselineCount) {
      console.log(
        `NOTICE: ${filePath} is below its baseline (${currentCount}/${baselineCount}); run node scripts/check-async-promises.mjs --write-baseline to ratchet it down.`,
      );
    }
  }

  if (failures.length > 0) {
    console.error("check-async-promises: FAILED — new promise violations found:");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  console.log(`check-async-promises: OK — baseline pinned at ${total} violation(s).`);
}

main().catch((error) => {
  console.error(`check-async-promises: FAILED — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
