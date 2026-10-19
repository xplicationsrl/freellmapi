// Migration: searchable Playground chat turns (cross-chat recall)
// Created: 2026-10-19
//
// DOWN: reversible
//
// Conversations store the full transcript as one JSON blob. Recall needs to
// find relevant past messages without parsing every blob on every question, so
// we denormalise plain-text turns into a flat table keyed by owner + chat.
// The router keeps this table in sync on every conversation write; this
// migration backfills from existing rows once.

import type { Db } from '../types.js';

interface ConversationBackfillRow {
  id: number;
  user_id: number | null;
  messages_json: string;
  updated_at_ms: number;
}

function parseMessages(json: string): { role?: unknown; content?: unknown }[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id INTEGER NOT NULL REFERENCES playground_conversations(id) ON DELETE CASCADE,
      turn_index INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (conversation_id, turn_index)
    );

    CREATE INDEX IF NOT EXISTS idx_playground_chat_turns_user_updated
      ON playground_chat_turns(user_id, updated_at_ms DESC);

    CREATE INDEX IF NOT EXISTS idx_playground_chat_turns_conversation
      ON playground_chat_turns(conversation_id);
  `);

  // One-shot backfill: unpack stored transcripts into searchable turns.
  const rows = db.prepare(`
    SELECT id, user_id, messages_json, updated_at_ms
      FROM playground_conversations
     WHERE user_id IS NOT NULL
  `).all() as ConversationBackfillRow[];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO playground_chat_turns
      (user_id, conversation_id, turn_index, role, content, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    if (row.user_id == null) continue;
    const messages = parseMessages(row.messages_json);
    messages.forEach((msg, turnIndex) => {
      if (msg.role !== 'user' && msg.role !== 'assistant') return;
      if (typeof msg.content !== 'string') return;
      const content = msg.content.trim();
      if (!content) return;
      insert.run(row.user_id, row.id, turnIndex, msg.role, content, row.updated_at_ms);
    });
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_playground_chat_turns_conversation;
    DROP INDEX IF EXISTS idx_playground_chat_turns_user_updated;
    DROP TABLE IF EXISTS playground_chat_turns;
  `);
}
