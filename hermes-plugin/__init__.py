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

When the bridge is unavailable but the ``abmind`` CLI is installed, prefetch
and explicit recall degrade to ``hook-recall`` text (judged, capped,
classification <= 2, no decisions); writes are dropped with a truthful error.
Nothing is silently substituted.
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
_CLOSE_TIMEOUT = 5.0
_DEFAULT_LIMIT = 5
_DEFAULT_MAX_CHARS = 2000
_CHECKPOINT_MAX_MESSAGES = 50
_EVIDENCE_TRUNCATE = 2000
_SLEEP_JOB_NAME = "abmind-sleep-maintenance"
_SLEEP_SCHEDULE = "0 3 * * *"


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
        """Graceful close; returns the number of waiters abandoned (0 normally)."""
        self._closed = True
        abandoned = 0
        try:
            if self.alive():
                try:
                    self.call("bridge.close", {}, timeout=_CLOSE_TIMEOUT)
                except _BridgeError as e:
                    logger.debug("abmind bridge.close: %s", e)
        finally:
            if self._proc is not None:
                try:
                    self._proc.stdin.close()  # type: ignore[union-attr]
                except Exception:
                    pass
                try:
                    self._proc.wait(timeout=_CLOSE_TIMEOUT)
                except Exception:
                    self._proc.kill()
            with self._pending_lock:
                abandoned = len(self._pending)
        if self._reader is not None and self._reader.is_alive():
            self._reader.join(timeout=_CLOSE_TIMEOUT)
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
    """Bridge command, or None when no bridge binary resolves (CLI fallback)."""
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


def _run_abmind_cli(args: List[str], timeout: float = 10, input_data: str = "") -> Optional[str]:
    """Legacy per-call CLI fallback (judged text, capped, class <= 2)."""
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

_STORE_TYPE_MAP = {"fact": "fact", "preference": "preference", "entity": "fact"}


class AbmindMemoryProvider(MemoryProvider):
    """abmind as a Hermes memory provider — persistent cross-session memory."""

    pre_compress_checkpoint_api_version = PRE_COMPRESS_CHECKPOINT_API_VERSION

    def __init__(self):
        self._bridge: Optional[_Bridge] = None
        self._bridge_down = False
        self._lock = threading.Lock()
        self._principal = ""
        self._writes_allowed = True
        self._limit = _DEFAULT_LIMIT
        self._max_chars = _DEFAULT_MAX_CHARS
        self._turns: Dict[str, int] = {}
        self._pending: Dict[str, Tuple[str, str, List[Dict[str, int]]]] = {}
        self._delivered: Dict[Tuple[str, int], List[Dict[str, int]]] = {}
        self._last_count: Optional[int] = None
        self._initialized = False
        self._session_id = ""
        self._wakeup_context = ""
        self._parent_session = ""
        self._hermes_home = ""
        self._mode = "local"

    @property
    def name(self) -> str:
        return "abmind"

    def is_available(self) -> bool:
        cfg = _load_abmind_config()
        argv = _resolve_bridge_argv(cfg)
        if argv is not None and len(argv) > 1:
            return True
        return shutil.which("abmind") is not None

    def unavailable_reason(self) -> str:
        return "Install abmind and ensure abmind-client-bridge (or the abmind CLI as fallback) is on PATH."

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
        ]

    # -- identity ------------------------------------------------------

    def _identity(self, session_id: str) -> Dict[str, Any]:
        with self._lock:
            turn = self._turns.get(session_id, 0)
        ident: Dict[str, Any] = {
            "principalId": self._principal,
            "conversationId": session_id or self._session_id or "default",
            "executionId": f"turn-{turn}",
            "host": "hermes",
            "origin": "agent",
            "automaticWriteOwner": self._principal,
        }
        if self._parent_session:
            ident["parentExecutionId"] = self._parent_session
        return ident

    # -- lifecycle -----------------------------------------------------

    def initialize(self, session_id: str, **kwargs) -> None:
        cfg = _load_abmind_config()
        user_id = str(kwargs.get("user_id") or kwargs.get("user_id_alt") or "default")
        self._principal = (
            os.environ.get("ABMIND_PRINCIPAL", "") or str(cfg.get("principal", "")) or user_id
        ).strip() or "default"
        # Non-primary contexts observe but never write.
        self._writes_allowed = str(kwargs.get("agent_context", "primary")) in ("primary", "")
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
        argv = _resolve_bridge_argv(cfg)
        if argv is not None and len(argv) > 1:
            bridge = _Bridge(argv)
            try:
                caps = bridge.start()
                methods = caps.get("methods", []) if isinstance(caps, dict) else []
                missing = [m for m in ("private.lifecyclePrepareTurn", "private.lifecycleCompleteTurn",
                                       "private.lifecycleCheckpoint") if m not in methods]
                if missing:
                    logger.warning("abmind bridge lacks %s; writes/checkpoints disabled", missing)
                    raise _BridgeError(f"missing methods: {missing}")
                self._bridge = bridge
                wake = bridge.abmind("private.lifecycleStartSession", {
                    "identity": self._identity(session_id), "maxChars": self._max_chars,
                }, timeout=_SETUP_TIMEOUT)
                self._wakeup_context = wake.get("context", "") if isinstance(wake, dict) else ""
            except _BridgeError as e:
                logger.warning("abmind bridge unavailable (%s); CLI fallback", e)
                try:
                    bridge.close()
                except Exception:
                    pass
                self._bridge = None
                self._bridge_down = True
        else:
            self._bridge_down = True
            output = _run_abmind_cli(["hook-wakeup"], timeout=_RECALL_TIMEOUT)
            self._wakeup_context = output or ""
        if self._bridge_down and self._bridge is None and shutil.which("abmind") is None:
            logger.warning("abmind: neither bridge nor CLI available; provider inert")
        self._initialized = True
        if self._writes_allowed:
            self._ensure_sleep_scheduler()
        logger.info("abmind initialized (bridge=%s, wake-up: %d chars)",
                    "up" if self._bridge is not None else "down", len(self._wakeup_context))

    def system_prompt_block(self) -> str:
        return self._wakeup_context

    def identity_signature(self) -> Dict[str, Any]:
        return {"abmind_principal": self._principal or "default"}

    # -- recall ----------------------------------------------------------

    def _delivered_refs(self, session_id: str) -> List[Dict[str, int]]:
        # Only the active session suppresses: a background session's turn
        # may be stale, and stale refs must over-inject, never suppress.
        if session_id != self._session_id:
            return []
        with self._lock:
            turn = self._turns.get(session_id, 0)
            return list(self._delivered.get((session_id, turn), []))

    def _record_refs(self, session_id: str, refs: List[Dict[str, int]]) -> None:
        if not refs:
            return
        with self._lock:
            turn = self._turns.get(session_id, 0)
            seen = {(r.get("id"), r.get("revision")) for r in self._delivered.get((session_id, turn), [])}
            bucket = self._delivered.setdefault((session_id, turn), [])
            for r in refs:
                if (r.get("id"), r.get("revision")) not in seen:
                    seen.add((r.get("id"), r.get("revision")))
                    bucket.append({"id": int(r["id"]), "revision": int(r.get("revision", 0))})

    def _recall_via_bridge(self, bridge: _Bridge, session_id: str, query: str) -> Tuple[str, List[Dict[str, int]]]:
        """Structured prepareTurn; returns (context text, delivered refs)."""
        delivered = self._delivered_refs(session_id)
        payload: Dict[str, Any] = {
            "identity": self._identity(session_id),
            "prompt": query,
            "query": {"translated": [query], "original": query},
            "policy": {"limit": self._limit, "maxChars": self._max_chars, "maxClassification": 2},
        }
        if delivered:
            payload["fastPath"] = {"question": query, "answerLanguage": "en", "delivered": delivered}
        result = bridge.abmind("private.lifecyclePrepareTurn", payload, timeout=_RECALL_TIMEOUT)
        if not isinstance(result, dict):
            raise _BridgeError("prepareTurn returned no result")
        context = str(result.get("context", "") or "")
        refs: List[Dict[str, int]] = []
        for h in result.get("hits", []) or []:
            if isinstance(h, dict) and isinstance(h.get("id"), int):
                refs.append({"id": h["id"], "revision": int(h.get("revision", 0))})
        return context, refs

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
        # the turn never blocks on a live call.
        with self._lock:
            pending = self._pending.pop(session_id, None)
        if pending is not None:
            _, text, refs = pending
            self._record_refs(session_id, refs)
            with self._lock:
                self._last_count = len(refs)
            return text
        bridge = self._bridge
        if bridge is not None:
            try:
                text, refs = self._recall_via_bridge(bridge, session_id, query)
                self._record_refs(session_id, refs)
                with self._lock:
                    self._last_count = len(refs)
                return text
            except _BridgeError as e:
                logger.debug("abmind prefetch via bridge failed: %s", e)
        text = self._recall_via_cli(query)
        with self._lock:
            self._last_count = 0 if text else None
        return text

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Live recall for the next turn; runs on the manager's worker, so it
        is inline here. Stores pending keyed latest-for-session."""
        bridge = self._bridge
        if is_trivial_prompt(query) or bridge is None:
            return
        try:
            text, refs = self._recall_via_bridge(bridge, session_id, query)
        except _BridgeError as e:
            logger.debug("abmind queue_prefetch failed: %s", e)
            return
        with self._lock:
            self._pending[session_id] = (query, text, refs)

    def recall_status(self) -> Optional[RecallStatus]:
        with self._lock:
            count = self._last_count
        if count is None:
            return None
        return RecallStatus(provider_label="abmind", count=count)

    # -- capture -----------------------------------------------------------

    def on_turn_start(self, turn_number: int, message: str, **kwargs) -> None:
        sessions = [self._session_id] if self._session_id else []
        with self._lock:
            for s in sessions:
                self._turns[s] = int(turn_number)

    def _turn_key(self, session_id: str, text: str) -> str:
        with self._lock:
            turn = self._turns.get(session_id, 0)
        digest = hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:12]
        return f"{session_id or 'default'}:turn-{turn}:{digest}"

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "",
                  messages: Optional[List[Dict[str, Any]]] = None,
                  turn_author: Optional[Dict[str, Any]] = None) -> None:
        """Persist a completed turn, then post-response attribution (advisory).
        Inline: the manager already backgrounds this on its worker."""
        if not self._writes_allowed or self._bridge is None:
            return
        if not (user_content or "").strip() and not (assistant_content or "").strip():
            return
        try:
            result = self._bridge.abmind("private.lifecycleCompleteTurn", {
                "identity": self._identity(session_id),
                "user": {"content": user_content},
                "assistant": {"content": assistant_content},
            }, idempotency_key=self._turn_key(session_id, user_content + "\n" + assistant_content),
                timeout=_WRITE_TIMEOUT)
            if not isinstance(result, dict) or result.get("status") != "recorded":
                logger.debug("abmind completeTurn not recorded: %s", result)
                return
        except _BridgeError as e:
            logger.debug("abmind sync_turn failed: %s", e)
            return
        # Advisory attribution over actually supplied refs; failures stay unknown.
        refs = self._delivered_refs(session_id)
        ids = [r["id"] for r in refs if isinstance(r.get("id"), int)]
        if not ids or not (assistant_content or "").strip():
            return
        try:
            self._bridge.abmind("private.attribution", {
                "userId": self._principal,
                "response": assistant_content,
                "sourceIds": ids,
            }, timeout=_WRITE_TIMEOUT)
        except _BridgeError as e:
            logger.debug("abmind attribution unknown: %s", e)

    # -- explicit tools ------------------------------------------------------

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [RECALL_SCHEMA, STORE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        session_id = str(kwargs.get("session_id", "") or self._session_id or "")
        if tool_name == "abmind_recall":
            query = str(args.get("query", "") or "")
            if not query:
                return tool_error("query is required")
            if self._bridge is not None:
                try:
                    delivered = self._delivered_refs(session_id)
                    payload: Dict[str, Any] = {
                        "identity": self._identity(session_id),
                        "query": {"translated": [query], "original": query},
                        "limit": min(max(int(args.get("limit", self._limit)), 1), 50),
                        "maxClassification": 2,
                        "fastPath": {"question": query, "answerLanguage": "en", "delivered": delivered},
                    }
                    result = self._bridge.abmind("private.lifecycleRecall", payload, timeout=_RECALL_TIMEOUT)
                    if not isinstance(result, dict):
                        return tool_error("abmind recall failed")
                    refs = [{"id": h["id"], "revision": int(h.get("revision", 0))}
                            for h in result.get("hits", []) or []
                            if isinstance(h, dict) and isinstance(h.get("id"), int)]
                    self._record_refs(session_id, refs)
                    context = str(result.get("context", "") or "")
                    if context:
                        return json.dumps({"results": context, "ref_count": len(refs)})
                    return json.dumps({"results": [], "message": "No memories found."})
                except _BridgeError as e:
                    return tool_error(f"abmind recall failed: {e}")
                except (ValueError, TypeError) as e:
                    return tool_error(f"bad recall arguments: {e}")
            text = self._recall_via_cli(query)
            if text:
                return json.dumps({"results": text})
            return json.dumps({"results": [], "message": "No memories found."})

        if tool_name == "abmind_store":
            content = str(args.get("content", "") or "")
            if not content:
                return tool_error("content is required")
            if not self._writes_allowed:
                return tool_error("abmind writes are disabled in this agent context")
            if self._bridge is None:
                return tool_error("abmind bridge is unavailable")
            mem_type = _STORE_TYPE_MAP.get(str(args.get("type", "fact")), "fact")
            try:
                result = self._bridge.abmind("private.lifecycleStore", {
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

        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    # -- checkpoints, sessions, mirrors, delegation ----------------------------

    def on_pre_compress(self, messages: List[Dict[str, Any]], **kwargs) -> str:
        """Durably checkpoint uncommitted evidence. Strict mode (v2) raises so
        the host retains the transcript when durability is not acknowledged."""
        require_checkpoint = bool(kwargs.get("require_checkpoint", False))
        if self._bridge is None or not self._writes_allowed:
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
        try:
            result = self._bridge.abmind("private.lifecycleCheckpoint", {
                "identity": self._identity(self._session_id),
                "messages": evidence,
            }, idempotency_key=self._turn_key(self._session_id, "precompress:" + str(len(evidence))),
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
        """Rebind to the new session; fence all prior-session state so pending
        recall, delivered refs, and turn scopes never leak across sessions."""
        with self._lock:
            for sid in (self._session_id, new_session_id):
                self._pending.pop(sid, None)
                self._turns.pop(sid, None)
                for k in [k for k in self._delivered if k[0] == sid]:
                    del self._delivered[k]
        self._session_id = new_session_id
        if parent_session_id:
            self._parent_session = parent_session_id

    def on_memory_write(self, action: str, target: str, content: str,
                        metadata: Optional[Dict[str, Any]] = None) -> None:
        """Mirror committed builtin writes. Plain additions are stored as
        deliberate memories; revisions carrying old_text and removals become
        review drafts (evidence preserved, nothing auto-superseded or
        auto-deleted — #1820 owns learning policy)."""
        if not content or not content.strip() or self._bridge is None or not self._writes_allowed:
            return
        meta = dict(metadata or {})
        old_text = str(meta.get("old_text", "") or "")
        session_id = str(meta.get("session_id", "") or self._session_id or "")
        if action == "remove" or (action in ("add", "replace") and old_text.strip()):
            self._submit_revision_draft(action, target, content, old_text, meta, session_id)
            return
        if action not in ("add", "replace"):
            return
        try:
            self._bridge.abmind("private.lifecycleStore", {
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

    def _submit_revision_draft(self, action: str, target: str, content: str, old_text: str,
                               meta: Dict[str, Any], session_id: str) -> None:
        if self._bridge is None:
            return
        if action == "remove":
            lesson = f"Hermes memory removal notice ({target})"
            problem = content[:_EVIDENCE_TRUNCATE]
            recommendation = "Review whether the corresponding abmind memory should be revised or retired."
        else:
            lesson = f"Hermes memory revision proposal ({target})"
            problem = old_text[:_EVIDENCE_TRUNCATE]
            recommendation = content[:_EVIDENCE_TRUNCATE]
        try:
            self._bridge.abmind("operational.submitDraft", {
                "lesson": lesson,
                "problem": problem,
                "recommendation": recommendation,
                "evidence": [
                    {"source": "hermes-memory-write", "detail": content[:_EVIDENCE_TRUNCATE]},
                    {"source": "hermes-memory-write-old", "detail": old_text[:_EVIDENCE_TRUNCATE]},
                ],
                "scopeLevel": "host",
                "platform": "hermes",
                "confidence": 0.3,
                "sourceSessionId": session_id or "unknown",
                "sourceExecutor": "hermes",
                "provenance": {
                    "action": action,
                    "target": target,
                    "write_origin": str(meta.get("write_origin", "")),
                    "tool_name": str(meta.get("tool_name", "")),
                },
            }, idempotency_key=self._turn_key(
                session_id, f"draft:{action}:{target}:" + (old_text or content)[:200]),
                timeout=_WRITE_TIMEOUT)
        except _BridgeError as e:
            logger.debug("abmind revision draft failed: %s", e)

    def on_delegation(self, task: str, result: str, *, child_session_id: str = "", **kwargs) -> None:
        """Parent-side delegation outcome → lesson draft for #1373 review.
        Success alone validates nothing; the draft awaits Worker review."""
        if self._bridge is None or not self._writes_allowed or not (task or "").strip():
            return
        try:
            self._bridge.abmind("operational.submitDraft", {
                "lesson": f"Hermes delegation outcome: {(task or '')[:200]}",
                "problem": (task or "")[:_EVIDENCE_TRUNCATE],
                "recommendation": "Worker review: extract any durable lesson.",
                "evidence": [{"source": "hermes-delegation-result",
                              "detail": (result or "")[:_EVIDENCE_TRUNCATE]}],
                "scopeLevel": "host",
                "platform": "hermes",
                "confidence": 0.25,
                "sourceSessionId": child_session_id or self._session_id or "unknown",
                "sourceExecutor": "hermes",
                "provenance": {"child_session_id": child_session_id},
            }, idempotency_key=self._turn_key(
                self._session_id, f"delegation:{child_session_id}:" + (task or "")[:200]),
                timeout=_WRITE_TIMEOUT)
        except _BridgeError as e:
            logger.debug("abmind delegation draft failed: %s", e)

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

    def _ensure_sleep_scheduler(self) -> None:
        """Idempotently register the single nightly maintenance job using the
        real cron API. Session-end triggering was removed: exactly one
        scheduler owns sleep (#1383)."""
        try:
            from cron.jobs import create_job, list_jobs
        except ImportError:
            logger.debug("abmind: no gateway cron available (CLI-only mode)")
            return
        try:
            for job in list_jobs() or []:
                if isinstance(job, dict) and job.get("name") == _SLEEP_JOB_NAME and job.get("enabled", True):
                    return
            script = str(Path(__file__).resolve().parent / "abmind-maintenance.py")
            record = create_job(
                "Run abmind memory maintenance (sleep) through the abmind bridge. No chat context needed.",
                _SLEEP_SCHEDULE,
                name=_SLEEP_JOB_NAME,
                script=script,
                no_agent=True,
                workdir=str(Path(__file__).resolve().parent),
            )
            logger.info("abmind registered sleep scheduler %s", (record or {}).get("id", "?"))
        except Exception as e:
            logger.debug("abmind sleep scheduler registration failed: %s", e)


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
