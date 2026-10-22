// Migration: project-scoped knowledge bases
// Created: 2026-10-22
//
// DOWN: reversible
//
// Links a Playground project folder to the knowledge bases that should back
// every chat inside it. A base can serve several projects and a project can use
// several bases. Deleting either side only drops the link: the documents and
// the chats are never touched.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playground_project_knowledge (
      project_id INTEGER NOT NULL REFERENCES playground_projects(id) ON DELETE CASCADE,
      base_id INTEGER NOT NULL REFERENCES kb_bases(id) ON DELETE CASCADE,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (project_id, base_id)
    );

    CREATE INDEX IF NOT EXISTS idx_project_knowledge_base
      ON playground_project_knowledge(base_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_project_knowledge_base;
    DROP TABLE IF EXISTS playground_project_knowledge;
  `);
}
