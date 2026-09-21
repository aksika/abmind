"""``hermes abmind`` subcommands: bridge/daemon reachability without a gateway.

Loaded by path (never import the provider module here). Commands:
  hermes abmind status   resolve the bridge, negotiate, report methods/domains
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys


def _resolve_argv():
    try:
        from hermes_cli.config import load_config_readonly
        block = load_config_readonly().get("memory", {}).get("abmind", {})
    except Exception:
        block = None
    cfg = dict(block) if isinstance(block, dict) else {}
    explicit = os.environ.get("ABMIND_BRIDGE_BIN", "").strip()
    binary = explicit or shutil.which("abmind-client-bridge") or ""
    if not binary:
        return None, "no bridge binary (ABMIND_BRIDGE_BIN or PATH)"
    mode = (os.environ.get("ABMIND_MODE", "") or str(cfg.get("mode", "local"))).strip().lower()
    if mode == "remote":
        profile = (os.environ.get("ABMIND_REMOTE_PROFILE", "") or str(cfg.get("remote_profile", ""))).strip()
        if not profile:
            return None, "remote mode needs a profile"
        return [binary, "--remote", profile], ""
    sock = (os.environ.get("ABMIND_SOCKET", "") or str(cfg.get("socket_path", ""))
            or os.path.expanduser("~/.abmind/run/abmind.sock")).strip()
    return [binary, "--local", sock], ""


def _rpc(argv, method, params, timeout=15):
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    try:
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        return json.loads(line) if line.strip() else {}
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


def abmind_command(args) -> int:
    """Handler for ``hermes abmind`` (wired as handler_fn by discovery)."""
    command = getattr(args, "abmind_command", "status") or "status"
    if command != "status":
        print(f"unknown abmind command: {command}", file=sys.stderr)
        return 2
    argv, problem = _resolve_argv()
    if argv is None:
        print(f"abmind status: unavailable ({problem})", file=sys.stderr)
        return 1
    try:
        caps = _rpc(argv, "bridge.negotiate", {})
        result = caps.get("result", {}) if isinstance(caps, dict) else {}
        methods = result.get("methods", []) if isinstance(result, dict) else []
        domains = result.get("domains", []) if isinstance(result, dict) else []
        want = ("private.lifecyclePrepareTurn", "private.lifecycleCompleteTurn",
                "private.lifecycleCheckpoint", "private.lifecycleObserve")
        missing = [m for m in want if m not in methods]
        print(f"bridge: up ({' '.join(argv[1:])})")
        print(f"methods: {len(methods)} domains: {','.join(domains)}")
        if missing:
            print(f"missing: {','.join(missing)}")
            return 1
        print("lifecycle: ready")
        return 0
    except Exception as e:
        print(f"abmind status: failed ({e})", file=sys.stderr)
        return 1


def register_cli(subparser) -> None:
    """Build the ``hermes abmind`` argparse subcommand tree."""
    subs = subparser.add_subparsers(dest="abmind_command")
    subs.add_parser("status", help="Check abmind bridge and lifecycle readiness")
    subparser.set_defaults(func=abmind_command)
