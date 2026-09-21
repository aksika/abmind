#!/usr/bin/env python3
"""abmind-maintenance.py — scheduled sleep driver for the Hermes plugin (#1383).

Runs from the Hermes cron job (no_agent script): spawns one
``abmind-client-bridge``, starts a scheduled sleep run, polls status until the
run leaves ``running``, then closes the bridge. Never touches memory hooks,
never writes chat state. Exit 0 only when the run completes; anything else
(including an already-running coordinator) exits nonzero with a short summary.

Stdlib only. Usage:
  abmind-maintenance.py --local ~/.abmind/run/abmind.sock [--level normal] [--timeout 1800]
  abmind-maintenance.py --remote myprofile [--level budget]
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

POLL_INTERVAL_S = 15


class Bridge:
    def __init__(self, argv):
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self.next_id = 0

    def call(self, method, params, timeout=60):
        self.next_id += 1
        req_id = self.next_id
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError(f"{method} timed out")
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("bridge closed stdout")
            try:
                msg = json.loads(line)
            except Exception:
                continue
            if msg.get("id") != req_id:
                continue
            if msg.get("error") is not None:
                raise RuntimeError(str(msg["error"].get("message", msg["error"])))
            return msg.get("result")

    def close(self):
        try:
            self.call("bridge.close", {}, timeout=10)
        except Exception:
            pass
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def resolve_bridge_bin():
    explicit = os.environ.get("ABMIND_BRIDGE_BIN", "").strip()
    if explicit:
        return explicit
    found = shutil.which("abmind-client-bridge")
    if found:
        return found
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--local", default="")
    ap.add_argument("--remote", default="")
    ap.add_argument("--level", default="normal")
    ap.add_argument("--timeout", type=int, default=1800)
    args = ap.parse_args()

    bin_path = resolve_bridge_bin()
    if not bin_path:
        print("abmind-maintenance: no bridge binary (ABMIND_BRIDGE_BIN or PATH)", flush=True)
        return 2
    if args.remote:
        argv = [bin_path, "--remote", args.remote]
    else:
        sock = os.path.expanduser(args.local or "~/.abmind/run/abmind.sock")
        argv = [bin_path, "--local", sock]

    bridge = Bridge(argv)
    try:
        started = bridge.call("abmind.call", {
            "method": "sleep.start",
            "payload": {"mode": "scheduled", "level": args.level, "fresh": False},
        }, timeout=120)
        if not isinstance(started, dict) or started.get("status") not in ("accepted", "already_running"):
            print(f"abmind-maintenance: start refused: {started}", flush=True)
            return 1
        if started.get("status") == "already_running":
            print(f"abmind-maintenance: already running ({started.get('runId', '?')})", flush=True)
            return 1
        deadline = time.time() + max(60, args.timeout)
        while time.time() < deadline:
            time.sleep(POLL_INTERVAL_S)
            st = bridge.call("abmind.call", {"method": "sleep.status", "payload": {}},
                             timeout=120)
            if not isinstance(st, dict):
                print("abmind-maintenance: no status", flush=True)
                return 1
            if st.get("state") != "running":
                last = st.get("last", {}) if isinstance(st.get("last"), dict) else {}
                print(f"abmind-maintenance: state={st.get('state')} "
                      f"status={last.get('status', '?')} "
                      f"steps={last.get('completedSteps', '?')}/{last.get('failedSteps', '?')} failed",
                      flush=True)
                return 0 if last.get("status") == "completed" else 1
        print("abmind-maintenance: timed out waiting for sleep", flush=True)
        return 1
    except (TimeoutError, RuntimeError, OSError) as e:
        print(f"abmind-maintenance: {e}", flush=True)
        return 1
    finally:
        bridge.close()


if __name__ == "__main__":
    sys.exit(main())
