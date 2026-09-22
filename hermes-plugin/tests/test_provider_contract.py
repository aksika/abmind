#!/usr/bin/env python3
"""Contract test for the abmind Hermes provider (#1383, amended contract).

Two modes, same assertions about host lifecycle wiring; they differ in what
stands behind the provider:

* stub (default) — real Hermes ``MemoryManager`` + real provider + scripted
  bridge process. Wire-level checks read the stub's request log, so identity,
  policy bounds, execution/author binding, idempotency keys and the absence
  of suppression refs / attribution are asserted directly.
  ``HERMES_AGENT_DIR=~/workspace/hermes-agent python3.12 test_provider_contract.py``
* real (``ABMIND_E2E_BRIDGE=real``) — the same manager and provider against a
  real ``abmind bridge`` process, a real daemon socket and real SQLite, with
  ``abmind`` resolved through a launcher-shaped PATH shim. Outcome checks read
  owner state through a short-lived bridge (captured conversation, checkpoint
  rows). Scratch storage only; no models, no network.

``bash scripts/hermes-e2e.sh`` drives both modes (build, scratch install,
foreground daemon, shim, cleanup). Neither mode is part of ``npm test``.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HERMES_DIR = Path(os.environ.get("HERMES_AGENT_DIR", "") or "")
if not HERMES_DIR.is_dir():
    print("HERMES_AGENT_DIR must point at a hermes-agent checkout")
    sys.exit(2)

REAL = os.environ.get("ABMIND_E2E_BRIDGE", "stub").strip().lower() == "real"
PRINCIPAL = os.environ.get("ABMIND_E2E_PRINCIPAL", "u1") or "u1"

TMP = Path(tempfile.mkdtemp(prefix="abmind-hermes-contract-"))
os.environ["HERMES_HOME"] = str(TMP / "hermes-home")
if not REAL:
    os.environ["ABMIND_SOCKET"] = str(TMP / "unused.sock")
    os.environ["ABMIND_BRIDGE_BIN"] = sys.executable
else:
    os.environ.pop("ABMIND_BRIDGE_BIN", None)

sys.path.insert(0, str(HERMES_DIR))

failures = []


def load_provider():
    spec = importlib.util.spec_from_file_location(
        "abmind_provider_under_test", str(HERE.parent / "__init__.py"))
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules["abmind_provider_under_test"] = mod
    spec.loader.exec_module(mod)
    return mod


def check(name, cond, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f" ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def read_log(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def owner_call(mod, method, payload, timeout=20):
    """One read against the real owner through a short-lived bridge process,
    resolved exactly as the provider resolves it."""
    cfg = mod._load_abmind_config()
    argv = mod._resolve_bridge_argv(cfg)
    assert argv, "bridge could not be resolved"
    proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    try:
        assert proc.stdin is not None and proc.stdout is not None
        proc.stdin.write(json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "abmind.call",
            "params": {"method": method, "payload": payload},
        }) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        assert line.strip(), f"no response for {method}"
        msg = json.loads(line)
        if msg.get("error"):
            raise RuntimeError(f"{method}: {msg['error']}")
        return msg.get("result")
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


def captured_text(mod):
    rows = owner_call(mod, "private.getRecentConversation",
                      {"userId": PRINCIPAL, "since": 0, "limit": 200})
    if not isinstance(rows, list):
        return ""
    return "\n".join(str(r.get("content", "")) for r in rows if isinstance(r, dict))


def main():
    from agent.memory_manager import MemoryManager

    mod = load_provider()
    log_path = TMP / "stub-requests.jsonl"
    if not REAL:
        os.environ["STUB_LOG"] = str(log_path)
        orig_resolve = mod._resolve_bridge_argv

        def resolve_with_stub(cfg):
            argv = orig_resolve(cfg)
            assert argv is not None and len(argv) > 1
            return [sys.executable, str(HERE / "stub_bridge.py")] + argv[1:]

        mod._resolve_bridge_argv = resolve_with_stub
    wire = None if REAL else (lambda: read_log(log_path))

    home = TMP / "hermes-home"
    home.mkdir(parents=True, exist_ok=True)

    manager = MemoryManager()
    provider = mod.AbmindMemoryProvider()
    # The provider never touches the cron store (operator-owned scheduling),
    # so this suite stays hermetic with no scheduler stubbing.
    manager.add_provider(provider)
    manager.initialize_all("sess-1", hermes_home=str(home), platform="test",
                           agent_context="primary", user_id=PRINCIPAL)

    prompt = manager.build_system_prompt()
    if REAL:
        check("bridge connected to the daemon", provider._bridge is not None
              and not provider._bridge_down)
        check("wake-up hydration returned text", isinstance(prompt, str))
    else:
        check("wake-up in system prompt", "wake hello" in prompt)

    if wire is not None:
        before = len(wire())
        check("trivial prefetch empty", manager.prefetch_all("thanks!", session_id="sess-1") == "")
        check("trivial prefetch no call", len(wire()) == before)
    else:
        check("trivial prefetch empty (real)", manager.prefetch_all("thanks!", session_id="sess-1") == "")

    # The tool store/recall round trip doubles as the marker for recall text.
    marker = "e2e marker hermes bridge lane alpha"
    out = json.loads(manager.handle_tool_call("abmind_store", {"content": marker, "type": "fact"}))
    if REAL:
        check("tool store returns id", out.get("ok") is True and isinstance(out.get("memoryId"), int),
              str(out))
    else:
        check("tool store returns id", out.get("ok") is True and out.get("memoryId") == 9, str(out))

    n_queued = len(wire()) if wire is not None else 0
    manager.queue_prefetch_all("what do we use?", session_id="sess-1")
    manager.flush_pending(timeout=10)
    if wire is not None:
        check("queue_prefetch makes no call", len(wire()) == n_queued)

    text = manager.prefetch_all(marker, session_id="sess-1")
    expected = marker if REAL else "test memory"
    check("prefetch injects context", expected in text, text[:120])
    indicator = manager.describe_recall()
    check("recall indicator names abmind", "abmind" in indicator, indicator)

    if wire is not None:
        prep = [c for c in wire() if c["method"] == "private.lifecyclePrepareTurn"]
        check("prepareTurn observed", len(prep) >= 1)
        if prep:
            ident = prep[0]["payload"]["identity"]
            check("identity principal", ident["principalId"] == PRINCIPAL, str(ident))
            check("identity generation present", ident.get("generation") == 0, str(ident))
            check("auto recall class ceiling",
                  prep[0]["payload"]["policy"].get("maxClassification") == 2)
            fp = prep[0]["payload"].get("fastPath", {})
            check("no delivered refs without acknowledgment", fp.get("delivered", None) == [])
        n_before = len([c for c in wire() if c["method"] == "private.lifecyclePrepareTurn"])
        manager.prefetch_all("what do we use?", session_id="sess-1")
        n_after = len([c for c in wire() if c["method"] == "private.lifecyclePrepareTurn"])
        check("prefetch recalls fresh, no replay", n_after == n_before + 1, f"{n_before}->{n_after}")

    # Turn-bound capture: on_turn_start then sync carries execution + author.
    manager.on_turn_start(3, "user says hi", author_id="anna", author_name="Anna",
                          author_is_bot=False)
    manager.sync_all("user says hi", "assistant says hello", session_id="sess-1",
                     turn_author={"id": "anna", "name": "Anna", "is_bot": False})
    manager.flush_pending(timeout=10)
    if wire is not None:
        comp = [c for c in wire() if c["method"] == "private.lifecycleCompleteTurn"]
        check("completeTurn observed", len(comp) == 1)
        if comp:
            check("completeTurn idempotent", bool(comp[0]["idempotencyKey"]))
            check("execution binding", comp[0]["payload"].get("executionId") == "turn-3",
                  str(comp[0]["payload"].get("executionId")))
            check("author binding", comp[0]["payload"].get("author", {}).get("id") == "anna")
        attr = [c for c in wire() if c["method"] == "private.attribution"]
        check("no attribution without delivery ack", len(attr) == 0, str(len(attr)))
    else:
        conv = captured_text(mod)
        check("completed turn captured", conv.count("user says hi") == 1
              and conv.count("assistant says hello") == 1, conv[-200:])

    # Reconciliation: a queued sync must bind to its own turn even when the
    # next turn has already started (foreground tick overtakes the worker).
    manager.on_turn_start(10, "alpha question")
    manager.on_turn_start(11, "beta question")
    manager.sync_all("alpha question", "alpha answer", session_id="sess-1")
    manager.flush_pending(timeout=10)
    manager.sync_all("beta question", "beta answer", session_id="sess-1")
    manager.flush_pending(timeout=10)
    if wire is not None:
        comp = [c for c in wire() if c["method"] == "private.lifecycleCompleteTurn"]
        check("late sync binds its own turn", comp[-2]["payload"].get("executionId") == "turn-10",
              str(comp[-2]["payload"].get("executionId")))
        check("current sync binds its own turn", comp[-1]["payload"].get("executionId") == "turn-11",
              str(comp[-1]["payload"].get("executionId")))
    else:
        conv = captured_text(mod)
        check("both reconciled turns captured once", conv.count("alpha question") == 1
              and conv.count("beta question") == 1, conv[-200:])

    # Rewind on the same id fences discarded turns: a late sync is withheld.
    n_comp = len([c for c in wire() if c["method"] == "private.lifecycleCompleteTurn"]) if wire else 0
    manager.on_session_switch("sess-1", rewound=True)
    manager.sync_all("alpha question", "alpha answer", session_id="sess-1")
    manager.flush_pending(timeout=10)
    if wire is not None:
        check("rewound turn not resurrected",
              len([c for c in wire() if c["method"] == "private.lifecycleCompleteTurn"]) == n_comp)
    else:
        check("rewound turn not resurrected", captured_text(mod).count("alpha question") == 1)

    # Unknown session sync withholds capture instead of guessing.
    n_comp = len([c for c in wire() if c["method"] == "private.lifecycleCompleteTurn"]) if wire else 0
    manager.sync_all("stray", "stray out", session_id="sess-unknown")
    manager.flush_pending(timeout=10)
    if wire is not None:
        check("ambiguous sync withheld",
              len([c for c in wire() if c["method"] == "private.lifecycleCompleteTurn"]) == n_comp)
    else:
        check("ambiguous sync withheld", "stray out" not in captured_text(mod))

    out = json.loads(manager.handle_tool_call("abmind_recall", {"query": marker}))
    check("tool recall returns context", expected in json.dumps(out), str(out)[:120])

    # Revision with old_text becomes an observation, not a silent store.
    n_store = len([c for c in wire() if c["method"] == "private.lifecycleStore"]) if wire else 0
    manager.notify_memory_tool_write(
        json.dumps({"success": True}), {"target": "memory", "action": "replace",
                                        "content": "new claim", "old_text": "old claim"},
        build_metadata=lambda: {"session_id": "sess-1", "tool_name": "memory", "write_origin": "test"})
    if wire is not None:
        calls = wire()
        obs = [c for c in calls if c["method"] == "private.lifecycleObserve"]
        check("revision observed", any(o["payload"].get("kind") == "committed-revision" for o in obs),
              str([o["payload"].get("kind") for o in obs]))
        check("revision not stored as fact",
              len([c for c in calls if c["method"] == "private.lifecycleStore"]) == n_store)
    else:
        recall = owner_call(mod, "private.recall", {
            "translated": ["new claim"], "original": "new claim",
            "userId": PRINCIPAL, "limit": 10})
        results = recall.get("results", []) if isinstance(recall, dict) else []
        check("revision not stored as fact",
              not any("new claim" in str(r.get("content", "")) for r in results), str(results)[:120])

    # Delegation outcome observed; strict checkpoint acknowledged, and a
    # repeated checkpoint converges instead of duplicating evidence.
    manager.on_delegation("migrate db", "done", child_session_id="sess-9")
    if wire is not None:
        calls = wire()
        check("delegation observed",
              any(o["payload"].get("kind") == "delegation-outcome" for o in
                  [c for c in calls if c["method"] == "private.lifecycleObserve"]))
    manager.on_pre_compress([{"role": "user", "content": "compress me"}],
                            require_checkpoint=True, checkpoint_api_version=2)
    manager.on_pre_compress([{"role": "user", "content": "compress me"}],
                            require_checkpoint=True, checkpoint_api_version=2)
    if wire is not None:
        check("checkpoint observed",
              any(c["method"] == "private.lifecycleCheckpoint" for c in wire()))
    else:
        check("checkpoint row captured once", captured_text(mod).count("compress me") == 1)

    # Leased-runtime sequence (the maintenance agent's flow), same tools.
    out = json.loads(manager.handle_tool_call("abmind_sleep_runtime", {"action": "open"}))
    lease = out.get("leaseId") if isinstance(out, dict) else None
    check("runtime lease opens", isinstance(out, dict) and out.get("status") == "ok"
          and isinstance(lease, str), str(out))
    out = json.loads(manager.handle_tool_call("abmind_sleep", {"action": "start", "level": "budget"}))
    check("sleep start accepted", out.get("status") in ("accepted", "already_running"), str(out))
    completed = False
    if lease:
        for _ in range(4 if REAL else 1):
            nxt = json.loads(manager.handle_tool_call(
                "abmind_sleep_runtime", {"action": "next", "leaseId": lease, "waitMs": 2000}))
            status = nxt.get("status") if isinstance(nxt, dict) else None
            req = nxt.get("completionRequest") if isinstance(nxt, dict) else None
            if status == "ok" and isinstance(req, dict):
                done = json.loads(manager.handle_tool_call("abmind_sleep_runtime", {
                    "action": "complete", "leaseId": lease,
                    "completionId": req.get("completionId"), "text": "E2E maintenance answer."}))
                check("runtime completion accepted", done.get("status") == "ok", str(done))
                completed = True
                break
            if status in ("no_request", "closed", "lease_expired"):
                break
        if not REAL:
            check("runtime served a completion request", completed)
        elif not completed:
            print("NOTE runtime completion not requested within the poll window")
        closed = json.loads(manager.handle_tool_call(
            "abmind_sleep_runtime", {"action": "close", "leaseId": lease}))
        check("runtime lease closes", isinstance(closed, dict)
              and closed.get("status") in ("ok", "not_found"), str(closed))

    out = json.loads(manager.handle_tool_call("abmind_sleep", {"action": "status"}))
    check("sleep status passes through", "state" in json.dumps(out), str(out)[:100])
    active = (out.get("active") or {}).get("runId") if isinstance(out, dict) else None
    if active:
        cancel = json.loads(manager.handle_tool_call(
            "abmind_sleep", {"action": "cancel", "runId": active}))
        check("sleep cancel accepted",
              cancel.get("status") in ("cancelling", "already_terminal"), str(cancel))
    elif not REAL:
        cancel = json.loads(manager.handle_tool_call(
            "abmind_sleep", {"action": "cancel", "runId": "run-1"}))
        check("sleep cancel passes through", cancel.get("status") == "cancelling", str(cancel))

    out = json.loads(manager.handle_tool_call("abmind_operational_recall", {"query": "lessons"}))
    check("operational recall passes through", out.get("ok") is True, str(out)[:120])
    out = json.loads(manager.handle_tool_call("abmind_operational_draft", {"lesson": "test lesson"}))
    check("operational draft passes through", out.get("ok") is True, str(out)[:120])
    out = json.loads(manager.handle_tool_call(
        "abmind_operational_draft", {"lesson": "global lesson", "scopeLevel": "global"}))
    check("global draft passes through", out.get("ok") is True, str(out)[:120])
    if wire is not None:
        drafts = [c["payload"] for c in wire() if c["method"] == "operational.submitDraft"]
        host_draft = next((d for d in drafts if d.get("scopeLevel") == "host"), None)
        check("host draft carries its matching scope value",
              host_draft is not None and host_draft.get("host") == "hermes"
              and all(k not in host_draft for k in ("platform", "workspace", "repository", "taskEnvironment")),
              str(host_draft))
        global_draft = next((d for d in drafts if d.get("scopeLevel") == "global"), None)
        check("global draft carries no scope value",
              global_draft is not None
              and all(k not in global_draft for k in ("platform", "host", "workspace", "repository", "taskEnvironment")),
              str(global_draft))

    # Session switch reports lineage; dead bridge raises strict, degrades reads.
    manager.on_session_switch("sess-2", parent_session_id="sess-1", reset=True)
    if wire is not None:
        check("lineage observed",
              any(o["payload"].get("kind") == "session-lineage" for o in
                  [c for c in wire() if c["method"] == "private.lifecycleObserve"]))
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
    manager.shutdown_all()

    # Dashboard flat-JSON config beats config.yaml; the bridge derivation
    # covers launcher, dev-checkout, and incomplete-remote shapes.
    home_abmind = home / "abmind"
    home_abmind.mkdir(parents=True, exist_ok=True)
    (home_abmind / "config.json").write_text(
        json.dumps({"mode": "remote", "remote_profile": "panel-profile"}))
    cfg = mod._load_abmind_config()
    check("flat-json config merged", cfg.get("remote_profile") == "panel-profile", str(cfg))
    argv = mod._with_mode(mod._bridge_command_for("/usr/bin/abmind"), cfg)
    check("flat-json drives bridge mode",
          argv is not None and "--remote" in argv and "panel-profile" in argv, str(argv))
    (home_abmind / "config.json").write_text(json.dumps({}))
    # The refusal logs a warning by design; quiet it for lane output.
    logging.getLogger("abmind_provider_under_test").setLevel(logging.ERROR)
    missing = mod._with_mode(mod._bridge_command_for("/usr/bin/abmind"), {"mode": "remote"})
    logging.getLogger("abmind_provider_under_test").setLevel(logging.NOTSET)
    check("remote without profile refuses", missing is None, str(missing))
    launcher = mod._bridge_command_for("/usr/local/bin/abmind")
    check("launcher layout uses the CLI passthrough",
          isinstance(launcher, list) and launcher[-1] == "bridge", str(launcher))

    print(f"{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
