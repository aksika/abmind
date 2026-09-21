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
                 400 on malformed body, 413 on oversize body, 503 when a
                 predict is already running (one inference at a time), 500 on
                 inference failure.

Privacy: request bodies are never logged. Stdout carries only startup,
readiness and per-request timing/question counts.
"""

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CONTRACT_VERSION = 1
MAX_BODY_BYTES = 256 * 1024
DEFAULT_MODEL = "convaiinnovations/laya"

_state = {
    "status": "warming",  # warming -> ready
    "model": None,
    "laya_version": None,
    "device": None,
    "agent": None,
    "lock": threading.Lock(),
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
        if not _state["lock"].acquire(blocking=False):
            _send(self, 503, {"error": "busy: one predict at a time"})
            return
        try:
            t0 = time.time()
            result = _state["agent"].predict(body["state"], body["questions"])
            ms = (time.time() - t0) * 1000.0
            sys.stdout.write("predict q=%d ms=%.0f\n" % (len(body["questions"]), ms))
            sys.stdout.flush()
            _send(self, 200, {
                "model": result.get("model"),
                "answers": result.get("answers"),
                "usage": result.get("usage"),
                "contractVersion": CONTRACT_VERSION,
            })
        except Exception as err:  # local operator process; keep message short
            _send(self, 500, {"error": "inference failed: %s" % str(err)[:200]})
        finally:
            _state["lock"].release()


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
