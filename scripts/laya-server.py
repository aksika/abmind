#!/usr/bin/env python3
"""Laya System One sidecar for abmind (#1812).

Runs the self-hosted Laya decision model behind the local HTTP contract that
abmind's LayaHttpProvider speaks. The operator starts this; abmind never
spawns it. Localhost only.

Setup (versions are not pinned; Laya is early-stage):
    python3 -m venv ~/.laya-venv
    ~/.laya-venv/bin/pip install laya
    # The first start downloads the current checkpoint (a few GB) into the HF
    # cache (~/.cache/huggingface); later starts reuse it, no network needed.
    # The model stays in memory while the sidecar runs: on Apple Silicon with
    # MPS a warm four-question battery measured ~0.2 s; CPU-only hosts are
    # slower. Record the exact laya version and checkpoint revision used for
    # an evaluation in that run's artifact, not here.

Run:
    ~/.laya-venv/bin/python scripts/laya-server.py
    # options: --host 127.0.0.1 --port 8765 --model convaiinnovations/laya

Contract (version 1):
    GET  /health  -> {"status": "ready"|"warming", "model": ...,
                      "layaVersion": ..., "device": ..., "contractVersion": 1}
                    503 while warming.
    POST /predict {"state": {...}, "questions": {...}}
                 -> {"model": ..., "answers": ..., "usage": ...,
                     "contractVersion": 1}
                 400 on malformed body, 413 on oversize body, 500 on
                 inference failure. One inference runs at a time; a second
                 concurrent caller waits its turn (FIFO) and gets
                 503 {"error": "busy: ..."} only when waiting would outlast its
                 stated budget (or the work would). Callers send their
                 per-call timeout in X-Laya-Budget-Ms (milliseconds, used
                 as-is; 1500 when absent or non-numeric).

Privacy: request bodies are never logged. Stdout carries only startup,
readiness and per-request timing/question counts.
"""

import argparse
import json
import math
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONTRACT_VERSION = 1
MAX_BODY_BYTES = 256 * 1024
DEFAULT_MODEL = "convaiinnovations/laya"

# Bounded FIFO wait for the single inference slot (#1857). ThreadingHTTPServer
# gives each request its own thread; waiters block on _slot["cond"] and are
# served in ticket order.
BUDGET_HEADER = "X-Laya-Budget-Ms"
DEFAULT_BUDGET_MS = 1500.0  # today's SYSTEM1_TIMEOUT_MS default
WAIT_SAFETY_MARGIN_MS = 150.0  # served replies must land before clients abort
WAIT_HARD_CAP_MS = 10_000.0  # upper bound on any thread hold, whatever claimed
ESTIMATE_ALPHA = 0.5  # weight of the newest completed inference sample
BUSY_ERROR = "busy: one predict at a time"  # byte-identical: pinned by judgment-provider.test.ts

_slot = {
    "cond": threading.Condition(),
    "busy": False,        # inference slot held
    "next_ticket": 0,     # monotonic FIFO tickets
    "waiting": set(),     # outstanding tickets (holders discard theirs)
    "estimate_ms": None,  # rolling completed-inference duration
}

_state = {
    "status": "warming",  # warming -> ready
    "model": None,
    "laya_version": None,
    "device": None,
    "agent": None,
}


def _send(handler, code, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _health_payload():
    return {
        "status": _state["status"],
        "model": _state["model"],
        "layaVersion": _state["laya_version"],
        "device": _state["device"],
        "contractVersion": CONTRACT_VERSION,
    }


def _caller_budget_ms(handler):
    """Effective per-call timeout from the additive budget header.

    Absent/non-numeric falls back to today's default; a numeric value is used
    as-is, so a caller with a near-zero remaining budget sheds immediately
    instead of queuing on a stale default for a client that is already gone.
    """
    try:
        budget = float(handler.headers.get(BUDGET_HEADER))
    except (TypeError, ValueError):
        return DEFAULT_BUDGET_MS
    return budget if math.isfinite(budget) else DEFAULT_BUDGET_MS


def _acquire_slot(budget_ms, arrival):
    """Take a ticket and acquire the inference slot in FIFO order.

    Immediate when the slot is free and no earlier ticket is outstanding (the
    budget is ignored there — today's behaviour). Otherwise waits until our
    ticket is the lowest outstanding one on a free slot, or our deadline
    (arrival + min(budget - margin, hard cap)) passes.

    Returns (acquired, waited, wait_ms, queued); queued counts the other
    outstanding tickets observed. The ticket is always retired before return
    and the next waiter woken on the shed path — a kept ticket would pin the
    queue head and starve later waiters. The slot is held by us iff acquired.
    """
    cond = _slot["cond"]
    with cond:
        ticket = _slot["next_ticket"]
        _slot["next_ticket"] += 1
        _slot["waiting"].add(ticket)
        if not _slot["busy"] and ticket == min(_slot["waiting"]):
            _slot["waiting"].discard(ticket)
            _slot["busy"] = True
            return True, False, 0.0, len(_slot["waiting"])
        deadline = arrival + min(budget_ms - WAIT_SAFETY_MARGIN_MS,
                                 WAIT_HARD_CAP_MS) / 1000.0
        waited = False
        while True:
            if not _slot["busy"] and ticket == min(_slot["waiting"]):
                _slot["waiting"].discard(ticket)
                _slot["busy"] = True
                return True, waited, (time.monotonic() - arrival) * 1000.0, \
                    len(_slot["waiting"])
            now = time.monotonic()
            if now >= deadline:
                _slot["waiting"].discard(ticket)
                queued = len(_slot["waiting"])
                cond.notify_all()
                return False, waited, (now - arrival) * 1000.0, queued
            waited = True
            cond.wait(timeout=deadline - now)


def _release_slot():
    with _slot["cond"]:
        _slot["busy"] = False
        _slot["cond"].notify_all()


def _record_sample(ms):
    with _slot["cond"]:
        prev = _slot["estimate_ms"]
        _slot["estimate_ms"] = ms if prev is None \
            else (1.0 - ESTIMATE_ALPHA) * prev + ESTIMATE_ALPHA * ms


def _shed(handler, qcount, wait_ms, queued, cause):
    # Log first: the waiter may already be gone, so the 503 send is best-effort.
    # Cause distinguishes the shedding point for the #1811 budget question.
    # Neither this line nor the disconnect line may use the `predict q=`
    # prefix that scripts/system1-e2e.sh greps for served judgments.
    sys.stdout.write("busy q=%d wait=%.0f queued=%d cause=%s\n"
                     % (qcount, wait_ms, queued, cause))
    sys.stdout.flush()
    try:
        _send(handler, 503, {"error": BUSY_ERROR})
    except OSError:
        pass  # waiter already gone; its ticket was retired by the caller


class Handler(BaseHTTPRequestHandler):
    server_version = "laya-sidecar/1"

    def log_message(self, fmt, *args):  # access log to stdout, never bodies
        sys.stdout.write("%s %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def do_GET(self):
        if self.path != "/health":
            _send(self, 404, {"error": "unknown path"})
            return
        payload = _health_payload()
        _send(self, 200 if payload["status"] == "ready" else 503, payload)

    def do_POST(self):
        if self.path != "/predict":
            _send(self, 404, {"error": "unknown path"})
            return
        if _state["status"] != "ready":
            _send(self, 503, {"error": "model warming"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            _send(self, 413, {"error": "body must be 1..%d bytes" % MAX_BODY_BYTES})
            return
        try:
            raw = self.rfile.read(length)
        except (OSError, ValueError):
            _send(self, 400, {"error": "unreadable body"})
            return
        try:
            body = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            _send(self, 400, {"error": "malformed JSON body"})
            return
        if not isinstance(body, dict) or not isinstance(body.get("state"), dict) \
                or not isinstance(body.get("questions"), dict):
            _send(self, 400, {"error": "body needs {state: {...}, questions: {...}}"})
            return
        if not body["questions"]:
            _send(self, 400, {"error": "questions must not be empty"})
            return
        arrival = time.monotonic()
        budget_ms = _caller_budget_ms(self)
        acquired, waited, wait_ms, queued = _acquire_slot(budget_ms, arrival)
        if not acquired:
            _shed(self, len(body["questions"]), wait_ms, queued, "deadline")
            return
        if waited:
            with _slot["cond"]:
                estimate_ms = _slot["estimate_ms"]
                queued = len(_slot["waiting"])
            # Shed work nobody will read instead of saturating the slot with
            # doomed inferences; immediate acquirers always run (AC4).
            if estimate_ms is not None and budget_ms - wait_ms < estimate_ms:
                _release_slot()
                _shed(self, len(body["questions"]), wait_ms, queued, "estimate")
                return
        try:
            t0 = time.time()
            result = _state["agent"].predict(body["state"], body["questions"])
            ms = (time.time() - t0) * 1000.0
            _record_sample(ms)
            sys.stdout.write("predict q=%d ms=%.0f wait=%.0f queued=%d\n"
                             % (len(body["questions"]), ms, wait_ms, queued))
            sys.stdout.flush()
            try:
                _send(self, 200, {
                    "model": result.get("model"),
                    "answers": result.get("answers"),
                    "usage": result.get("usage"),
                    "contractVersion": CONTRACT_VERSION,
                })
            except OSError:
                # Client disconnected after inference ran: the work is done and
                # the slot releases below; note the drop, not a served judgment.
                sys.stdout.write("dropped q=%d ms=%.0f wait=%.0f queued=%d\n"
                                 % (len(body["questions"]), ms, wait_ms, queued))
                sys.stdout.flush()
        except Exception as err:  # local operator process; keep message short
            try:
                _send(self, 500, {"error": "inference failed: %s" % str(err)[:200]})
            except OSError:
                pass  # client already gone; the slot releases below
        finally:
            _release_slot()


def main():
    ap = argparse.ArgumentParser(description="Laya System One sidecar for abmind")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--device", default=None)
    args = ap.parse_args()

    import laya  # imported after argparse so --help needs no dependencies

    _state["model"] = args.model
    _state["laya_version"] = getattr(laya, "__version__", "unknown")
    sys.stdout.write("loading %s (laya %s)...\n" % (args.model, _state["laya_version"]))
    sys.stdout.flush()
    t0 = time.time()
    agent = laya.load(args.model, device=args.device)
    _state["agent"] = agent
    _state["device"] = str(agent.device)
    _state["status"] = "ready"
    sys.stdout.write("ready in %.1fs on %s; serving %s:%d\n"
                     % (time.time() - t0, _state["device"], args.host, args.port))
    sys.stdout.flush()
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
