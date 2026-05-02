# abmind — Selling Points

Features that differentiate abmind from other agent memory systems.

---

## Credential Vault (auto-redaction)

When your agent receives a secret (API key, token, password), abmind:
1. Encrypts it at rest (AES-256-GCM) as a SECRET memory
2. Immediately redacts the raw credential from conversation history
3. Only the owner can retrieve it (classification-gated recall)
4. File exports and backups never contain raw credentials

**Pitch:** "Your agent remembers your secrets without leaking them. Paste an API key in chat — abmind encrypts it, scrubs the conversation, and gives it back only to you. Backups stay clean."

**vs raw-transcript systems:** Most agent memory stores conversations verbatim. If you paste a credential, it sits in plaintext forever — in the DB, in backups, in exports. abmind treats credentials as first-class secrets: encrypted storage, instant source redaction, classification-based access control.

---

## Multi-resolution Memory (three-tier context)

Your agent doesn't dump everything into the prompt. abmind assembles context at three zoom levels:
- **Recent** — full verbatim conversation (last 20 turns)
- **Session** — compressed per-turn atoms (next 50 turns, ABM-L format)
- **Long-term** — thematic summaries + recalled memories from weeks/months ago

Result: 3× more context coverage in the same token budget. The agent remembers last week's decisions AND this morning's details.

---

## Sleep Maintenance (Dreamy)

Nightly background process that curates memory like human sleep:
- Extracts facts, decisions, preferences from the day's conversations
- Consolidates daily → weekly → quarterly summaries
- Detects contradictions ("you said X last week but Y today")
- Prunes stale memories (Memory Darwinism — unused memories fade)
- Runs on a schedule, no user intervention

---

## Multi-user Isolation

Each user's memories are scoped by userId. Classification-based access control:
- Class 0-1: shared (visible to all users)
- Class 2: confidential (visible only to the owner)
- Class 3: secret (encrypted, owner-only, auto-redacted from history)

No cross-user leakage. One agent, multiple users, proper boundaries.

---

## Drop-in OpenClaw Plugin

One command to replace lossless-claw:
```bash
openclaw plugins install --link /path/to/abmind
```

Registers: ContextEngine + memory capability + agent tools (`abmind_recall`, `abmind_store`) + lifecycle hooks. Existing sessions importable via `abmind migrate-openclaw`.

---

## Works Everywhere

Not locked to one CLI or framework:
- **OpenClaw** — full plugin
- **Kiro CLI / Claude Code / Gemini CLI** — agent-config + MCP server
- **Any Node.js agent** — in-process `MemoryManager` API
- **Any MCP client** — `abmind mcp` stdio server
- **Standalone CLI** — `abmind recall`, `abmind store`, `abmind sleep`
