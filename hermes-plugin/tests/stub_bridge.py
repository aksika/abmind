#!/usr/bin/env python3
"""Stub abmind-client-bridge for contract tests: NDJSON JSON-RPC over stdio.

Responds to bridge.negotiate / abmind.call / bridge.close with scripted
results and appends every abmind.call to a request log file (env STUB_LOG).
Ignores its own argv. Stdlib only.
"""

from __future__ import annotations

import json
import os
import sys

METHODS = [
    "private.lifecycleStartSession",
    "private.lifecyclePrepareTurn",
    "private.lifecycleCompleteTurn",
    "private.lifecycleRecall",
    "private.lifecycleStore",
    "private.lifecycleCheckpoint",
    "private.attribution",
    "private.lifecycleObserve",
    "operational.recall",
    "operational.submitDraft",
    "sleep.start",
    "sleep.status",
    "sleep.cancel",
    "sleep.resume",
    "sleep.runtime.open",
    "sleep.runtime.next",
    "sleep.runtime.complete",
    "sleep.runtime.fail",
    "sleep.runtime.close",
]

_next_polls = 0

LOG = os.environ.get("STUB_LOG", "")


def log_call(method, payload, key):
    if not LOG:
        return
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"method": method, "payload": payload,
                            "idempotencyKey": key}) + "\n")


def handle_abmind(method, payload):
    if method == "private.lifecycleStartSession":
        return {"ok": True, "context": "wake hello", "diagnostics": []}
    if method in ("private.lifecyclePrepareTurn", "private.lifecycleRecall"):
        return {"context": "[abmind memory context]\n- test memory\n",
                "hits": [{"content": "test memory", "date": "today",
                          "score": 0.9, "id": 3, "revision": 1}],
                "diagnostics": []}
    if method == "private.lifecycleCompleteTurn":
        return {"status": "recorded", "messageIds": [1, 2]}
    if method == "private.lifecycleStore":
        return {"stored": True, "memoriesCount": 1, "memoryId": 9, "semanticRevision": 1}
    if method == "private.lifecycleCheckpoint":
        return {"status": "checkpointed", "messageIds": [5], "rejected": 0}
    if method == "private.attribution":
        return None
    if method == "private.lifecycleObserve":
        return {"eventId": (payload or {}).get("eventId", ""),
                "consumer": "unsupported" if (payload or {}).get("kind") == "delegation-outcome" else "diagnostic-only",
                "status": "received", "reason": "stub receipt"}
    if method == "operational.recall":
        return {"ok": True, "hits": []}
    if method == "operational.submitDraft":
        return {"ok": True}
    if method == "sleep.start":
        return {"status": "accepted", "runId": "run-1"}
    if method == "sleep.status":
        return {"state": "terminal",
                "last": {"status": "completed", "completedSteps": 1, "failedSteps": 0}}
    if method == "sleep.cancel":
        return {"status": "cancelling"}
    if method == "sleep.resume":
        return {"status": "accepted", "runId": "run-1"}
    if method == "sleep.runtime.open":
        return {"status": "ok", "leaseId": "lease-1", "expiresAt": 0}
    if method == "sleep.runtime.next":
        global _next_polls
        _next_polls += 1
        if _next_polls == 1:
            return {"status": "ok", "completionRequest": {
                "completionId": "comp-1", "runId": "run-1", "stepId": "step-1",
                "prompt": "Summarize the day", "deadline": 0}}
        return {"status": "no_request"}
    if method == "sleep.runtime.complete":
        return {"status": "ok"}
    if method == "sleep.runtime.fail":
        return {"status": "ok"}
    if method == "sleep.runtime.close":
        return {"status": "ok"}
    return {"error": f"stub: unsupported {method}"}


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        method = req.get("method")
        params = req.get("params", {}) or {}
        req_id = req.get("id")
        try:
            if method == "bridge.negotiate":
                result = {"version": 1, "methods": METHODS,
                          "domains": ["private"], "features": {}}
            elif method == "bridge.close":
                result = {"status": "closed"}
            elif method == "abmind.call":
                inner = params.get("method", "")
                payload = params.get("payload", {})
                log_call(inner, payload, params.get("idempotencyKey"))
                result = handle_abmind(inner, payload)
            else:
                result = None
            if isinstance(result, dict) and "error" in result and len(result) == 1:
                sys.stdout.write(json.dumps(
                    {"jsonrpc": "2.0", "id": req_id,
                     "error": {"code": -32000, "message": result["error"]}}) + "\n")
            else:
                sys.stdout.write(json.dumps(
                    {"jsonrpc": "2.0", "id": req_id, "result": result}) + "\n")
            sys.stdout.flush()
        except BrokenPipeError:
            break


if __name__ == "__main__":
    main()
