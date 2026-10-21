// Migration: server-side conversation runs and tool-call records
// Created: 2026-10-21
//
// DOWN: reversible
//
// Foundation for MCP tools, the code sandbox, the knowledge base and voice.
// The Playground transcript stays an opaque blob in playground_conversations;
// these tables hold what a blob cannot: a run's status, the tool calls made
// during it, and the files it produced.
//
//  - chat_runs: one row per assistant run (one user turn answered, tools and
//    continuation rounds included). status is the lifecycle the orchestrator
//    drives; a run left 'running' across a restart is marked 'failed' on boot.
//  - chat_tool_calls: one row per tool call, keyed by the call id the model
//    saw. Stored independently of provider retries, so a retry after a
//    completed call reuses the recorded result instead of repeating the action.
//    outcome 'uncertain' marks a call whose result was lost after it may have
//    taken effect: it is never retried automatically.
//  - chat_artifacts: files a run produced (sandbox output, charts). The bytes
//    live on disk under the data directory; the row keeps the path and hash.
//
// All three cascade from the conversation, so deleting a chat removes them.
// Timestamps are epoch milliseconds, like playground_conversations.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_runs (
      id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL
        REFERENCES playground_conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      model TEXT,
      rounds INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      started_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_chat_runs_conversation
      ON chat_runs(conversation_id, started_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_runs_status
      ON chat_runs(status);

    CREATE TABLE IF NOT EXISTS chat_tool_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
      call_id TEXT NOT NULL,
      round INTEGER NOT NULL DEFAULT 0,
      tool_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'builtin',
      arguments_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'awaiting_approval', 'running',
                          'completed', 'failed', 'denied', 'cancelled')),
      outcome TEXT NOT NULL DEFAULT 'unknown'
        CHECK (outcome IN ('unknown', 'ok', 'error', 'uncertain')),
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      started_at_ms INTEGER,
      finished_at_ms INTEGER,
      UNIQUE (run_id, call_id)
    );

    CREATE INDEX IF NOT EXISTS idx_chat_tool_calls_run
      ON chat_tool_calls(run_id, round, id);

    CREATE TABLE IF NOT EXISTS chat_artifacts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
      tool_call_id INTEGER REFERENCES chat_tool_calls(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_chat_artifacts_run
      ON chat_artifacts(run_id);
    CREATE INDEX IF NOT EXISTS idx_chat_artifacts_expires
      ON chat_artifacts(expires_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_chat_artifacts_expires;
    DROP INDEX IF EXISTS idx_chat_artifacts_run;
    DROP TABLE IF EXISTS chat_artifacts;
    DROP INDEX IF EXISTS idx_chat_tool_calls_run;
    DROP TABLE IF EXISTS chat_tool_calls;
    DROP INDEX IF EXISTS idx_chat_runs_status;
    DROP INDEX IF EXISTS idx_chat_runs_conversation;
    DROP TABLE IF EXISTS chat_runs;
  `);
}
