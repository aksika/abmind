#!/usr/bin/env python3
"""Contract test for the deterministic Hermes sleep maintenance runner (#1912).

Drives ``sleep_runner.run_maintenance`` against the scripted stub bridge
(no Hermes checkout, no daemon, no model): the model command is ``cat``,
which echoes the prompt file back as the completion text. Asserts the
runner's exact-settlement contract through the stub's request log:

* one bridge for the whole cycle, lease opened with proposalOnly capability
* one completion settled exactly once (complete with outcome, or fail with
  normalized failure facts) — never both, never twice, never a model tool
* lease closed exactly once; terminal status fetched for the report

Usage: ``python3.12 tests/test_sleep_runner.py`` from the plugin directory.
Stdlib only.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def load_runner():
    spec = importlib.util.spec_from_file_location(
        "abmind_sleep_runner_under_test", str(HERE.parent / "sleep_runner.py"))
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["abmind_sleep_runner_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


failures = []


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def read_log(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def calls_for(log, method):
    return [e for e in log if e.get("method") == method]


def main() -> int:
    mod = load_runner()

    # classify_failure is pure — no subprocess needed.
    check("classify 503 transient",
          mod.classify_failure("503 Service Unavailable").get("failureClass") == "transient")
    check("classify auth permanent",
          mod.classify_failure("401 Unauthorized: bad key").get("failureClass") == "permanent")
    check("classify cancel cancelled",
          mod.classify_failure("sleep cancelled").get("failureClass") == "cancelled")
    check("classify unknown stays unknown",
          mod.classify_failure("boom").get("failureClass") == "unknown")

    tmp = Path(tempfile.mkdtemp(prefix="abmind-runner-"))
    log_path = tmp / "stub.log"
    argv = [sys.executable, str(HERE / "stub_bridge.py")]
    base_env = dict(os.environ)
    base_env["STUB_LOG"] = str(log_path)
    base_env["STUB_NEXT_DEADLINE_MS"] = str(int(time.time() * 1000) + 120_000)
    base_env["STUB_NEXT_TERMINAL"] = "closed"
    os.environ.update({k: v for k, v in base_env.items()
                       if k in ("STUB_LOG", "STUB_NEXT_DEADLINE_MS", "STUB_NEXT_TERMINAL")})

    # Happy path: cat echoes the prompt back as completion text.
    summary = mod.run_maintenance(argv, "cat {PROMPT_FILE}", principal="tester",
                                  mode="scheduled", level="normal",
                                  on_event=lambda _m: None)
    check("happy path serves one completion", summary.get("served") == 1, summary)
    check("happy path completes one completion", summary.get("completed") == 1, summary)
    check("happy path fails none", summary.get("failed") == 0, summary)
    check("happy path terminal completed", summary.get("terminal") == "completed", summary)

    log = read_log(log_path)
    opens = calls_for(log, "sleep.runtime.open")
    check("lease opened once", len(opens) == 1, log)
    check("open declares proposalOnly capability",
          (opens[0].get("payload", {}) or {}).get("capabilities", {}) == {"proposalOnly": True},
          opens)
    completes = calls_for(log, "sleep.runtime.complete")
    check("completion settled exactly once", len(completes) == 1, log)
    if completes:
        payload = completes[0].get("payload", {}) or {}
        check("complete carries the echoed prompt text",
              payload.get("text") == "Summarize the day", payload)
        check("complete carries the text outcome", payload.get("outcome") == "text", payload)
        check("complete targets the scripted completion",
              payload.get("completionId") == "comp-1", payload)
    check("no fail on the happy path", len(calls_for(log, "sleep.runtime.fail")) == 0, log)
    closes = calls_for(log, "sleep.runtime.close")
    check("lease closed exactly once", len(closes) == 1, log)

    # Failure path: the model command exits nonzero — the runner reports it
    # through fail() in host code, never a model tool call.
    log_path.unlink()
    summary = mod.run_maintenance(argv, "sh -c 'exit 3' {PROMPT_FILE}",
                                  principal="tester", on_event=lambda _m: None)
    check("failing model records one failure", summary.get("failed") == 1, summary)
    check("failing model completes none", summary.get("completed") == 0, summary)
    log = read_log(log_path)
    fails = calls_for(log, "sleep.runtime.fail")
    check("failure settled exactly once", len(fails) == 1, log)
    if fails:
        payload = fails[0].get("payload", {}) or {}
        check("fail carries provider_failed", payload.get("code") == "provider_failed", payload)
        failure = payload.get("failure", {}) or {}
        check("fail carries normalized facts",
              failure.get("failureClass") in ("transient", "permanent", "unknown")
              and "detail" in failure, failure)
        check("unknown reach costs a model call (never free)",
              "reachedModel" not in failure, failure)
    check("no complete on the failure path",
          len(calls_for(log, "sleep.runtime.complete")) == 0, log)
    check("lease closed after failure",
          len(calls_for(log, "sleep.runtime.close")) == 1, log)

    # Expired deadline: the runner fails immediately without executing.
    log_path.unlink()
    os.environ["STUB_NEXT_DEADLINE_MS"] = "1"
    summary = mod.run_maintenance(argv, "cat {PROMPT_FILE}",
                                  principal="tester", on_event=lambda _m: None)
    check("expired window records one failure", summary.get("failed") == 1, summary)
    check("expired window executes nothing", summary.get("served") == 0, summary)
    log = read_log(log_path)
    fails = calls_for(log, "sleep.runtime.fail")
    check("expired window fails provider_timeout",
          len(fails) == 1 and (fails[0].get("payload", {}) or {}).get("code") == "provider_timeout",
          log)

    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
