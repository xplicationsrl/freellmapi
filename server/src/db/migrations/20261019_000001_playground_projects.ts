// Migration: Playground conversation projects
// Created: 2026-10-19
//
// DOWN: reversible
//
// Groups of Playground chats, per account. A conversation may sit in at most
// one project (`project_id`); NULL means it lives in the flat "Chats" list.
// Deleting a project unassigns its chats (ON DELETE SET NULL) rather than
// wiping them — folders are organisation, not ownership of the transcript.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_playground_projects_user_updated
      ON playground_projects(user_id, updated_at_ms DESC);
  `);

  const columns = db.prepare('PRAGMA table_info(playground_conversations)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'project_id')) {
    db.exec(`
      ALTER TABLE playground_conversations
        ADD COLUMN project_id INTEGER REFERENCES playground_projects(id) ON DELETE SET NULL;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_playground_conversations_project
      ON playground_conversations(project_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_playground_conversations_project;
    DROP INDEX IF EXISTS idx_playground_projects_user_updated;
  `);

  const columns = db.prepare('PRAGMA table_info(playground_conversations)').all() as { name: string }[];
  if (columns.some(c => c.name === 'project_id')) {
    db.exec(`ALTER TABLE playground_conversations DROP COLUMN project_id;`);
  }

  db.exec(`DROP TABLE IF EXISTS playground_projects;`);
}
