#!/usr/bin/env python3
"""Contract test for the abmind Hermes provider (#1383, amended contract).

Real Hermes ``MemoryManager`` + real provider + stub bridge process: proves
the host lifecycle drives the bridge with identity, policy bounds, writer
ownership and idempotency — and that delivery honesty holds (no confirmed
refs, no suppression input, no attribution without acknowledgment). Run:
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
os.environ["ABMIND_SOCKET"] = str(TMP / "unused.sock")
os.environ["ABMIND_BRIDGE_BIN"] = sys.executable

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

    prompt = manager.build_system_prompt()
    check("wake-up in system prompt", "wake hello" in prompt)

    before = len(read_log(log_path))
    check("trivial prefetch empty", manager.prefetch_all("thanks!", session_id="sess-1") == "")
    check("trivial prefetch no call", len(read_log(log_path)) == before)

    n_queued = len(read_log(log_path))
    manager.queue_prefetch_all("what do we use?", session_id="sess-1")
    manager.flush_pending(timeout=10)
    check("queue_prefetch makes no call", len(read_log(log_path)) == n_queued)
    text = manager.prefetch_all("what do we use?", session_id="sess-1")
    check("prefetch injects context", "test memory" in text)
    indicator = manager.describe_recall()
    check("recall indicator names abmind", "abmind" in indicator, indicator)
    prep = [c for c in read_log(log_path) if c["method"] == "private.lifecyclePrepareTurn"]
    check("prepareTurn observed", len(prep) >= 1)
    if prep:
        ident = prep[0]["payload"]["identity"]
        check("identity principal", ident["principalId"] == "u1", str(ident))
        check("identity generation present", ident.get("generation") == 0, str(ident))
        check("auto recall class ceiling",
              prep[0]["payload"]["policy"].get("maxClassification") == 2)
        fp = prep[0]["payload"].get("fastPath", {})
        check("no delivered refs without acknowledgment", fp.get("delivered", None) == [])

    # Each turn's prefetch is a fresh recall for the current query: a result
    # queued for the previous turn's message is never injected.
    n_before = len([c for c in read_log(log_path) if c["method"] == "private.lifecyclePrepareTurn"])
    manager.prefetch_all("what do we use?", session_id="sess-1")
    n_after = len([c for c in read_log(log_path) if c["method"] == "private.lifecyclePrepareTurn"])
    check("prefetch recalls fresh, no replay", n_after == n_before + 1, f"{n_before}->{n_after}")

    # Turn-bound capture: on_turn_start then sync carries execution + author.
    manager.on_turn_start(3, "user says hi", author_id="anna", author_name="Anna",
                          author_is_bot=False)
    manager.sync_all("user says hi", "assistant says hello", session_id="sess-1",
                     turn_author={"id": "anna", "name": "Anna", "is_bot": False})
    manager.flush_pending(timeout=10)
    calls = read_log(log_path)
    comp = [c for c in calls if c["method"] == "private.lifecycleCompleteTurn"]
    check("completeTurn observed", len(comp) == 1)
    if comp:
        check("completeTurn idempotent", bool(comp[0]["idempotencyKey"]))
        check("execution binding", comp[0]["payload"].get("executionId") == "turn-3",
              str(comp[0]["payload"].get("executionId")))
        check("author binding", comp[0]["payload"].get("author", {}).get("id") == "anna")
    attr = [c for c in calls if c["method"] == "private.attribution"]
    check("no attribution without delivery ack", len(attr) == 0, str(len(attr)))

    # Reconciliation: a queued sync must bind to its own turn even when the
    # next turn has already started (foreground tick overtakes the worker).
    manager.on_turn_start(10, "alpha question")
    manager.on_turn_start(11, "beta question")
    manager.sync_all("alpha question", "alpha answer", session_id="sess-1")
    manager.flush_pending(timeout=10)
    comp = [c for c in read_log(log_path) if c["method"] == "private.lifecycleCompleteTurn"]
    check("late sync binds its own turn", comp[-1]["payload"].get("executionId") == "turn-10",
          str(comp[-1]["payload"].get("executionId")))
    manager.sync_all("beta question", "beta answer", session_id="sess-1")
    manager.flush_pending(timeout=10)
    comp = [c for c in read_log(log_path) if c["method"] == "private.lifecycleCompleteTurn"]
    check("current sync binds its own turn", comp[-1]["payload"].get("executionId") == "turn-11",
          str(comp[-1]["payload"].get("executionId")))

    # Rewind on the same id fences discarded turns: a late sync is withheld.
    n_comp = len([c for c in read_log(log_path) if c["method"] == "private.lifecycleCompleteTurn"])
    manager.on_session_switch("sess-1", rewound=True)
    manager.sync_all("alpha question", "alpha answer", session_id="sess-1")
    manager.flush_pending(timeout=10)
    check("rewound turn not resurrected",
          len([c for c in read_log(log_path) if c["method"] == "private.lifecycleCompleteTurn"]) == n_comp)

    # Unknown session sync withholds capture instead of guessing.
    n_comp = len([c for c in read_log(log_path) if c["method"] == "private.lifecycleCompleteTurn"])
    manager.sync_all("stray", "stray out", session_id="sess-unknown")
    manager.flush_pending(timeout=10)
    check("ambiguous sync withheld",
          len([c for c in read_log(log_path) if c["method"] == "private.lifecycleCompleteTurn"]) == n_comp)

    out = json.loads(manager.handle_tool_call("abmind_recall", {"query": "usage"}))
    check("tool recall returns context", "test memory" in json.dumps(out))
    out = json.loads(manager.handle_tool_call("abmind_store", {"content": "standup at 9", "type": "fact"}))
    check("tool store returns id", out.get("ok") is True and out.get("memoryId") == 9, str(out))
    out = json.loads(manager.handle_tool_call("abmind_sleep", {"action": "status"}))
    check("sleep status passes through", "state" in json.dumps(out), str(out)[:100])
    out = json.loads(manager.handle_tool_call("abmind_operational_recall", {"query": "lessons"}))
    check("operational recall passes through", out.get("ok") is True, str(out))
    out = json.loads(manager.handle_tool_call("abmind_operational_draft", {"lesson": "test lesson"}))
    check("operational draft passes through", out.get("ok") is True, str(out))

    # Revision with old_text becomes an observation, not a silent store.
    n_store = len([c for c in read_log(log_path) if c["method"] == "private.lifecycleStore"])
    manager.notify_memory_tool_write(
        json.dumps({"success": True}), {"target": "memory", "action": "replace",
                                        "content": "new claim", "old_text": "old claim"},
        build_metadata=lambda: {"session_id": "sess-1", "tool_name": "memory", "write_origin": "test"})
    calls = read_log(log_path)
    obs = [c for c in calls if c["method"] == "private.lifecycleObserve"]
    check("revision observed", any(o["payload"].get("kind") == "committed-revision" for o in obs),
          str([o["payload"].get("kind") for o in obs]))
    check("revision not stored as fact",
          len([c for c in calls if c["method"] == "private.lifecycleStore"]) == n_store)

    # Delegation outcome observed; strict checkpoint acknowledged.
    manager.on_delegation("migrate db", "done", child_session_id="sess-9")
    calls = read_log(log_path)
    check("delegation observed",
          any(o["payload"].get("kind") == "delegation-outcome" for o in
              [c for c in calls if c["method"] == "private.lifecycleObserve"]))
    manager.on_pre_compress([{"role": "user", "content": "compress me"}],
                            require_checkpoint=True, checkpoint_api_version=2)
    calls = read_log(log_path)
    check("checkpoint observed",
          any(c["method"] == "private.lifecycleCheckpoint" for c in calls))

    # Session switch reports lineage; dead bridge raises strict, degrades reads.
    manager.on_session_switch("sess-2", parent_session_id="sess-1", reset=True)
    calls = read_log(log_path)
    check("lineage observed",
          any(o["payload"].get("kind") == "session-lineage" for o in
              [c for c in calls if c["method"] == "private.lifecycleObserve"]))
    provider.shutdown()
    try:
        provider.on_pre_compress([{"role": "user", "content": "x"}],
                                 require_checkpoint=True, checkpoint_api_version=2)
        check("strict checkpoint fails closed", False, "no raise")
    except RuntimeError:
        check("strict checkpoint fails closed", True)
    check("reads degrade empty without fallback",
          manager.prefetch_all("hello world query", session_id="sess-2") == "")
    out = json.loads(manager.handle_tool_call("abmind_store", {"content": "x"}))
    check("store without bridge errors", "error" in out, str(out))

    # Dashboard flat-JSON config beats config.yaml for resolution.
    (home / "abmind").mkdir(parents=True, exist_ok=True)
    (home / "abmind" / "config.json").write_text(
        json.dumps({"mode": "remote", "remote_profile": "panel-profile"}))
    cfg = mod._load_abmind_config()
    check("flat-json config merged", cfg.get("remote_profile") == "panel-profile", str(cfg))
    argv = mod._resolve_bridge_argv(cfg)
    check("flat-json drives bridge mode",
          argv is not None and "--remote" in argv and "panel-profile" in argv, str(argv))

    manager.shutdown_all()
    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
