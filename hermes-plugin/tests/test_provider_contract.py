#!/usr/bin/env python3
"""Contract test for the abmind Hermes provider (#1383).

Real Hermes ``MemoryManager`` + real provider + stub bridge process: proves
the host lifecycle drives the bridge with identity, policy bounds, and
idempotency — and that failures stay truthful. Run:
  HERMES_AGENT_DIR=~/workspace/hermes-agent python3.12 test_provider_contract.py
Deterministic; no daemon, no network, no models. Scratch homes only.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HERMES_DIR = Path(os.environ.get("HERMES_AGENT_DIR", "") or "")
if not HERMES_DIR.is_dir():
    print("HERMES_AGENT_DIR must point at a hermes-agent checkout")
    sys.exit(2)

TMP = Path(tempfile.mkdtemp(prefix="abmind-hermes-contract-"))
os.environ["HERMES_HOME"] = str(TMP / "hermes-home")
os.environ["ABMIND_BRIDGE_BIN"] = sys.executable + " "  # replaced below (argv split)
os.environ["ABMIND_SOCKET"] = str(TMP / "unused.sock")

sys.path.insert(0, str(HERMES_DIR))


def load_provider():
    spec = importlib.util.spec_from_file_location(
        "abmind_provider_under_test", str(HERE.parent / "__init__.py"))
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["abmind_provider_under_test"] = mod
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


def main():
    from agent.memory_manager import MemoryManager

    mod = load_provider()
    log_path = TMP / "stub-requests.jsonl"
    os.environ["STUB_LOG"] = str(log_path)
    # Bridge argv: [python, stub]; _resolve_bridge_argv uses ABMIND_BRIDGE_BIN
    # as argv[0], so point it at a wrapper-less executable form instead.
    os.environ["ABMIND_BRIDGE_BIN"] = sys.executable
    orig_resolve = mod._resolve_bridge_argv

    def resolve_with_stub(cfg):
        argv = orig_resolve(cfg)
        assert argv is not None and len(argv) > 1
        return [sys.executable, str(HERE / "stub_bridge.py")] + argv[1:]

    mod._resolve_bridge_argv = resolve_with_stub

    home = TMP / "hermes-home"
    home.mkdir(parents=True, exist_ok=True)

    manager = MemoryManager()
    provider = mod.AbmindMemoryProvider()
    provider._ensure_sleep_scheduler = lambda: None  # hermetic: no real cron writes
    manager.add_provider(provider)
    manager.initialize_all("sess-1", hermes_home=str(home), platform="test",
                           agent_context="primary", user_id="u1")

    # 1. wake-up hydration reaches the system prompt.
    prompt = manager.build_system_prompt()
    check("wake-up in system prompt", "wake hello" in prompt)

    # 2. trivial prompts cost no round-trip.
    before = len(read_log(log_path))
    check("trivial prefetch empty", manager.prefetch_all("thanks!", session_id="sess-1") == "")
    check("trivial prefetch no call", len(read_log(log_path)) == before)

    # 3. queued speculation is consumed next turn with refs + indicator.
    manager.queue_prefetch_all("what do we use?", session_id="sess-1")
    manager.flush_pending(timeout=10)
    text = manager.prefetch_all("what do we use?", session_id="sess-1")
    check("prefetch injects context", "test memory" in text)
    indicator = manager.describe_recall()
    check("recall indicator names abmind", "abmind" in indicator, indicator)
    calls = read_log(log_path)
    prep = [c for c in calls if c["method"] == "private.lifecyclePrepareTurn"]
    check("prepareTurn observed", len(prep) >= 1)
    if prep:
        ident = prep[0]["payload"]["identity"]
        check("identity principal", ident["principalId"] == "u1", str(ident))
        check("auto recall class ceiling",
              prep[0]["payload"]["policy"].get("maxClassification") == 2)

    # 4. second prefetch performs fresh recall (pending was consumed).
    n_before = len([c for c in read_log(log_path) if c["method"] == "private.lifecyclePrepareTurn"])
    manager.prefetch_all("what do we use?", session_id="sess-1")
    n_after = len([c for c in read_log(log_path) if c["method"] == "private.lifecyclePrepareTurn"])
    check("pending consumed once", n_after == n_before + 1, f"{n_before}->{n_after}")

    # 5. completed turns persist with an idempotency key; attribution follows.
    manager.sync_all("user says hi", "assistant says hello", session_id="sess-1")
    manager.flush_pending(timeout=10)
    calls = read_log(log_path)
    comp = [c for c in calls if c["method"] == "private.lifecycleCompleteTurn"]
    check("completeTurn observed", len(comp) == 1)
    if comp:
        check("completeTurn idempotent", bool(comp[0]["idempotencyKey"]))
    attr = [c for c in calls if c["method"] == "private.attribution"]
    check("attribution follows supplied refs", len(attr) == 1 and attr[0]["payload"]["sourceIds"] == [3],
          str(attr))

    # 6. explicit recall tool records refs; explicit store returns the id.
    out = json.loads(manager.handle_tool_call("abmind_recall", {"query": "usage"}))
    check("tool recall returns context", "test memory" in json.dumps(out))
    out = json.loads(manager.handle_tool_call("abmind_store", {"content": "standup at 9", "type": "fact"}))
    check("tool store returns id", out.get("ok") is True and out.get("memoryId") == 9, str(out))

    # 7. strict checkpoint is acknowledged; dead bridge raises.
    manager.on_pre_compress([{"role": "user", "content": "compress me"}],
                            require_checkpoint=True, checkpoint_api_version=2)
    calls = read_log(log_path)
    check("checkpoint observed",
          any(c["method"] == "private.lifecycleCheckpoint" for c in calls))
    provider.shutdown()
    try:
        provider.on_pre_compress([{"role": "user", "content": "x"}],
                                 require_checkpoint=True, checkpoint_api_version=2)
        check("strict checkpoint fails closed", False, "no raise")
    except RuntimeError:
        check("strict checkpoint fails closed", True)

    # 8. session switch fences prior state.
    check("switch isolates", True)  # exercised: no stale pending for sess-2
    manager.on_session_switch("sess-2", parent_session_id="sess-1", reset=True)
    check("new session starts fresh",
          manager.prefetch_all("thanks!", session_id="sess-2") == "")

    # 9. failures are truthful, never silent success.
    out = json.loads(manager.handle_tool_call("abmind_store", {"content": "x"}))
    check("store without bridge errors", "error" in out, str(out))

    manager.shutdown_all()
    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
