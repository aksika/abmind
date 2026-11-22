-- Frozen pre-#1957 schema: migration-chain position 14, as found on Molty and
-- KP. It intentionally lacks the recall projection surfaces. Do not update it
-- when new DDL is added behind an already-shipped migration step; the upgrade
-- parity test must fail so the missing migration entry is added instead.
-- Generated from the schema current at #1957; sqlite_sequence omitted.
CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT NOT NULL,
      role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL,
      platform_message_id TEXT, emotion_score INTEGER DEFAULT 0,
      type_hint TEXT, topic_hint TEXT, emotion_hint TEXT
    );
CREATE INDEX idx_messages_chat_ts ON messages(user_id, timestamp);
CREATE INDEX idx_messages_platform_id ON messages(user_id, platform_message_id);
CREATE TABLE extraction_watermarks (user_id TEXT PRIMARY KEY, last_processed_timestamp INTEGER NOT NULL);
CREATE TABLE context_watermarks (
      chat_id TEXT PRIMARY KEY,
      watermark_message_id INTEGER NOT NULL,
      compaction_count INTEGER DEFAULT 0,
      last_compacted_at INTEGER,
      last_failed_at INTEGER,
      pending_compaction INTEGER DEFAULT 0,
      model TEXT,
      token_estimate INTEGER
    );
CREATE TABLE context_summaries (
      id INTEGER PRIMARY KEY,
      chat_id TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      source_message_start INTEGER NOT NULL,
      source_message_end INTEGER NOT NULL,
      classification INTEGER NOT NULL DEFAULT 1,
      archived INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      created_at INTEGER NOT NULL
    );
CREATE INDEX idx_ctx_summaries_chat ON context_summaries(chat_id, archived, created_at);
CREATE TABLE context_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id TEXT NOT NULL,
      previous_checkpoint_id INTEGER,
      source_message_start INTEGER NOT NULL,
      source_message_end INTEGER NOT NULL,
      first_kept_message_id INTEGER NOT NULL,
      content TEXT NOT NULL,
      source_token_count INTEGER NOT NULL,
      checkpoint_token_count INTEGER NOT NULL,
      source_digest TEXT NOT NULL,
      checkpoint_digest TEXT NOT NULL,
      summarizer_model TEXT,
      summarizer_provider TEXT,
      active_request_model TEXT NOT NULL,
      reason TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      classification INTEGER NOT NULL,
      prompt_version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      serializer_version TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
CREATE INDEX idx_checkpoints_chat ON context_checkpoints(chat_id, created_at);
CREATE TABLE active_context_checkpoint (
      chat_id TEXT PRIMARY KEY,
      checkpoint_id INTEGER NOT NULL,
      generation INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
CREATE TABLE operational_lesson_drafts (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('draft', 'promoted', 'rejected')),
      lesson TEXT NOT NULL,
      problem TEXT,
      recommendation TEXT,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      suggested_scope_level TEXT NOT NULL CHECK (suggested_scope_level IN ('global','platform','host','workspace','repository','task_environment')),
      suggested_platform TEXT,
      suggested_host TEXT,
      suggested_workspace TEXT,
      suggested_repository TEXT,
      suggested_task_environment TEXT,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      source_task_id TEXT,
      source_session_id TEXT,
      source_executor TEXT,
      source_host TEXT,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      promoted_memory_id TEXT REFERENCES operational_memories(id),
      rejected_by TEXT,
      rejected_at INTEGER,
      rejection_reason TEXT,
      CHECK (
        (suggested_scope_level = 'global' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'platform' AND suggested_platform IS NOT NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'host' AND suggested_platform IS NULL AND suggested_host IS NOT NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'workspace' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NOT NULL AND suggested_repository IS NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'repository' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NOT NULL AND suggested_task_environment IS NULL) OR
        (suggested_scope_level = 'task_environment' AND suggested_platform IS NULL AND suggested_host IS NULL AND suggested_workspace IS NULL AND suggested_repository IS NULL AND suggested_task_environment IS NOT NULL)
      ),
      CHECK (
        (status = 'draft' AND promoted_memory_id IS NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL) OR
        (status = 'promoted' AND promoted_memory_id IS NOT NULL AND rejected_by IS NULL AND rejected_at IS NULL AND rejection_reason IS NULL) OR
        (status = 'rejected' AND promoted_memory_id IS NULL AND rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL)
      )
    );
CREATE INDEX idx_op_drafts_status ON operational_lesson_drafts(status, created_at);
CREATE TABLE operational_memories (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      scope_level TEXT NOT NULL CHECK (scope_level IN ('global','platform','host','workspace','repository','task_environment')),
      platform TEXT,
      host TEXT,
      workspace TEXT,
      repository TEXT,
      task_environment TEXT,
      content_hash TEXT NOT NULL,
      current_version_id TEXT NOT NULL UNIQUE,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK (
        (scope_level = 'global' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'platform' AND platform IS NOT NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'host' AND platform IS NULL AND host IS NOT NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'workspace' AND platform IS NULL AND host IS NULL AND workspace IS NOT NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'repository' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NOT NULL AND task_environment IS NULL) OR
        (scope_level = 'task_environment' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NOT NULL)
      ),
      FOREIGN KEY (id, current_version_id)
        REFERENCES operational_memory_versions(memory_id, id)
        DEFERRABLE INITIALLY DEFERRED
    );
CREATE INDEX idx_op_memories_active ON operational_memories(status, scope_level);
CREATE TABLE operational_memory_versions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL REFERENCES operational_memories(id),
      previous_version_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('active', 'retired')),
      scope_level TEXT NOT NULL CHECK (scope_level IN ('global','platform','host','workspace','repository','task_environment')),
      platform TEXT,
      host TEXT,
      workspace TEXT,
      repository TEXT,
      task_environment TEXT,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      confidence INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
      provenance_json TEXT NOT NULL DEFAULT '{}',
      evidence_json TEXT NOT NULL DEFAULT '[]',
      mutation_reason TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (memory_id, id),
      CHECK (
        (scope_level = 'global' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'platform' AND platform IS NOT NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'host' AND platform IS NULL AND host IS NOT NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'workspace' AND platform IS NULL AND host IS NULL AND workspace IS NOT NULL AND repository IS NULL AND task_environment IS NULL) OR
        (scope_level = 'repository' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NOT NULL AND task_environment IS NULL) OR
        (scope_level = 'task_environment' AND platform IS NULL AND host IS NULL AND workspace IS NULL AND repository IS NULL AND task_environment IS NOT NULL)
      ),
      FOREIGN KEY (memory_id, previous_version_id)
        REFERENCES operational_memory_versions(memory_id, id)
        DEFERRABLE INITIALLY DEFERRED
    );
CREATE INDEX idx_op_versions_lineage ON operational_memory_versions(memory_id, created_at);
CREATE TABLE dream_questions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      memory_a_id INTEGER NOT NULL,
      memory_b_id INTEGER NOT NULL,
      memory_a_revision INTEGER NOT NULL,
      memory_b_revision INTEGER NOT NULL,
      question TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('pending','asked','resolved','expired','dismissed')
      ),
      source_run_id TEXT NOT NULL,
      source_step TEXT NOT NULL CHECK (source_step = 'contradiction-and-graph'),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      asked_at INTEGER,
      resolved_at INTEGER,
      dismissed_at INTEGER,
      delivery_key TEXT,
      CHECK (memory_a_id < memory_b_id),
      CHECK (
        (status = 'pending' AND asked_at IS NULL AND resolved_at IS NULL
          AND dismissed_at IS NULL AND delivery_key IS NULL) OR
        (status = 'asked' AND asked_at IS NOT NULL AND resolved_at IS NULL
          AND dismissed_at IS NULL AND delivery_key IS NOT NULL) OR
        (status = 'resolved' AND resolved_at IS NOT NULL AND dismissed_at IS NULL) OR
        (status = 'expired' AND resolved_at IS NULL AND dismissed_at IS NULL) OR
        (status = 'dismissed' AND resolved_at IS NULL AND dismissed_at IS NOT NULL)
      )
    );
CREATE INDEX idx_dream_questions_user_status_created
      ON dream_questions(user_id, status, created_at, id);
CREATE INDEX idx_dream_questions_user_pair
      ON dream_questions(user_id, memory_a_id, memory_b_id, created_at);
CREATE UNIQUE INDEX uq_dream_questions_active_pair
      ON dream_questions(user_id, memory_a_id, memory_b_id)
      WHERE status IN ('pending','asked');
CREATE TABLE secret_key_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      active_generation INTEGER NOT NULL
    );
CREATE TABLE short_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    start_ts INTEGER NOT NULL,
    end_ts INTEGER NOT NULL,
    session_ids TEXT NOT NULL DEFAULT '[]',
    source_message_ids TEXT NOT NULL DEFAULT '[]',
    grouping_hash TEXT NOT NULL,
    outcomes TEXT,
    unresolved TEXT,
    evidence_excerpts TEXT NOT NULL DEFAULT '[]',
    prominence REAL NOT NULL DEFAULT 1.0,
    prev_episode_id INTEGER,
    next_episode_id INTEGER,
    classification INTEGER NOT NULL DEFAULT 1,
    encrypted INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, grouping_hash)
  );
CREATE INDEX idx_stm_owner_time ON short_term_memories(user_id, start_ts);
CREATE INDEX idx_stm_owner_topic ON short_term_memories(user_id, topic);
CREATE TABLE long_term_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    memory_type TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    content_original TEXT,
    authority TEXT NOT NULL DEFAULT 'inference' CHECK (authority IN ('user_statement','confirmed_decision','agent_proposal','inference')),
    applicability_scope TEXT NOT NULL DEFAULT '{"scope":"general"}',
    valid_from TEXT,
    valid_to TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    supersedes_id INTEGER,
    superseded_by_id INTEGER,
    provenance TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '[]',
    classification INTEGER NOT NULL DEFAULT 1,
    encrypted INTEGER NOT NULL DEFAULT 0,
    sealed_format_version INTEGER NOT NULL DEFAULT 0,
    embedding BLOB,
    signature BLOB,
    semantic_revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
CREATE INDEX idx_ltm_owner_type ON long_term_memories(user_id, memory_type);
CREATE INDEX idx_ltm_owner_current ON long_term_memories(user_id, superseded_by_id);
CREATE TABLE long_term_revisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id INTEGER NOT NULL REFERENCES long_term_memories(id),
    user_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    content_original TEXT,
    authority TEXT NOT NULL,
    applicability_scope TEXT NOT NULL,
    valid_from TEXT,
    valid_to TEXT,
    supersedes_id INTEGER,
    provenance TEXT NOT NULL DEFAULT '{}',
    evidence TEXT NOT NULL DEFAULT '[]',
    classification INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(memory_id, revision)
  );
CREATE TABLE personal_model_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    state TEXT NOT NULL CHECK (state IN ('legacy','converting','interrupted','failed','awaiting_decision','ready')),
    expected_version INTEGER NOT NULL DEFAULT 1,
    actual_version INTEGER NOT NULL DEFAULT 0,
    reason TEXT,
    progress TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );
CREATE TABLE forget_markers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    record_kind TEXT NOT NULL CHECK (record_kind IN ('episode','durable','raw','evidence')),
    record_id INTEGER NOT NULL,
    episode_id INTEGER,
    lineage TEXT NOT NULL DEFAULT '[]',
    digest TEXT NOT NULL,
    key_generation INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    UNIQUE(owner, record_kind, record_id)
  );
CREATE INDEX idx_forget_owner ON forget_markers(owner);
CREATE TABLE forget_key_ring (
    owner TEXT NOT NULL,
    generation INTEGER NOT NULL,
    wrapped_key BLOB NOT NULL,
    nonce BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (owner, generation)
  );
CREATE TABLE forget_operations (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','complete')),
    targets TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );
CREATE TABLE personal_grouping_ledger (
    user_id TEXT NOT NULL,
    grouping_hash TEXT NOT NULL,
    episode_id INTEGER NOT NULL REFERENCES short_term_memories(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, grouping_hash)
  );
CREATE TABLE _meta (key TEXT PRIMARY KEY, value);
CREATE TABLE abmind_service_requests (
        principal_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        method TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('reserved','dispatch_started','in_flight','completed','outcome_unknown')),
        response_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (principal_id, idempotency_key)
      );
CREATE INDEX idx_abmind_service_requests_retention
        ON abmind_service_requests(state, updated_at);
