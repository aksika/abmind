"""Deterministic abmind sleep maintenance runner for Hermes (``hermes abmind sleep``).

Owns one persistent bridge, lease polling, isolated native model
execution, and exact complete/fail/close settlement in host code — no
model tool call is ever needed to report a model failure (#1912).

Scheduling stays operator-owned (cron): this command runs one cycle and
exits. It registers no job or interval.

Execution model: the CLI supplies a completion source for each prompt.
By default it is the installed Hermes agent API (``call_llm``), so
completions use the host's active native provider configuration; an
operator may override it with a model command (``ABMIND_LLM_CMD`` with a
``{PROMPT_FILE}`` placeholder, or ``--model-cmd``), which runs one
isolated process per completion. Either way the completion is a plain
chat with no tools and no memory hooks: proposal-only enforcement holds
by construction, and ordinary memory/background review stays disabled
for maintenance execution.

Stdlib only. Importable without a Hermes checkout (the CLI imports it by
path), so contract tests can drive it against the stub bridge.
"""

from __future__ import annotations

import json
import os
import select
import shlex
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

HEADROOM_S = 30
NEXT_WAIT_MS = 25_000
SETTLE_TIMEOUT = 15
TEXT_CAP = 200_000


class RunnerError(RuntimeError):
    pass


def classify_failure(message: str) -> Dict[str, Any]:
    """Host-side failure classification mirroring the supervision classes.

    An arbitrary provider error is never proof of a justified blocker —
    unknown stays retryable downstream; permanent/auth stops carry their
    actual reason.
    """
    msg = (message or "").lower()

    def has(*needles: str) -> bool:
        return any(n in msg for n in needles)

    if has("cancelled", "abort", "keyboardinterrupt", "cancelled before"):
        return {"failureClass": "cancelled", "effects": "unknown"}
    if has("401", "unauthorized", "unauthenticated", "forbidden", "403",
           "credit", "billing", "quota", "insufficient", "payment",
           "policy_rejected", "capability_mismatch", "permission denied"):
        return {"failureClass": "permanent", "effects": "reconcilable",
                "reasonCode": "auth-policy"}
    if has("429", "rate limit", "503", "502", "504", "overload",
           "temporarily", "try again", "timeout", "timed out", "deadline",
           "econn", "refused", "reset", "network", "socket hang up"):
        return {"failureClass": "transient", "effects": "reconcilable"}
    return {"failureClass": "unknown", "effects": "unknown"}


class Bridge:
    """One persistent bridge subprocess speaking NDJSON-RPC over stdio."""

    def __init__(self, argv: List[str]) -> None:
        try:
            self.proc = subprocess.Popen(
                argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL, text=True, bufsize=1)
        except OSError as e:
            raise RunnerError(f"cannot spawn bridge ({e})")
        self._next_id = 0
        self.closed = False

    def call(self, method: str, params: Dict[str, Any], timeout: float = 15) -> Any:
        self._next_id += 1
        rid = self._next_id
        assert self.proc.stdin is not None and self.proc.stdout is not None
        try:
            self.proc.stdin.write(json.dumps(
                {"jsonrpc": "2.0", "id": rid, "method": method,
                 "params": params}) + "\n")
            self.proc.stdin.flush()
        except (OSError, ValueError) as e:
            raise RunnerError(f"bridge write failed ({e})")
        deadline = time.time() + timeout
        out = ""
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise RunnerError(f"bridge call {method} timed out")
            ready, _, _ = select.select([self.proc.stdout], [], [], remaining)
            if not ready:
                raise RunnerError(f"bridge call {method} timed out")
            chunk = self.proc.stdout.readline()
            if chunk == "":
                raise RunnerError(f"bridge closed during {method}")
            out += chunk
            try:
                response = json.loads(out)
            except json.JSONDecodeError:
                continue
            if not isinstance(response, dict) or response.get("id") != rid:
                out = ""
                continue
            if "error" in response and response["error"] is not None:
                raise RunnerError(f"bridge error on {method}: {response['error']}")
            return response.get("result")

    def abmind(self, method: str, payload: Dict[str, Any], timeout: float = 15) -> Any:
        return self.call("abmind.call",
                         {"method": method, "payload": payload}, timeout)

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            try:
                self.call("bridge.close", {}, timeout=5)
            except RunnerError:
                pass
            assert self.proc.stdin is not None
            try:
                self.proc.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        except OSError:
            pass


@dataclass
class RunnerStats:
    served: int = 0
    completed: int = 0
    failed: int = 0
    failures: List[str] = field(default_factory=list)


def run_model_command(model_cmd: str, prompt: str, timeout_s: float) -> str:
    """Execute one completion in an isolated process. Returns stdout text
    (possibly empty). Raises RunnerError with a classified message on
    failure — the caller reports it through fail(), never a model tool."""
    if "{PROMPT_FILE}" not in model_cmd:
        raise RunnerError("model command must contain a {PROMPT_FILE} placeholder")
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False,
                                      encoding="utf-8") as f:
        f.write(prompt)
        prompt_path = f.name
    try:
        argv = shlex.split(model_cmd.replace("{PROMPT_FILE}", prompt_path))
        try:
            proc = subprocess.run(argv, stdout=subprocess.PIPE,
                                  stderr=subprocess.PIPE, text=True,
                                  timeout=max(1.0, timeout_s))
        except subprocess.TimeoutExpired as e:
            raise RunnerError(f"model command timed out after {timeout_s:.0f}s "
                              f"(deadline reached while awaiting the model)")
        except OSError as e:
            raise RunnerError(f"model command failed to start ({e})")
        if proc.returncode != 0:
            err = (proc.stderr or "").strip()[:240]
            raise RunnerError(f"model command exited {proc.returncode}"
                              + (f": {err}" if err else ""))
        return (proc.stdout or "")[:TEXT_CAP]
    finally:
        try:
            os.unlink(prompt_path)
        except OSError:
            pass


def _report_completion_failure(bridge: Bridge, lease: str,
                               completion_id: str, step_id: str,
                               message: str, stats: RunnerStats) -> None:
    """Settle one failed completion through the broker in host code.

    Normalized facts travel with the fail so abmind supervision decides
    recovery: a completion source that never started is known not to have
    reached the model; anything else stays unknown and is charged
    conservatively — never free retries.
    """
    facts = classify_failure(message)
    code = "provider_timeout" if "timed out" in message.lower() else "provider_failed"
    if "failed to start" in message or "agent api unavailable" in message.lower():
        facts["reachedModel"] = False
    try:
        bridge.abmind("sleep.runtime.fail", {
            "leaseId": lease, "completionId": completion_id,
            "code": code,
            "failure": {"cause": code, "detail": message[:240], **facts},
        }, timeout=SETTLE_TIMEOUT)
    except RunnerError:
        pass  # broker will deadline the completion; the loop keeps serving
    stats.failed += 1
    stats.failures.append(f"{step_id}: {message[:120]}")


def run_maintenance(argv: List[str], model_cmd: str = "", principal: str = "",
                    mode: str = "scheduled", level: str = "normal",
                    resume: bool = False,
                    on_event: Optional[Callable[[str], None]] = None,
                    complete: Optional[Callable[[str, float], str]] = None) -> Dict[str, Any]:
    """Run one maintenance cycle through a fresh bridge. Returns a summary
    dict; raises RunnerError when the run cannot start or settle.

    ``complete(prompt, timeout_s) -> text`` is the completion source. The
    CLI passes the installed Hermes agent API (active provider
    configuration) when no operator command is configured; a plain
    completion has no tools or memory hooks, so proposal-only turns cannot
    execute anything. ``model_cmd`` remains an explicit operator override
    and the deterministic test seam."""
    emit = on_event or (lambda _m: None)
    if complete is None and not model_cmd:
        raise RunnerError("no completion source (agent completer or model command)")
    bridge = Bridge(argv)
    stats = RunnerStats()
    lease: Optional[str] = None
    try:
        caps = bridge.call("bridge.negotiate", {}, timeout=SETTLE_TIMEOUT)
        methods = (caps or {}).get("methods", []) if isinstance(caps, dict) else []
        for need in ("sleep.runtime.open", "sleep.runtime.next",
                      "sleep.runtime.complete", "sleep.runtime.fail",
                      "sleep.runtime.close"):
            if need not in methods:
                raise RunnerError(f"bridge lacks {need} — cannot serve sleep")
        if resume:
            started = bridge.abmind("sleep.resume", {}, timeout=SETTLE_TIMEOUT)
        else:
            started = bridge.abmind("sleep.start", {"mode": mode, "level": level},
                                    timeout=SETTLE_TIMEOUT)
        if not isinstance(started, dict) or started.get("status") != "accepted":
            raise RunnerError(f"sleep not accepted: {started}")
        run_id = str(started.get("runId", ""))
        emit(f"sleep run {run_id} ({mode}/{level})")
        # Proposal-only capability: this runner serves every turn through a
        # tool-less model command, so state-changing tools are withheld on
        # proposal-only turns by construction.
        opened = bridge.abmind("sleep.runtime.open", {
            "providerInstanceId": f"hermes-maintenance-{principal or 'default'}",
            "capabilities": {"proposalOnly": True},
        }, timeout=SETTLE_TIMEOUT)
        if not isinstance(opened, dict) or opened.get("status") != "ok" \
                or not opened.get("leaseId"):
            raise RunnerError(f"runtime open failed: {opened}")
        lease = str(opened["leaseId"])

        while True:
            nxt = bridge.abmind("sleep.runtime.next",
                                {"leaseId": lease, "waitMs": NEXT_WAIT_MS},
                                timeout=(NEXT_WAIT_MS / 1000) + 30)
            if not isinstance(nxt, dict):
                raise RunnerError(f"bad next response: {nxt}")
            status = nxt.get("status")
            if status in ("closed", "lease_expired"):
                break
            if status in ("no_request",) or nxt.get("heartbeat"):
                continue
            req = nxt.get("completionRequest") or {}
            if not isinstance(req, dict) or not req.get("completionId"):
                continue
            completion_id = str(req["completionId"])
            step_id = str(req.get("stepId", ""))
            prompt = str(req.get("prompt", "") or "")
            try:
                deadline_ms = int(req.get("deadline", 0) or 0)
            except (ValueError, TypeError):
                deadline_ms = 0
            # An already-expired provider deadline fails immediately —
            # never start an execution that cannot settle in time.
            # (Broker and runner clocks agree on the local lane; the 30s
            # headroom absorbs typical remote-lane skew. The broker remains
            # authoritative — a late settle is rejected there regardless.)
            budget_s = (deadline_ms / 1000) - time.time() - HEADROOM_S
            if budget_s <= 0:
                bridge.abmind("sleep.runtime.fail", {
                    "leaseId": lease, "completionId": completion_id,
                    "code": "provider_timeout",
                    "failure": {"cause": "provider_timeout",
                                "detail": "provider window already exhausted",
                                "failureClass": "transient",
                                "reachedModel": False,
                                "effects": "absent",
                                "reasonCode": "timeout"},
                }, timeout=SETTLE_TIMEOUT)
                stats.failed += 1
                stats.failures.append(f"{step_id}: expired window")
                continue
            try:
                text = complete(prompt, budget_s) if complete is not None \
                    else run_model_command(model_cmd, prompt, budget_s)
            except RunnerError as e:
                _report_completion_failure(bridge, lease, completion_id, step_id, str(e), stats)
                continue
            except Exception as e:  # agent API faults are completion failures too
                _report_completion_failure(bridge, lease, completion_id, step_id, str(e), stats)
                continue
            outcome = "text" if text.strip() else "empty"
            bridge.abmind("sleep.runtime.complete", {
                "leaseId": lease, "completionId": completion_id,
                "text": text, "outcome": outcome,
            }, timeout=SETTLE_TIMEOUT)
            stats.served += 1
            stats.completed += 1
            emit(f"served {step_id} ({len(text)} chars)")
    finally:
        if lease is not None:
            try:
                bridge.abmind("sleep.runtime.close", {"leaseId": lease},
                              timeout=SETTLE_TIMEOUT)
            except RunnerError:
                pass
        bridge.close()
    try:
        status_bridge = Bridge(argv)
        try:
            st = status_bridge.abmind("sleep.status", {}, timeout=SETTLE_TIMEOUT)
        finally:
            status_bridge.close()
        report = (st or {}).get("last", {}) if isinstance(st, dict) else {}
        terminal = str(report.get("status", "unknown"))
    except RunnerError:
        terminal, report = "unknown", {}
    # run_id is always bound here: any start/lease failure raises through
    # the finally above instead of reaching this return.
    return {"runId": run_id,
            "served": stats.served, "completed": stats.completed,
            "failed": stats.failed, "failures": stats.failures,
            "terminal": terminal,
            "report": str(report.get("report", "")) if isinstance(report, dict) else ""}
