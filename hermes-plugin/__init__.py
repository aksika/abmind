"""
abmind memory plugin for Hermes-Agent (#1383, persistent-bridge edition).

Thin provider over one persistent ``abmind-client-bridge`` subprocess speaking
the language-neutral bridge contract (``bridge.negotiate`` / ``abmind.call`` /
``bridge.close``). The bridge owns the canonical TypeScript AbmindClient and
selects local Unix (default, ``~/.abmind/run/abmind.sock``) or remote signed
WSS. This module implements no transport crypto, framing, replay defense,
retry, or capability negotiation, and no memory or judgment policy: every
decision is made owner-side by abmind.

Synchronous by host design: Hermes backgrounds ``sync_turn`` and
``queue_prefetch`` on its own single worker, so this provider performs one
blocking bridge call per hook and owns no worker threads. The single bridge
reader thread is spawned through ``spawn_context_thread`` (profile isolation).

Delivery honesty (verified host limits): Hermes offers no prefetch-delivery
or final-response acknowledgment, so this provider sends no confirmed
delivered refs, runs no repeat suppression and no attribution. Fast-path
output is consumed as grounded context only; unexpected already-supplied
verdicts are ordinary recall. Feedback travels as observations
(``private.lifecycleObserve``) with volatile diagnostic-only receipts.

Writes require the daemon's trusted configuration: the principal must be an
enabled lifecycle writer (see abmind ``--lifecycle-write-owners``), or
capture is skipped with a reason instead of failing open.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import queue
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from agent.memory_provider import (
    MemoryProvider,
    RecallStatus,
    is_trivial_prompt,
    spawn_context_thread,
)
from tools.registry import tool_error

logger = logging.getLogger(__name__)

# Pre-compress checkpoint contract offered to the host.
PRE_COMPRESS_CHECKPOINT_API_VERSION = 2

_RECALL_TIMEOUT = 7.0
_WRITE_TIMEOUT = 10.0
_SETUP_TIMEOUT = 15.0
_SHUTDOWN_BUDGET = 4.5
_DEFAULT_LIMIT = 5
_DEFAULT_MAX_CHARS = 2000
_CHECKPOINT_MAX_MESSAGES = 50
_EVIDENCE_TRUNCATE = 2000
_SLEEP_SCHEDULE = "0 3 * * *"
_SLEEP_MAX_COMPLETIONS = 12

_NON_PRIMARY_CONTEXTS = ("subagent", "cron", "flush")


class _BridgeError(RuntimeError):
    """Bridge call failed, timed out, or the bridge process is gone."""


class _Bridge:
    """One persistent abmind-client-bridge subprocess (NDJSON JSON-RPC)."""

    def __init__(self, argv: List[str]):
        self._argv = argv
        self._proc: Optional[subprocess.Popen] = None
        self._write_lock = threading.Lock()
        self._pending: Dict[Any, "queue.Queue[Any]"] = {}
        self._pending_lock = threading.Lock()
        self._next_id = 0
        self._id_lock = threading.Lock()
        self._reader: Optional[threading.Thread] = None
        self._closed = False

    def start(self, timeout: float = _SETUP_TIMEOUT) -> Dict[str, Any]:
        """Spawn the bridge and negotiate capabilities; raises _BridgeError."""
        try:
            self._proc = subprocess.Popen(
                self._argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except (FileNotFoundError, PermissionError, OSError) as e:
            raise _BridgeError(f"cannot spawn bridge: {e}")
        self._reader = spawn_context_thread(self._read_loop, name="abmind-bridge-reader")
        self._reader.start()
        negotiated = self.call("bridge.negotiate", {}, timeout=timeout)
        if not isinstance(negotiated, dict):
            self.close()
            raise _BridgeError("bridge.negotiate returned no capabilities")
        return negotiated

    def _read_loop(self) -> None:
        assert self._proc is not None and self._proc.stdout is not None
        try:
            for line in self._proc.stdout:
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                msg_id = msg.get("id")
                with self._pending_lock:
                    box = self._pending.pop(msg_id, None)
                if box is not None:
                    box.put(msg)
        except Exception as e:
            logger.debug("abmind bridge reader ended: %s", e)
        finally:
            # Unblock every waiter: a dead reader must not hang a turn.
            with self._pending_lock:
                stale, self._pending = self._pending, {}
            for box in stale.values():
                box.put({"id": None, "error": {"code": -32000, "message": "bridge reader ended"}})

    def call(self, method: str, params: Dict[str, Any], timeout: float = _RECALL_TIMEOUT) -> Any:
        """One JSON-RPC round-trip; raises _BridgeError on any failure."""
        if self._closed or self._proc is None:
            raise _BridgeError("bridge is closed")
        with self._id_lock:
            self._next_id += 1
            req_id = self._next_id
        box: "queue.Queue[Any]" = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[req_id] = box
        line = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
        try:
            with self._write_lock:
                assert self._proc.stdin is not None
                self._proc.stdin.write(line + "\n")
                self._proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise _BridgeError(f"bridge write failed: {e}")
        try:
            msg = box.get(timeout=timeout)
        except queue.Empty:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise _BridgeError(f"bridge call {method} timed out after {timeout}s")
        if self._proc.poll() is not None and "error" not in msg:
            raise _BridgeError("bridge process exited")
        err = msg.get("error")
        if err is not None:
            raise _BridgeError(f"bridge {method} failed: {err.get('message', err)}")
        return msg.get("result")

    def abmind(self, method: str, payload: Dict[str, Any], *,
               idempotency_key: Optional[str] = None, timeout: float = _RECALL_TIMEOUT) -> Any:
        params: Dict[str, Any] = {"method": method, "payload": payload}
        if idempotency_key:
            params["idempotencyKey"] = idempotency_key
        return self.call("abmind.call", params, timeout=timeout)

    def alive(self) -> bool:
        return not self._closed and self._proc is not None and self._proc.poll() is None

    def close(self) -> int:
        """Graceful close inside one bounded budget (the host drains ~5s).

        Returns the number of waiters abandoned (0 normally)."""
        deadline = time.time() + _SHUTDOWN_BUDGET
        self._closed = True
        abandoned = 0
        try:
            if self.alive():
                try:
                    self.call("bridge.close", {}, timeout=max(0.5, deadline - time.time()))
                except _BridgeError as e:
                    logger.debug("abmind bridge.close: %s", e)
        finally:
            if self._proc is not None:
                try:
                    self._proc.stdin.close()  # type: ignore[union-attr]
                except Exception:
                    pass
                try:
                    self._proc.wait(timeout=max(0.5, (deadline - time.time()) / 2))
                except Exception:
                    self._proc.kill()
            with self._pending_lock:
                abandoned = len(self._pending)
        if self._reader is not None and self._reader.is_alive():
            self._reader.join(timeout=max(0.5, deadline - time.time()))
        return abandoned


def _load_abmind_config() -> Dict[str, Any]:
    """``memory.abmind`` block from config.yaml (empty on error)."""
    try:
        from hermes_cli.config import load_config_readonly
        block = load_config_readonly().get("memory", {}).get("abmind", {})
    except Exception:
        block = None
    return dict(block) if isinstance(block, dict) else {}


def _resolve_bridge_argv(cfg: Dict[str, Any]) -> Optional[List[str]]:
    """Bridge command, or None when no bridge binary resolves."""
    explicit = os.environ.get("ABMIND_BRIDGE_BIN", "").strip()
    if explicit:
        return _with_mode([explicit], cfg)
    found = shutil.which("abmind-client-bridge")
    if found:
        return _with_mode([found], cfg)
    return None


def _with_mode(base: List[str], cfg: Dict[str, Any]) -> List[str]:
    mode = (os.environ.get("ABMIND_MODE", "") or str(cfg.get("mode", "local"))).strip().lower()
    if mode == "remote":
        profile = (os.environ.get("ABMIND_REMOTE_PROFILE", "") or str(cfg.get("remote_profile", ""))).strip()
        if not profile:
            return base  # caller treats a modeless argv as unusable; never guess a profile
        return base + ["--remote", profile]
    socket_path = (
        os.environ.get("ABMIND_SOCKET", "")
        or str(cfg.get("socket_path", ""))
        or os.path.expanduser("~/.abmind/run/abmind.sock")
    ).strip()
    return base + ["--local", socket_path]


def _fallback_enabled(cfg: Dict[str, Any]) -> bool:
    """Legacy CLI fallback is explicit opt-in only: hook-recall cannot carry
    identity, so it is never an equivalent guarantee by default."""
    return (os.environ.get("ABMIND_FALLBACK", "") or str(cfg.get("fallback", "off"))).strip().lower() == "cli"


def _run_abmind_cli(args: List[str], timeout: float = 10, input_data: str = "") -> Optional[str]:
    """Explicit-opt-in per-call CLI fallback (judged text, capped, class <= 2)."""
    try:
        result = subprocess.run(
            ["abmind"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_data or None,
        )
        if result.returncode != 0:
            logger.debug("abmind %s failed: %s", " ".join(args), result.stderr.strip()[:200])
            return None
        return result.stdout.strip()
    except FileNotFoundError:
        return None
    except subprocess.TimeoutExpired:
        logger.warning("abmind %s timed out", " ".join(args))
        return None
    except Exception as e:
        logger.debug("abmind %s error: %s", " ".join(args), e)
        return None


RECALL_SCHEMA = {
    "name": "abmind_recall",
    "description": "Search long-term memory for relevant facts, preferences, and past conversations.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Keywords or natural language query"}
        },
        "required": ["query"],
    },
}

STORE_SCHEMA = {
    "name": "abmind_store",
    "description": "Store an important fact or preference in long-term memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "content": {"type": "string", "description": "The information to remember"},
            "type": {"type": "string", "enum": ["fact", "preference", "entity"], "description": "Memory type"},
        },
        "required": ["content"],
    },
}

SLEEP_SCHEMA = {
    "name": "abmind_sleep",
    "description": "Control abmind memory maintenance (sleep): start a run, check status, read events, cancel or resume.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["start", "status", "events", "cancel", "resume"],
                       "description": "Run control action."},
            "level": {"type": "string", "description": "Sleep level for start (e.g. normal, budget)."},
            "runId": {"type": "string", "description": "Run id for cancel/resume."},
            "afterSeq": {"type": "integer", "description": "First event sequence for events."},
            "limit": {"type": "integer", "description": "Max events to return."},
        },
        "required": ["action"],
    },
}

SLEEP_RUNTIME_SCHEMA = {
    "name": "abmind_sleep_runtime",
    "description": "Serve the abmind sleep runtime lease: open a lease, poll for completion requests, submit or fail completions, close. For the maintenance agent.",
    "parameters": {
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["open", "next", "complete", "fail", "close"],
                       "description": "Lease action."},
            "leaseId": {"type": "string", "description": "Lease id from open."},
            "completionId": {"type": "string", "description": "Completion id from next."},
            "text": {"type": "string", "description": "Completion text for complete."},
            "code": {"type": "string", "description": "Failure code for fail."},
            "waitMs": {"type": "integer", "description": "Poll wait for next (ms)."},
        },
        "required": ["action"],
    },
}

OPERATIONAL_RECALL_SCHEMA = {
    "name": "abmind_operational_recall",
    "description": "Search abmind working memory (operational lessons and drafts under review) — distinct from private long-term memory.",
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "What to search for."},
            "limit": {"type": "integer", "description": "Max results (default 5)."},
        },
        "required": ["query"],
    },
}

OPERATIONAL_DRAFT_SCHEMA = {
    "name": "abmind_operational_draft",
    "description": "Submit a working-memory draft (lesson proposal) for later review. Nothing is promoted automatically.",
    "parameters": {
        "type": "object",
        "properties": {
            "lesson": {"type": "string", "description": "One-line lesson or proposal."},
            "problem": {"type": "string", "description": "Problem it addresses."},
            "recommendation": {"type": "string", "description": "Recommended handling."},
            "scopeLevel": {"type": "string",
                           "enum": ["global", "platform", "host", "workspace", "repository", "task_environment"]},
            "confidence": {"type": "number", "description": "Self-assessed confidence 0-1."},
        },
        "required": ["lesson"],
    },
}

_STORE_TYPE_MAP = {"fact": "fact", "preference": "preference", "entity": "fact"}
_VALID_SCOPES = ("global", "platform", "host", "workspace", "repository", "task_environment")


class AbmindMemoryProvider(MemoryProvider):
    """abmind as a Hermes memory provider — persistent cross-session memory."""

    pre_compress_checkpoint_api_version = PRE_COMPRESS_CHECKPOINT_API_VERSION

    def __init__(self):
        self._bridge: Optional[_Bridge] = None
        self._bridge_down = False
        self._fallback_cli = False
        self._lock = threading.Lock()
        self._principal = ""
        self._mode = "local"
        self._writes_allowed = True
        self._limit = _DEFAULT_LIMIT
        self._max_chars = _DEFAULT_MAX_CHARS
        self._wakeup_context = ""
        self._parent_session = ""
        self._hermes_home = ""
        self._session_id = ""
        self._generations: Dict[str, int] = {}
        self._turn_records: Dict[Tuple[str, int], Dict[str, Any]] = {}
        self._pending: Dict[str, Tuple[str, str, int]] = {}
        self._last_count: Optional[int] = None
        self._initialized = False

    @property
    def name(self) -> str:
        return "abmind"

    def is_available(self) -> bool:
        cfg = _load_abmind_config()
        argv = _resolve_bridge_argv(cfg)
        if argv is not None and len(argv) > 1:
            return True
        return _fallback_enabled(cfg) and shutil.which("abmind") is not None

    def unavailable_reason(self) -> str:
        return ("abmind bridge unreachable. Resolve abmind-client-bridge "
                "(ABMIND_BRIDGE_BIN or PATH) and enable this principal in the "
                "daemon (abmind --lifecycle-write-owners).")

    def get_config_schema(self) -> List[Dict[str, Any]]:
        # Every field carries env_var, so no save_config override is needed.
        return [
            {"key": "mode", "description": "Transport: local Unix socket or remote signed WSS profile",
             "default": "local", "choices": ["local", "remote"], "env_var": "ABMIND_MODE"},
            {"key": "socket_path", "description": "Local daemon socket path",
             "default": "~/.abmind/run/abmind.sock", "env_var": "ABMIND_SOCKET"},
            {"key": "remote_profile", "description": "Remote profile name from abmind client config (remote mode)",
             "default": "", "env_var": "ABMIND_REMOTE_PROFILE"},
            {"key": "principal", "description": "abmind principal to act as (defaults to the Hermes user id)",
             "default": "", "env_var": "ABMIND_PRINCIPAL"},
            {"key": "recall_limit", "description": "Max recall hits per turn", "type": "integer",
             "default": _DEFAULT_LIMIT, "minimum": 1, "maximum": 50, "env_var": "ABMIND_RECALL_LIMIT"},
            {"key": "recall_max_chars", "description": "Max injected recall chars per turn", "type": "integer",
             "default": _DEFAULT_MAX_CHARS, "minimum": 100, "env_var": "ABMIND_RECALL_MAX_CHARS"},
            {"key": "fallback", "description": "Explicit opt-in legacy CLI fallback when the bridge is down (off by default)",
             "default": "off", "choices": ["off", "cli"], "env_var": "ABMIND_FALLBACK"},
        ]

    # -- identity ------------------------------------------------------

    def _generation(self, session_id: str) -> int:
        with self._lock:
            return self._generations.get(session_id, 0)

    def _identity(self, session_id: str, turn: int = 0) -> Dict[str, Any]:
        return {
            "principalId": self._principal,
            "conversationId": session_id or self._session_id or "default",
            "executionId": f"turn-{turn}",
            "generation": self._generation(session_id or self._session_id or "default"),
            "host": "hermes",
            "origin": "agent",
            "automaticWriteOwner": self._principal,
        }

    def _current_record(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Immutable pending turn record for this session: current generation
        first, previous generation (post-switch race) second, else unknown."""
        gen = self._generation(session_id)
        with self._lock:
            rec = self._turn_records.get((session_id, gen))
            if rec is not None:
                return dict(rec)
            if gen > 0:
                prev = self._turn_records.get((session_id, gen - 1))
                if prev is not None:
                    return dict(prev)
            return None

    # -- lifecycle -----------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        cfg = _load_abmind_config()
        user_id = str(kwargs.get("user_id") or kwargs.get("user_id_alt") or "default")
        self._principal = (
            os.environ.get("ABMIND_PRINCIPAL", "") or str(cfg.get("principal", "")) or user_id
        ).strip() or "default"
        # Non-primary contexts observe but never write.
        self._writes_allowed = str(kwargs.get("agent_context", "primary")) not in _NON_PRIMARY_CONTEXTS
        self._parent_session = str(kwargs.get("parent_session_id", "") or "")
        try:
            self._limit = max(1, min(50, int(os.environ.get("ABMIND_RECALL_LIMIT", "") or cfg.get("recall_limit", _DEFAULT_LIMIT))))
        except ValueError:
            self._limit = _DEFAULT_LIMIT
        try:
            self._max_chars = max(100, int(os.environ.get("ABMIND_RECALL_MAX_CHARS", "") or cfg.get("recall_max_chars", _DEFAULT_MAX_CHARS)))
        except ValueError:
            self._max_chars = _DEFAULT_MAX_CHARS
        self._session_id = session_id
        self._hermes_home = str(kwargs.get("hermes_home", "") or "")
        self._mode = (os.environ.get("ABMIND_MODE", "") or str(cfg.get("mode", "local"))).strip().lower() or "local"
        self._fallback_cli = _fallback_enabled(cfg)

        argv = _resolve_bridge_argv(cfg)
        if argv is not None and len(argv) > 1:
            bridge = _Bridge(argv)
            try:
                caps = bridge.start()
                methods = caps.get("methods", []) if isinstance(caps, dict) else []
                domains = caps.get("domains", []) if isinstance(caps, dict) else []
                required = ("private.lifecyclePrepareTurn", "private.lifecycleCompleteTurn",
                            "private.lifecycleCheckpoint", "private.lifecycleObserve")
                missing = [m for m in required if m not in methods]
                if "private" not in domains:
                    missing = missing + ["domain:private"]
                if missing:
                    raise _BridgeError(f"bridge lacks {missing}")
                self._bridge = bridge
                wake = bridge.abmind("private.lifecycleStartSession", {
                    "identity": self._identity(session_id), "maxChars": self._max_chars,
                }, timeout=_SETUP_TIMEOUT)
                self._wakeup_context = wake.get("context", "") if isinstance(wake, dict) else ""
            except _BridgeError as e:
                logger.warning("abmind bridge unavailable (%s)", e)
                try:
                    bridge.close()
                except Exception:
                    pass
                self._bridge = None
                self._bridge_down = True
        else:
            self._bridge_down = True
            if self._fallback_cli:
                output = _run_abmind_cli(["hook-wakeup"], timeout=_RECALL_TIMEOUT)
                self._wakeup_context = output or ""
        if self._bridge is None and not (self._fallback_cli and shutil.which("abmind")):
            logger.warning("abmind inert: no bridge and no opted-in CLI fallback")
        self._initialized = True
        if self._writes_allowed:
            self._ensure_sleep_scheduler()
        logger.info("abmind initialized (bridge=%s, wake-up: %d chars)",
                    "up" if self._bridge is not None else "down", len(self._wakeup_context))

    def system_prompt_block(self) -> str:
        return self._wakeup_context

    def identity_signature(self) -> Dict[str, Any]:
        return {"abmind_principal": self._principal or "default", "abmind_mode": self._mode}

    # -- recall ----------------------------------------------------------

    def _recall_via_bridge(self, bridge: _Bridge, session_id: str, query: str) -> Tuple[str, int]:
        """Structured prepareTurn; returns (context text, retrieved ref count).

        No delivered refs are ever sent: without host delivery acknowledgment
        there is no sound suppression input, so fast-path intent carries the
        question only and the decision envelope is consumed as context."""
        payload: Dict[str, Any] = {
            "identity": self._identity(session_id),
            "prompt": query,
            "query": {"translated": [query], "original": query},
            "policy": {"limit": self._limit, "maxChars": self._max_chars, "maxClassification": 2},
            "fastPath": {"question": query, "answerLanguage": "en", "delivered": []},
        }
        result = bridge.abmind("private.lifecyclePrepareTurn", payload, timeout=_RECALL_TIMEOUT)
        if not isinstance(result, dict):
            raise _BridgeError("prepareTurn returned no result")
        context = str(result.get("context", "") or "")
        refs = [h for h in result.get("hits", []) or []
                if isinstance(h, dict) and isinstance(h.get("id"), int)]
        return context, len(refs)

    def _recall_via_cli(self, query: str) -> str:
        payload = json.dumps({"prompt": query})
        output = _run_abmind_cli(["hook-recall"], timeout=_RECALL_TIMEOUT, input_data=payload)
        return output or ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if is_trivial_prompt(query):
            with self._lock:
                self._last_count = None
            return ""
        # Consume turn-N speculation first; the host designed queue/consume so
        # the turn never blocks on a live call. Speculative context only —
        # never a transferred decision.
        with self._lock:
            pending = self._pending.pop(session_id, None)
        if pending is not None:
            _, text, count = pending
            with self._lock:
                self._last_count = count
            return text
        bridge = self._bridge
        if bridge is not None:
            try:
                text, count = self._recall_via_bridge(bridge, session_id, query)
                with self._lock:
                    self._last_count = count
                return text
            except _BridgeError as e:
                logger.debug("abmind prefetch via bridge failed: %s", e)
        if self._fallback_cli:
            text = self._recall_via_cli(query)
            with self._lock:
                self._last_count = 0 if text else None
            return text
        with self._lock:
            self._last_count = None
        return ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Live recall for the next turn; runs on the manager's worker, so it
        is inline here. Stored pending latest-for-session, query-tagged."""
        bridge = self._bridge
        if is_trivial_prompt(query) or bridge is None:
            return
        try:
            text, count = self._recall_via_bridge(bridge, session_id, query)
        except _BridgeError as e:
            logger.debug("abmind queue_prefetch failed: %s", e)
            return
        with self._lock:
            self._pending[session_id] = (query, text, count)

    def recall_status(self) -> Optional[RecallStatus]:
        with self._lock:
            count = self._last_count
        if count is None:
            return None
        return RecallStatus(provider_label="abmind", count=count)

    # -- capture -----------------------------------------------------------

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        """Bind the current turn (and author, when given) to the active
        session. Records are immutable; sync reconciles against them."""
        record = {
            "turn": int(turn_number),
            "author_id": kwargs.get("author_id"),
            "author_name": kwargs.get("author_name"),
            "author_is_bot": bool(kwargs.get("author_is_bot", False)),
        }
        with self._lock:
            if self._session_id:
                self._turn_records[(self._session_id, self._generations.get(self._session_id, 0))] = record

    def _turn_key(self, session_id: str, text: str) -> str:
        digest = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:12]
        return f"{session_id or 'default'}:{digest}"

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "",
                  messages: Optional[List[Dict[str, Any]]] = None,
                  turn_author: Optional[Dict[str, Any]] = None) -> None:
        """Persist a completed turn under its own execution/author binding.
        Inline: the manager already backgrounds this on its worker. An
        unresolvable binding withholds capture and reports instead of guessing.
        No attribution: Hermes offers no delivery acknowledgment."""
        bridge = self._bridge
        if not self._writes_allowed or bridge is None:
            return
        if not (user_content or "").strip() and not (assistant_content or "").strip():
            return
        sid = session_id or self._session_id or "default"
        record = self._current_record(sid)
        if record is None:
            logger.debug("abmind sync withheld: no turn record for session")
            return
        author = turn_author if isinstance(turn_author, dict) else None
        author_payload: Dict[str, str] = {}
        for src_key, dst_key in (("id", "id"), ("name", "name")):
            val = (author or {}).get(src_key) or record.get(f"author_{src_key}")
            if isinstance(val, str) and val:
                author_payload[dst_key] = val
        payload: Dict[str, Any] = {
            "identity": self._identity(sid, record["turn"]),
            "executionId": f"turn-{record['turn']}",
            "user": {"content": user_content},
            "assistant": {"content": assistant_content},
        }
        if author_payload:
            payload["author"] = author_payload
        try:
            result = bridge.abmind(
                "private.lifecycleCompleteTurn", payload,
                idempotency_key=self._turn_key(sid, f"turn-{record['turn']}:" + user_content + "\n" + assistant_content),
                timeout=_WRITE_TIMEOUT)
            if not isinstance(result, dict) or result.get("status") != "recorded":
                logger.debug("abmind completeTurn not recorded: %s", result)
        except _BridgeError as e:
            logger.debug("abmind sync_turn failed: %s", e)

    # -- explicit tools ------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [RECALL_SCHEMA, STORE_SCHEMA, SLEEP_SCHEMA, SLEEP_RUNTIME_SCHEMA,
                OPERATIONAL_RECALL_SCHEMA, OPERATIONAL_DRAFT_SCHEMA]

    def _session_kwarg(self, kwargs: Dict[str, Any]) -> str:
        return str(kwargs.get("session_id", "") or self._session_id or "")

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        bridge = self._bridge
        session_id = self._session_kwarg(kwargs)
        if tool_name == "abmind_recall":
            query = str(args.get("query", "") or "")
            if not query:
                return tool_error("query is required")
            if bridge is None:
                if self._fallback_cli:
                    text = self._recall_via_cli(query)
                    return json.dumps({"results": text} if text else {"results": [], "message": "No memories found."})
                return tool_error("abmind bridge is unavailable")
            try:
                limit = min(max(int(args.get("limit", self._limit)), 1), 50)
            except (ValueError, TypeError):
                return tool_error("bad recall limit")
            try:
                result = bridge.abmind("private.lifecycleRecall", {
                    "identity": self._identity(session_id),
                    "query": {"translated": [query], "original": query},
                    "limit": limit,
                    "maxClassification": 2,
                    "fastPath": {"question": query, "answerLanguage": "en", "delivered": []},
                }, timeout=_RECALL_TIMEOUT)
            except _BridgeError as e:
                return tool_error(f"abmind recall failed: {e}")
            if not isinstance(result, dict):
                return tool_error("abmind recall failed")
            context = str(result.get("context", "") or "")
            refs = [h for h in result.get("hits", []) or []
                    if isinstance(h, dict) and isinstance(h.get("id"), int)]
            if context:
                return json.dumps({"results": context, "ref_count": len(refs)})
            return json.dumps({"results": [], "message": "No memories found."})

        if tool_name == "abmind_store":
            content = str(args.get("content", "") or "")
            if not content:
                return tool_error("content is required")
            if not self._writes_allowed:
                return tool_error("abmind writes are disabled in this agent context")
            if bridge is None:
                return tool_error("abmind bridge is unavailable")
            mem_type = _STORE_TYPE_MAP.get(str(args.get("type", "fact")), "fact")
            try:
                result = bridge.abmind("private.lifecycleStore", {
                    "identity": self._identity(session_id),
                    "contentEn": content,
                    "contentOriginal": content,
                    "memoryType": mem_type,
                    "emotionScore": 0.0,
                    "confidence": 0.8,
                    "classification": 1,
                }, idempotency_key=self._turn_key(session_id, "store:" + content[:200]),
                    timeout=_WRITE_TIMEOUT)
            except _BridgeError as e:
                return tool_error(f"abmind store failed: {e}")
            if isinstance(result, dict) and result.get("stored"):
                return json.dumps({"ok": True, "memoryId": result.get("memoryId")})
            message = result.get("message", "not stored") if isinstance(result, dict) else "not stored"
            return tool_error(f"abmind store failed: {message}")

        if tool_name == "abmind_sleep":
            return self._tool_sleep(bridge, args)

        if tool_name == "abmind_sleep_runtime":
            return self._tool_sleep_runtime(bridge, args)

        if tool_name == "abmind_operational_recall":
            if bridge is None:
                return tool_error("abmind bridge is unavailable")
            query = str(args.get("query", "") or "")
            try:
                limit = min(max(int(args.get("limit", 5)), 1), 50)
            except (ValueError, TypeError):
                return tool_error("bad recall limit")
            try:
                result = bridge.abmind("operational.recall", {"query": query, "limit": limit},
                                       timeout=_RECALL_TIMEOUT)
            except _BridgeError as e:
                return tool_error(f"operational recall failed: {e}")
            return json.dumps(result if isinstance(result, dict) else {"error": "bad response"})

        if tool_name == "abmind_operational_draft":
            if bridge is None:
                return tool_error("abmind bridge is unavailable")
            lesson = str(args.get("lesson", "") or "")
            if not lesson:
                return tool_error("lesson is required")
            scope = str(args.get("scopeLevel", "host") or "host")
            if scope not in _VALID_SCOPES:
                return tool_error("bad scopeLevel")
            try:
                confidence = float(args.get("confidence", 0.5))
            except (ValueError, TypeError):
                return tool_error("bad confidence")
            payload: Dict[str, Any] = {
                "lesson": lesson,
                "scopeLevel": scope,
                "confidence": max(0.0, min(1.0, confidence)),
                "sourceExecutor": "hermes",
                "sourceSessionId": session_id or "unknown",
                "provenance": {"origin": "hermes-tool"},
            }
            for key in ("problem", "recommendation"):
                val = str(args.get(key, "") or "")
                if val:
                    payload[key] = val[:_EVIDENCE_TRUNCATE]
            try:
                result = bridge.abmind(
                    "operational.submitDraft", payload,
                    idempotency_key=self._turn_key(session_id, "draft-tool:" + lesson[:200]),
                    timeout=_WRITE_TIMEOUT)
            except _BridgeError as e:
                return tool_error(f"operational draft failed: {e}")
            return json.dumps(result if isinstance(result, dict) else {"error": "bad response"})

        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    def _tool_sleep(self, bridge: Optional[_Bridge], args: Dict[str, Any]) -> str:
        action = str(args.get("action", "") or "")
        if bridge is None:
            return tool_error("abmind bridge is unavailable")
        try:
            if action == "start":
                return json.dumps(bridge.abmind("sleep.start", {
                    "mode": "manual",
                    "level": str(args.get("level", "normal") or "normal"),
                }, idempotency_key=self._turn_key(self._session_id, "sleep-start:" + str(args.get("level", ""))),
                    timeout=_WRITE_TIMEOUT))
            if action == "status":
                return json.dumps(bridge.abmind("sleep.status", {}, timeout=_RECALL_TIMEOUT))
            if action == "events":
                try:
                    after = int(args.get("afterSeq", 0))
                    limit = min(max(int(args.get("limit", 20)), 1), 100)
                except (ValueError, TypeError):
                    return tool_error("bad events arguments")
                return json.dumps(bridge.abmind("sleep.events", {"afterSeq": after, "limit": limit},
                                                timeout=_RECALL_TIMEOUT))
            if action == "cancel":
                run_id = str(args.get("runId", "") or "")
                if not run_id:
                    return tool_error("runId is required")
                return json.dumps(bridge.abmind("sleep.cancel", {"runId": run_id}, timeout=_WRITE_TIMEOUT))
            if action == "resume":
                payload: Dict[str, Any] = {}
                if args.get("runId"):
                    payload["runId"] = str(args["runId"])
                if args.get("level"):
                    payload["level"] = str(args["level"])
                return json.dumps(bridge.abmind("sleep.resume", payload, timeout=_WRITE_TIMEOUT))
            return tool_error("bad sleep action")
        except _BridgeError as e:
            return tool_error(f"abmind sleep failed: {e}")

    def _tool_sleep_runtime(self, bridge: Optional[_Bridge], args: Dict[str, Any]) -> str:
        action = str(args.get("action", "") or "")
        if bridge is None:
            return tool_error("abmind bridge is unavailable")
        try:
            if action == "open":
                return json.dumps(bridge.abmind("sleep.runtime.open", {
                    "providerInstanceId": f"hermes-maintenance-{self._principal or 'default'}",
                }, timeout=_WRITE_TIMEOUT))
            lease = str(args.get("leaseId", "") or "")
            if action in ("next", "complete", "fail", "close") and not lease:
                return tool_error("leaseId is required")
            if action == "next":
                try:
                    wait = min(max(int(args.get("waitMs", 30000)), 1000), 120000)
                except (ValueError, TypeError):
                    return tool_error("bad waitMs")
                return json.dumps(bridge.abmind("sleep.runtime.next", {"leaseId": lease, "waitMs": wait},
                                                timeout=(wait / 1000) + 10))
            if action == "complete":
                comp = str(args.get("completionId", "") or "")
                text = str(args.get("text", "") or "")
                if not comp or not text:
                    return tool_error("completionId and text are required")
                return json.dumps(bridge.abmind("sleep.runtime.complete",
                                                {"leaseId": lease, "completionId": comp, "text": text},
                                                timeout=_WRITE_TIMEOUT))
            if action == "fail":
                comp = str(args.get("completionId", "") or "")
                code = str(args.get("code", "") or "")
                if not comp or not code:
                    return tool_error("completionId and code are required")
                return json.dumps(bridge.abmind("sleep.runtime.fail",
                                                {"leaseId": lease, "completionId": comp, "code": code},
                                                timeout=_WRITE_TIMEOUT))
            if action == "close":
                return json.dumps(bridge.abmind("sleep.runtime.close", {"leaseId": lease},
                                                timeout=_WRITE_TIMEOUT))
            return tool_error("bad sleep runtime action")
        except _BridgeError as e:
            return tool_error(f"abmind sleep runtime failed: {e}")

    # -- checkpoints, sessions, mirrors, delegation ----------------------------

    def _observe(self, kind: str, payload: Dict[str, Any], session_id: str) -> None:
        """Report evidence with provenance; receipts are volatile and
        diagnostic-only. Never raises; never retains text locally."""
        bridge = self._bridge
        if bridge is None:
            return
        try:
            receipt = bridge.abmind("private.lifecycleObserve", {
                "version": 1,
                "eventId": uuid.uuid4().hex[:16],
                "identity": self._identity(session_id),
                "occurredAt": time.time(),
                "kind": kind,
                "payload": payload,
            }, timeout=_WRITE_TIMEOUT)
            logger.debug("abmind observation %s: %s", kind, receipt)
        except _BridgeError as e:
            logger.debug("abmind observation %s failed: %s", kind, e)

    def on_pre_compress(self, messages: List[Dict[str, Any]], **kwargs) -> str:
        """Durably checkpoint uncommitted evidence. Strict mode (v2) raises so
        the host retains the transcript when durability is not acknowledged.
        Rows carry role/content only — never attributed to the current author."""
        require_checkpoint = bool(kwargs.get("require_checkpoint", False))
        bridge = self._bridge
        if bridge is None or not self._writes_allowed:
            if require_checkpoint:
                raise RuntimeError("abmind checkpoint unavailable: bridge is down")
            return ""
        evidence = []
        for msg in messages or []:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role in ("user", "assistant") and isinstance(content, str) and content.strip():
                evidence.append({"role": role, "content": content})
                if len(evidence) >= _CHECKPOINT_MAX_MESSAGES:
                    break
        if not evidence:
            return ""
        record = self._current_record(self._session_id)
        turn = record["turn"] if record else 0
        try:
            result = bridge.abmind("private.lifecycleCheckpoint", {
                "identity": self._identity(self._session_id, turn),
                "messages": evidence,
            }, idempotency_key=self._turn_key(
                self._session_id, f"precompress:t{turn}:{len(evidence)}:" +
                hashlib.sha256(json.dumps(evidence, sort_keys=True).encode()).hexdigest()[:12]),
                timeout=_WRITE_TIMEOUT)
        except _BridgeError as e:
            if require_checkpoint:
                raise RuntimeError(f"abmind checkpoint failed: {e}")
            logger.debug("abmind pre-compress checkpoint failed: %s", e)
            return ""
        if not isinstance(result, dict) or result.get("status") != "checkpointed":
            if require_checkpoint:
                raise RuntimeError(f"abmind checkpoint not acknowledged: {result}")
            logger.debug("abmind pre-compress checkpoint not acknowledged: %s", result)
        return ""

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        # Deliberate no-op: end-of-session extraction runs on the single sleep
        # scheduler (#1383), never per session end. See _ensure_sleep_scheduler.
        return None

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False,
                          rewound: bool = False, **kwargs) -> None:
        """Rebind to the new session with a fresh generation; fence prior
        state; report lineage (parent linkage travels here, never inside the
        execution identity). Previous-generation records expire lazily."""
        old_session = self._session_id
        old_gen = self._generation(old_session)
        with self._lock:
            self._pending.pop(old_session, None)
            if old_session:
                self._generations[old_session] = old_gen + 1
            self._generations[new_session_id] = self._generations.get(new_session_id, 0) + (1 if reset or old_session != new_session_id else 0)
            self._prune_records_locked()
        self._session_id = new_session_id
        if parent_session_id:
            self._parent_session = parent_session_id
        reason = "reset" if reset else ("rewind" if rewound else "switch")
        self._observe("session-lineage", {
            "reason": reason,
            "parent": parent_session_id,
            "extentUnknown": bool(rewound),
        }, new_session_id)

    def _prune_records_locked(self) -> None:
        """Keep at most the two newest generations per session."""
        by_session: Dict[str, List[int]] = {}
        for (sid, gen) in self._turn_records:
            by_session.setdefault(sid, []).append(gen)
        for sid, gens in by_session.items():
            for gen in sorted(gens)[:-2]:
                del self._turn_records[(sid, gen)]

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        """Mirror committed builtin writes. Plain additions are stored as
        deliberate memories; revisions carrying old_text and removals become
        diagnostic observations (evidence preserved, nothing auto-superseded
        or auto-deleted — #1820 owns learning policy)."""
        bridge = self._bridge
        if not content or not content.strip() or bridge is None or not self._writes_allowed:
            return
        meta = dict(metadata or {})
        old_text = str(meta.get("old_text", "") or "")
        session_id = str(meta.get("session_id", "") or self._session_id or "")
        if action == "remove" or (action in ("add", "replace") and old_text.strip()):
            self._observe("committed-revision", {
                "action": action,
                "target": target,
                "oldText": old_text[:_EVIDENCE_TRUNCATE],
                "newText": content[:_EVIDENCE_TRUNCATE] if action != "remove" else "",
                "origin": str(meta.get("write_origin", "") or meta.get("tool_name", "")),
            }, session_id)
            return
        if action not in ("add", "replace"):
            return
        try:
            bridge.abmind("private.lifecycleStore", {
                "identity": self._identity(session_id),
                "contentEn": content,
                "contentOriginal": content,
                "memoryType": "preference" if target == "user" else "fact",
                "emotionScore": 0.0,
                "confidence": 0.7,
                "classification": 1,
            }, idempotency_key=self._turn_key(session_id, f"mirror:{action}:{target}:" + content[:200]),
                timeout=_WRITE_TIMEOUT)
        except _BridgeError as e:
            logger.debug("abmind memory mirror failed: %s", e)

    def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
        """Parent-side delegation outcome → lineage observation. Observed but
        unsupported until a real #1373 consumer exists; success alone
        validates no lesson."""
        if not (task or "").strip() or self._bridge is None or not self._writes_allowed:
            return
        self._observe("delegation-outcome", {
            "task": (task or "")[:_EVIDENCE_TRUNCATE],
            "result": (result or "")[:_EVIDENCE_TRUNCATE],
            "child": child_session_id,
        }, self._session_id)

    def backup_paths(self) -> List[str]:
        # abmind state lives outside HERMES_HOME in the daemon-owned memory.db;
        # it must never be raw-copied. Back up separately via `abmind backup`.
        return []

    def shutdown(self) -> None:
        bridge, self._bridge = self._bridge, None
        if bridge is not None:
            abandoned = bridge.close()
            if abandoned:
                logger.warning("abmind shutdown abandoned %d in-flight call(s)", abandoned)

    # -- sleep scheduler ---------------------------------------------------------

    def _sleep_job_name(self) -> str:
        profile = os.path.basename(self._hermes_home.rstrip("/")) or "default"
        owner = self._principal or "default"
        return f"abmind-sleep-{profile}-{owner}"

    def _ensure_sleep_scheduler(self) -> None:
        """Idempotently register the single nightly maintenance agent job.
        Scans by scoped name (no local ID file to go stale); on a create race
        the extras are paused. Session-end triggering was removed: exactly one
        scheduler owns sleep (#1383)."""
        try:
            from cron.jobs import create_job, list_jobs, update_job
        except ImportError:
            logger.debug("abmind: no gateway cron available (scheduling unavailable)")
            return
        try:
            wanted = self._sleep_job_name()
            existing = [j for j in list_jobs() or []
                        if isinstance(j, dict) and str(j.get("name", "")).startswith("abmind-sleep-")]
            if any(j.get("name") == wanted and j.get("enabled", True) for j in existing):
                return
            record = create_job(
                _MAINTENANCE_PROMPT.format(job_name=wanted),
                _SLEEP_SCHEDULE,
                name=wanted,
            )
            logger.info("abmind registered sleep scheduler %s", (record or {}).get("id", "?"))
            for job in list_jobs() or []:
                if not isinstance(job, dict) or job.get("name") != wanted or not job.get("enabled", True):
                    continue
                if (record or {}).get("id") and job.get("id") == record.get("id"):
                    continue
                try:
                    update_job(job["id"], {"paused": True})
                    logger.warning("abmind paused duplicate sleep job %s", job.get("id"))
                except Exception as e:
                    logger.debug("abmind duplicate-job pause failed: %s", e)
        except Exception as e:
            logger.debug("abmind sleep scheduler registration failed: %s", e)


_MAINTENANCE_PROMPT = """You are the abmind sleep maintenance agent ({job_name}).

Perform one bounded maintenance pass over the abmind memory owned by this profile:

1. Open a runtime lease: abmind_sleep_runtime action=open.
2. Start a sleep run if none is active: abmind_sleep action=start level=normal.
3. Poll abmind_sleep_runtime action=next (waitMs 60000). For each completion request, answer concisely from the given prompt and submit via action=complete. Serve at most 12 completions or 25 minutes, whichever comes first.
4. On error, report via action=fail with a short code. When next reports no request, the run is terminal, or the budget is spent, close the lease via action=close and stop.

Rules: never call memory capture/store tools for maintenance content; never start a second run while one is active; always close the lease, even on failure. Report the final sleep status in one line.
"""


def register(ctx) -> None:
    """Register abmind as a memory provider plugin."""
    ctx.register_memory_provider(AbmindMemoryProvider())
    try:
        skill_path = Path(__file__).resolve().parent / "SKILL.md"
        if skill_path.exists():
            ctx.register_skill("abmind-memory", skill_path,
                               "Use abmind persistent memory tools explicitly.")
    except Exception as e:
        logger.debug("abmind skill registration failed: %s", e)
