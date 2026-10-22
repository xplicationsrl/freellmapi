// Migration: project memory
// Created: 2026-10-22
//
// DOWN: reversible
//
//  - playground_projects.instructions: the standing brief for a project folder
//    (goals, conventions, tone). Always injected into the folder's chats.
//  - playground_project_memories: short durable facts scoped to one project,
//    either written by the user (source 'manual') or learned from chats
//    (source 'auto'). Pinned facts are always injected first. Deleting the
//    project cascades its memories; deleting the originating chat only clears
//    the back-reference, since the fact outlives the transcript.

import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(playground_projects)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'instructions')) {
    db.exec(`ALTER TABLE playground_projects ADD COLUMN instructions TEXT NOT NULL DEFAULT '';`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_project_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES playground_projects(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
      source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'auto')),
      source_conversation_id INTEGER REFERENCES playground_conversations(id) ON DELETE SET NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_project_memories_project
      ON playground_project_memories(project_id, pinned DESC, updated_at_ms DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_project_memories_project;
    DROP TABLE IF EXISTS playground_project_memories;
  `);

  const columns = db.prepare('PRAGMA table_info(playground_projects)').all() as { name: string }[];
  if (columns.some(c => c.name === 'instructions')) {
    db.exec(`ALTER TABLE playground_projects DROP COLUMN instructions;`);
  }
}
