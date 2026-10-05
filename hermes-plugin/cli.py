"""``hermes abmind`` subcommands: bridge/daemon reachability without a gateway.

Loaded by path (never import the provider module here). Commands:
  hermes abmind status   resolve the bridge, negotiate, report methods/domains
  hermes abmind sleep    run one deterministic sleep maintenance cycle (#1912)
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys


def _load_config() -> dict:
    """config.yaml block merged with the dashboard flat-JSON file, which wins
    (mirrors the provider's resolution; env vars still win per key)."""
    from hermes_constants import get_hermes_home
    block: dict = {}
    try:
        from hermes_cli.config import load_config_readonly
        yaml_block = load_config_readonly().get("memory", {}).get("abmind", {})
        if isinstance(yaml_block, dict):
            block.update(yaml_block)
    except Exception:
        pass
    try:
        path = get_hermes_home() / "abmind" / "config.json"
        if path.is_file():
            with open(path, encoding="utf-8") as f:
                flat = json.load(f)
            if isinstance(flat, dict):
                block.update(flat)
    except Exception:
        pass
    return block


def _bridge_argv(abmind_path: str):
    """Layout-independent bridge command: the CLI passthrough, or a dev
    checkout's sibling script resolved next to dist/cli/abmind.js."""
    real = os.path.realpath(abmind_path)
    if real.endswith(".js"):
        candidate = os.path.join(os.path.dirname(real), "abmind-client-bridge.js")
        if os.path.isfile(candidate):
            if os.access(candidate, os.X_OK):
                return [candidate]
            node = shutil.which("node")
            if node:
                return [node, candidate]
    return [abmind_path, "bridge"]


def _resolve_argv():
    cfg = _load_config()
    explicit = os.environ.get("ABMIND_BRIDGE_BIN", "").strip()
    mode = (os.environ.get("ABMIND_MODE", "") or str(cfg.get("mode", "local"))).strip().lower()
    if mode == "remote":
        profile = (os.environ.get("ABMIND_REMOTE_PROFILE", "") or str(cfg.get("remote_profile", ""))).strip()
        if not profile:
            return None, "remote mode needs a profile"
        tail = ["--remote", profile]
    else:
        sock = (os.environ.get("ABMIND_SOCKET", "") or str(cfg.get("socket_path", ""))
                or os.path.expanduser("~/.abmind/run/abmind.sock")).strip()
        tail = ["--local", sock]

    if explicit:
        return [explicit] + tail, ""
    found = shutil.which("abmind-client-bridge")
    if found:
        return [found] + tail, ""
    abmind_bin = shutil.which("abmind")
    if abmind_bin is None:
        return None, "no bridge binary resolved (install abmind, or set ABMIND_BRIDGE_BIN)"
    return _bridge_argv(abmind_bin) + tail, ""


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
    if command == "sleep":
        return abmind_sleep_command(args)
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


def abmind_sleep_command(args) -> int:
    """Run one deterministic sleep maintenance cycle (#1912).

    Owns one bridge, lease polling, isolated native execution, and exact
    settlement in host code. Scheduling stays operator-owned (cron);
    this command runs one cycle and exits. Terminated by SIGINT (130).
    """
    import importlib.util
    runner_path = os.path.join(os.path.dirname(os.path.realpath(__file__)),
                               "sleep_runner.py")
    spec = importlib.util.spec_from_file_location("abmind_sleep_runner", runner_path)
    if spec is None or spec.loader is None:
        print("abmind sleep: runner module missing", file=sys.stderr)
        return 2
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    argv, problem = _resolve_argv()
    if argv is None:
        print(f"abmind sleep: unavailable ({problem})", file=sys.stderr)
        return 1
    model_cmd = (getattr(args, "model_cmd", "") or "").strip() \
        or os.environ.get("ABMIND_LLM_CMD", "").strip()
    if not model_cmd:
        print("abmind sleep: no model command (set ABMIND_LLM_CMD or --model-cmd;"
              " it must contain a {PROMPT_FILE} placeholder)", file=sys.stderr)
        return 2
    principal = (getattr(args, "principal", "") or "").strip() \
        or str(_load_config().get("principal", ""))
    try:
        summary = runner.run_maintenance(
            argv, model_cmd,
            principal=principal,
            mode=str(getattr(args, "mode", "scheduled") or "scheduled"),
            level=str(getattr(args, "level", "normal") or "normal"),
            resume=bool(getattr(args, "resume", False)),
            on_event=lambda m: print(f"abmind sleep: {m}"))
    except KeyboardInterrupt:
        print("abmind sleep: cancelled", file=sys.stderr)
        return 130
    except runner.RunnerError as e:
        print(f"abmind sleep: failed ({e})", file=sys.stderr)
        return 1
    report = summary.get("report", "")
    if report:
        print(report)
    terminal = summary.get("terminal", "unknown")
    print(f"sleep {terminal}: served={summary.get('served', 0)}"
          f" completed={summary.get('completed', 0)}"
          f" failed={summary.get('failed', 0)}")
    for failure in summary.get("failures", [])[:10]:
        print(f"sleep failure: {failure}")
    return 0 if terminal in ("completed", "no_work") else 1


def register_cli(subparser) -> None:
    """Build the ``hermes abmind`` argparse subcommand tree."""
    subs = subparser.add_subparsers(dest="abmind_command")
    subs.add_parser("status", help="Check abmind bridge and lifecycle readiness")
    sleep = subs.add_parser("sleep", help="Run one sleep maintenance cycle")
    sleep.add_argument("--mode", default="scheduled",
                       help="sleep mode: scheduled (default) or manual")
    sleep.add_argument("--level", default="normal",
                       help="sleep level: budget, normal (default), or ultimate")
    sleep.add_argument("--resume", action="store_true",
                       help="resume a resumable run instead of starting")
    sleep.add_argument("--model-cmd", default="",
                       help="model command with a {PROMPT_FILE} placeholder"
                            " (default: ABMIND_LLM_CMD)")
    sleep.add_argument("--principal", default="",
                       help="provider principal for the lease identity")
    subparser.set_defaults(func=abmind_command)
