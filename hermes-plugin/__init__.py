"""
abmind memory plugin for Hermes-Agent.

Implements MemoryProvider ABC via abmind CLI calls. Provides:
- Automatic recall on every turn (prefetch)
- Automatic turn recording (sync_turn)
- Pre-compress capture (saves context before Hermes discards it)
- Memory tools (abmind_recall, abmind_store)
- Sleep cron auto-registration (gateway mode)
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
import threading
import time
from typing import Any, Dict, List, Optional

from agent.memory_provider import MemoryProvider

logger = logging.getLogger(__name__)

_RECALL_TIMEOUT = 10
_STORE_TIMEOUT = 5
_SLEEP_COOLDOWN_HOURS = 24


def _run_abmind(args: List[str], timeout: int = 10, input_data: str = "") -> Optional[str]:
    """Run abmind CLI command, return stdout or None on failure."""
    try:
        env = dict(__import__("os").environ)
        env.setdefault("ABMIND_USER_ID", env.get("TELEGRAM_HOME_CHANNEL", ""))
        result = subprocess.run(
            ["abmind"] + args,
            capture_output=True,
            text=True,
            timeout=timeout,
            input=input_data or None,
            env=env,
        )
        if result.returncode != 0:
            logger.debug("abmind %s failed: %s", " ".join(args), result.stderr.strip())
            return None
        return result.stdout.strip()
    except FileNotFoundError:
        logger.warning("abmind not found on PATH")
        return None
    except subprocess.TimeoutExpired:
        logger.warning("abmind %s timed out (%ds)", " ".join(args), timeout)
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


class AbmindMemoryProvider(MemoryProvider):
    """abmind as a Hermes memory provider — persistent cross-session memory."""

    def __init__(self):
        self._wakeup_context: str = ""
        self._prefetch_cache: str = ""
        self._initialized: bool = False
        self._last_sleep_ts: float = 0

    @property
    def name(self) -> str:
        return "abmind"

    def is_available(self) -> bool:
        return shutil.which("abmind") is not None

    def initialize(self, session_id: str, **kwargs) -> None:
        output = _run_abmind(["hook-wakeup"], timeout=_RECALL_TIMEOUT)
        self._wakeup_context = output or ""
        self._initialized = True
        self._try_register_sleep_cron()
        logger.info("abmind initialized (wake-up: %d chars)", len(self._wakeup_context))

    def system_prompt_block(self) -> str:
        return self._wakeup_context

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        if self._prefetch_cache:
            cached = self._prefetch_cache
            self._prefetch_cache = ""
            return cached
        if not query:
            logger.debug("abmind prefetch: empty query, skipping")
            return ""
        payload = json.dumps({"prompt": query})
        output = _run_abmind(["hook-recall"], timeout=_RECALL_TIMEOUT, input_data=payload)
        logger.info("abmind prefetch: query=%r result=%d chars", query[:50], len(output or ""))
        return output or ""

    def queue_prefetch(self, query: str, *, session_id: str = "") -> None:
        """Background pre-fetch for next turn."""
        def _bg():
            try:
                payload = json.dumps({"prompt": query})
                result = _run_abmind(["hook-recall"], timeout=_RECALL_TIMEOUT, input_data=payload)
                if result:
                    self._prefetch_cache = result
            except Exception as e:
                logger.debug("abmind queue_prefetch error: %s", e)
        threading.Thread(target=_bg, daemon=True).start()

    def sync_turn(self, user_content: str, assistant_content: str, *, session_id: str = "") -> None:
        """Record turn in background thread."""
        payload = json.dumps({"user": user_content, "assistant": assistant_content})

        def _bg():
            try:
                _run_abmind(["hook-store"], timeout=_STORE_TIMEOUT, input_data=payload)
            except Exception as e:
                logger.debug("abmind sync_turn error: %s", e)
        threading.Thread(target=_bg, daemon=True).start()

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return [RECALL_SCHEMA, STORE_SCHEMA]

    def handle_tool_call(self, tool_name: str, args: Dict[str, Any], **kwargs) -> str:
        if tool_name == "abmind_recall":
            query = args.get("query", "")
            payload = json.dumps({"prompt": query})
            result = _run_abmind(["hook-recall"], timeout=_RECALL_TIMEOUT, input_data=payload)
            return result or json.dumps({"results": [], "message": "No memories found."})

        if tool_name == "abmind_store":
            content = args.get("content", "")
            mem_type = args.get("type", "fact")
            result = _run_abmind(["store", "--translated", content, "--memory-type", mem_type], timeout=_STORE_TIMEOUT)
            return result or json.dumps({"ok": True, "message": "Stored."})

        return json.dumps({"error": f"Unknown tool: {tool_name}"})

    def on_pre_compress(self, messages: List[Dict[str, Any]]) -> str:
        """Capture messages before Hermes discards them."""
        if not self._initialized:
            return ""
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                payload = json.dumps({role: content})
                threading.Thread(
                    target=lambda p=payload: _run_abmind(["hook-store"], timeout=_STORE_TIMEOUT, input_data=p),
                    daemon=True,
                ).start()
        return ""

    def on_session_end(self, messages: List[Dict[str, Any]]) -> None:
        """Trigger budget sleep if stale."""
        if not self._initialized:
            return
        now = time.time()
        if now - self._last_sleep_ts < _SLEEP_COOLDOWN_HOURS * 3600:
            return
        self._last_sleep_ts = now

        def _bg():
            try:
                _run_abmind(["sleep", "--level", "budget"], timeout=120)
            except Exception as e:
                logger.debug("abmind on_session_end sleep error: %s", e)
        threading.Thread(target=_bg, daemon=True).start()

    def on_memory_write(self, action: str, target: str, content: str, metadata: Optional[Dict[str, Any]] = None) -> None:
        """Mirror Hermes built-in memory writes into abmind."""
        if action == "remove" or not content:
            return

        def _bg():
            try:
                _run_abmind(["store", "--translated", content, "--memory-type", "fact"], timeout=_STORE_TIMEOUT)
            except Exception as e:
                logger.debug("abmind on_memory_write error: %s", e)
        threading.Thread(target=_bg, daemon=True).start()

    def on_session_switch(self, new_session_id: str, *, parent_session_id: str = "", reset: bool = False, **kwargs) -> None:
        """Clear prefetch cache on session switch."""
        self._prefetch_cache = ""

    def shutdown(self) -> None:
        pass

    def _try_register_sleep_cron(self) -> None:
        """Auto-register nightly sleep cron in Hermes gateway (if available)."""
        try:
            from cron.jobs import create_job, get_job
            if not get_job("abmind-sleep"):
                create_job({
                    "id": "abmind-sleep",
                    "schedule": "0 3 * * *",
                    "command": "abmind sleep --level normal",
                    "title": "abmind memory maintenance",
                })
                logger.info("Registered abmind-sleep cron job (03:00 daily)")
        except ImportError:
            pass  # No gateway cron available (CLI-only mode)
        except Exception as e:
            logger.debug("Failed to register sleep cron: %s", e)


def register(ctx) -> None:
    """Register abmind as a memory provider plugin."""
    ctx.register_memory_provider(AbmindMemoryProvider())
