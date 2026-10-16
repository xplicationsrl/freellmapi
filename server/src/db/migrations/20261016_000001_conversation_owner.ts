// Migration: per-user Playground conversations
// Created: 2026-10-16
//
// DOWN: reversible (drops the owner column; conversations become shared again)
//
// Several dashboard accounts can share one install (declarative `users`).
// They share keys, models and routing, but a Playground chat belongs to the
// account that started it: user_id scopes every /api/conversations query.
// Conversations from before this migration had no owner and go to the first
// account, the one that existed when they were written. Deleting an account
// deletes its conversations.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    ALTER TABLE playground_conversations
      ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

    UPDATE playground_conversations
       SET user_id = (SELECT MIN(id) FROM users)
     WHERE user_id IS NULL;

    -- The sidebar's query, now per user: most recently touched first.
    CREATE INDEX IF NOT EXISTS idx_playground_conversations_user_updated
      ON playground_conversations(user_id, updated_at_ms DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_playground_conversations_user_updated;
    ALTER TABLE playground_conversations DROP COLUMN user_id;
  `);
}
