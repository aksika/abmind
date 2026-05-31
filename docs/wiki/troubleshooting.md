# Troubleshooting

Common issues and their fixes. Run `abmind doctor --fix` first — it auto-corrects permissions and detects most problems.

## FTS5 corruption

**Symptom:** Recall returns no results, or errors like `fts5: database disk image is malformed`.

**Diagnosis:**
```bash
abmind doctor
# Look for: [ERR] extracted_memories_fts: corrupt
```

**Fix:** Rebuild the FTS index:
```bash
sqlite3 ~/.abmind/memory/memory.db "INSERT INTO extracted_memories_fts(extracted_memories_fts) VALUES('rebuild');"
```

If `messages_fts` is corrupt (shown as "dropped" — this is intentional since migration v10):
- Messages FTS was dropped in favor of LIKE queries. This is normal, not an error.

If `extracted_memories_original_fts` shows "dropped":
- This table may not exist on older installations. Not required for operation.

## Embedding failures

**Symptom:** Se stage returns 0 results, or `abmind embed` fails.

**Check Ollama is running:**
```bash
curl -s http://localhost:11434/api/tags | python3 -c "import json,sys; print(json.load(sys.stdin))"
```

**Check the model is available:**
```bash
curl -s http://localhost:11434/api/tags | python3 -c "
import json,sys
models = [m['name'] for m in json.load(sys.stdin).get('models',[])]
print('nomic-embed-text' in [m.split(':')[0] for m in models])
"
```

**Pull the model if missing:**
```bash
ollama pull nomic-embed-text
```

**Check embedding config:**
```bash
grep EMBEDDING ~/.abmind/config/.env.memory
# Should show: EMBEDDING_ENABLED=true
```

**Dimension mismatch:** If you changed models, existing embeddings have wrong dimensions. Re-embed:
```bash
abmind embed    # batch re-embeds all memories
```

## Sleep cycle failures

**Symptom:** `abmind sleep` exits with error or times out.

**Check timeout:**
```bash
# Default is 55 minutes. For testing, reduce:
SLEEP_TIMEOUT_MIN=5 abmind sleep --level budget --verbose
```

**LLM unavailable:**
- Sleep requires an LLM for extraction and summarization
- Check the configured model is accessible
- `--dry-run` flag skips LLM calls (useful for debugging state gathering)

**No messages since last sleep:**
- Sleep skips processing if no new messages exist
- Use `--force` to run housekeeping anyway

**Lock file stuck:**
```bash
ls ~/.abmind/memory/sleep/sleep_*.lock
# If a .lock file exists from a crashed run, remove it:
rm ~/.abmind/memory/sleep/sleep_*.lock
```

## Database locked

**Symptom:** `SQLITE_BUSY` or `database is locked` errors.

**Cause:** Multiple processes writing simultaneously. SQLite serializes writes — if one process holds a write lock too long, others time out.

**Fixes:**
1. Check for zombie processes:
   ```bash
   ps aux | grep abmind | grep -v grep
   ```
2. Kill stuck processes
3. Ensure WAL mode is enabled (should be automatic):
   ```bash
   sqlite3 ~/.abmind/memory/memory.db "PRAGMA journal_mode;"
   # Should return: wal
   ```
4. If not WAL:
   ```bash
   sqlite3 ~/.abmind/memory/memory.db "PRAGMA journal_mode=WAL;"
   ```

## Memory not found (recall returns empty)

**Symptom:** You stored a memory but recall doesn't find it.

**Check it exists:**
```bash
sqlite3 ~/.abmind/memory/memory.db "SELECT id, content_en FROM extracted_memories ORDER BY created_at DESC LIMIT 5;"
```

**Check classification access:**
- If the memory is class 2-3 and you're querying as a `guest` or `user`, it's filtered out
- Check `maxClassification` in your query

**Check expiry:**
```bash
sqlite3 ~/.abmind/memory/memory.db "SELECT id, valid_to FROM extracted_memories WHERE valid_to IS NOT NULL AND valid_to < datetime('now');"
```
- Expired memories are excluded by default. Use `--include-expired` to see them.

**Check FTS index is populated:**
```bash
sqlite3 ~/.abmind/memory/memory.db "SELECT count(*) FROM extracted_memories_fts;"
```
- If 0 but `extracted_memories` has rows, rebuild FTS (see above).

## Permissions errors

**Symptom:** `EACCES` or permission denied on `~/.abmind/` files.

**Fix:**
```bash
abmind doctor --fix
```

Expected permissions:
- Directories: `700` (owner only)
- Files: `600` (owner only)
- `abmind.key`: `600` (critical — won't decrypt if world-readable)

Manual fix:
```bash
chmod 700 ~/.abmind ~/.abmind/config ~/.abmind/memory ~/.abmind/secret
chmod 600 ~/.abmind/config/* ~/.abmind/secret/*
```

## Hook issues (Kiro CLI / Claude Code / Gemini)

**Symptom:** Hooks not firing, or "hook blocked" errors.

**Diagnose:**
```bash
abmind hook-doctor
```

**Common causes:**
- Hook not registered in host config (re-run `abmind install-host <host>`)
- Wrong `ABMIND_HOME` in hook environment
- Hook script not executable

**Re-install hooks:**
```bash
abmind install-host kiro --uninstall
abmind install-host kiro
```

## Disk space

**Check usage:**
```bash
abmind status
# Shows DB size, disk usage, budget
```

**If over budget:**
- Run a sleep cycle to consolidate and compress
- Prune old backups: `find ~/.abmind/backups/ -mtime +30 -delete`
- Check working dir for stale transcripts: `du -sh ~/.abmind/memory/working/`

## Doctor output reference

```bash
abmind doctor --fix
```

| Check | What it verifies |
|-------|-----------------|
| root ~/.abmind/ | Directory exists, mode 700 |
| config/ permissions | Mode 700 |
| config/* files | All files mode 600 |
| memory/ permissions | Mode 700 |
| memory.db exists | Database file present |
| core templates | ≥4 .md files in memory/core/ |
| ollama reachable | Can connect to embedding endpoint |
| FTS integrity | All FTS tables pass integrity-check |
| secret key | Key file exists, mode 600 |
