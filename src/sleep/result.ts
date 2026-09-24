/**
 * result.ts — sleep result projection (#1838 Part 1).
 *
 * Verbatim move from src/sleep/orchestrator.ts (toSummary @ 1289-1298 and
 * result cluster @ 1562-1675 @ 927deb7). No logic touched. All three
 * projectors plus toSummary are exported so the orchestrator keeps calling
 * them without duplication.
 */

import type { SleepModelFailureReason } from "./llm-budget.js";
import { failedEssentials } from "./catchup.js";
import { sleepStepConfig } from "./sleep-manifest.js";
import { toBoundedFailure, actionForCause, detailForCause } from "./failure-report.js";
import type { StepResult } from "./state.js";
import type { SleepState } from "./state.js";
import type {
  SleepRunResult,
  SleepStepSummary,
  SleepTerminalStatus,
  SleepFailure,
} from "./contracts.js";

export function toSummary(id: string, status: SleepStepSummary["status"], essential: boolean, s: StepResult | undefined): SleepStepSummary {
  return {
    id,
    status,
    essential,
    attempts: s?.attempts ?? 1,
    durationMs: s?.duration != null ? Math.round(s.duration * 1000) : undefined,
    ...(s?.failure ? { failure: s.failure } : {}),
  };
}

export function projectResult(
  runId: string,
  status: SleepTerminalStatus,
  startedAt: number,
  finishedAt: number,
  state: SleepState,
  watermarkAdvanced: boolean,
  resumable: boolean,
  terminalFailure?: { stepId: string; reason: SleepModelFailureReason; failure: SleepFailure } | null,
  reviewLine?: string | null,
  // #1807: GC compatibility diagnostic, attached once per run even when GC
  // model dispatch was ineligible. Location + outcome + operator action only.
  gcNotice?: string | null,
): SleepRunResult {
  const steps: SleepStepSummary[] = Object.entries(state.steps).map(([id, s]) =>
    toSummary(id, s.status === "ok" ? "completed" : s.status === "timeout" ? "timeout" : s.status === "skipped" ? "skipped" : "failed", s.essential ?? (sleepStepConfig(id)?.essential ?? false), s));
  const essentialFailures = failedEssentials(state);
  const okCount = steps.filter(s => s.status === "completed").length;
  const failCount = steps.filter(s => s.status === "failed" || s.status === "timeout").length;
  const skipCount = steps.filter(s => s.status === "skipped").length;

  // #1752: produce exact stage/cause/action report for failed/partial cycles
  const failedEntries: Array<{ id: string; failure: SleepFailure }> = [];
  if (terminalFailure) {
    failedEntries.push({ id: terminalFailure.stepId, failure: terminalFailure.failure });
    // Include any other failed steps besides the terminal one, in terminal order
    for (const [id, s] of Object.entries(state.steps)) {
      if (id === terminalFailure.stepId) continue;
      if (s.status === "failed" || s.status === "timeout") {
        const f = s.failure ?? toBoundedFailure("unknown");
        failedEntries.push({ id, failure: f });
      }
    }
  } else {
    for (const [id, s] of Object.entries(state.steps)) {
      if (s.status === "failed" || s.status === "timeout") {
        const f = s.failure ?? toBoundedFailure("unknown");
        failedEntries.push({ id, failure: f });
      }
    }
  }

  let report: string;
  const gcLine = gcNotice ? `\nGC notice: ${gcNotice}` : "";
  if ((status === "failed" || status === "partial" || failCount > 0) && failedEntries.length > 0) {
    const primary = failedEntries[0]!;
    const causeDetail = primary.failure.detail ? `${primary.failure.cause} — ${primary.failure.detail}` : `${primary.failure.cause} — ${detailForCause(primary.failure.cause)}`;
    const action = actionForCause(primary.failure.cause);
    const resumeLine = resumable ? "\nResume: /sleep resume" : "";
    let additional = "";
    if (failedEntries.length > 1) {
      const extra = failedEntries.slice(1).map(e => `Additional stage: ${e.id} / Cause: ${e.failure.cause}${e.failure.detail ? ` — ${e.failure.detail.slice(0, 80)}` : ""}`).join("\n");
      additional = `\n${extra}`;
    }
    const review = reviewLine ? `\n${reviewLine}` : "";
    report = `Sleep failed\nStage: ${primary.id}\nCause: ${causeDetail}\nAction: ${action}${resumeLine}${additional}${review}${gcLine}`;
  } else if (terminalFailure) {
    // Fallback for terminal failure without failed entries (should not happen)
    const cause = terminalFailure.failure.cause;
    const detail = terminalFailure.failure.detail ? `${cause} — ${terminalFailure.failure.detail}` : `${cause} — ${detailForCause(cause)}`;
    const action = actionForCause(cause);
    const resumeLine = resumable ? "\nResume: /sleep resume" : "";
    report = `Sleep failed\nStage: ${terminalFailure.stepId}\nCause: ${detail}\nAction: ${action}${resumeLine}${reviewLine ? `\n${reviewLine}` : ""}${gcLine}`;
  } else {
    report = `Sleep ${status} — ${okCount} completed, ${failCount} failed, ${skipCount} skipped (of ${steps.length}).`
      + (essentialFailures.length > 0 ? ` Essential failures: ${essentialFailures.join(", ")}.` : "")
      + (reviewLine ? ` ${reviewLine}` : "")
      + (gcNotice ? ` GC notice: ${gcNotice}` : "");
  }
  // Cap report at 4000 chars
  if (report.length > 4000) report = report.slice(0, 4000);
  return {
    runId,
    status,
    startedAt,
    finishedAt,
    llmCalls: state.llmCalls ?? 0,
    steps,
    essentialFailures,
    resumable,
    watermarkAdvanced,
    report,
  };
}

export function alreadyRunningResult(startedAt: number, finishedAt: number): SleepRunResult {
  return {
    runId: "",
    status: "already_running",
    startedAt,
    finishedAt,
    llmCalls: 0,
    steps: [],
    essentialFailures: [],
    resumable: false,
    watermarkAdvanced: false,
    report: "Sleep cycle already running — no-op.",
  };
}

export function noWorkResult(runId: string, startedAt: number, finishedAt: number): SleepRunResult {
  return {
    runId,
    status: "no_work",
    startedAt,
    finishedAt,
    llmCalls: 0,
    steps: [],
    essentialFailures: [],
    resumable: false,
    watermarkAdvanced: false,
    report: "No messages since last sleep — nothing to process.",
  };
}
