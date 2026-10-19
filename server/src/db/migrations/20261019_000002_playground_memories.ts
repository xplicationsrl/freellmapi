// Migration: Playground cross-chat memories
// Created: 2026-10-19
//
// DOWN: reversible
//
// Durable facts the Playground remembers about a dashboard account across
// conversations — ChatGPT-style memory, scoped to the Playground UI only.
// Each row is a short free-text fact owned by one user; deleting the account
// cascades the memories away with it.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_playground_memories_user_updated
      ON playground_memories(user_id, updated_at_ms DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_playground_memories_user_updated;
    DROP TABLE IF EXISTS playground_memories;
  `);
}
