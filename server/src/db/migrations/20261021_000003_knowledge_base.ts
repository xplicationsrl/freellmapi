// Migration: knowledge bases (document Q&A with citations)
// Created: 2026-10-21
//
// DOWN: reversible
//
//  - kb_bases: a named collection owned by one account. embedding_family and
//    dimensions are pinned on first indexing: vectors from different models
//    live in incompatible spaces, so changing the model means a new base or a
//    full reindex, never a silent switch.
//  - kb_documents: one row per uploaded document. source_json holds the
//    extracted text (pages) so a queued or interrupted ingestion resumes after
//    a restart without the original upload. content_hash skips re-processing an
//    identical re-upload; status drives the Knowledge page.
//  - kb_chunks: retrievable passages with page and heading, plus the embedding
//    as a little-endian float32 BLOB. Deleting a document cascades its chunks,
//    so deleted or replaced content cannot be retrieved.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kb_bases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      embedding_family TEXT,
      dimensions INTEGER,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (user_id, name)
    );

    CREATE TABLE IF NOT EXISTS kb_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      base_id INTEGER NOT NULL REFERENCES kb_bases(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL DEFAULT 'text/plain',
      content_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
      error TEXT,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      source_json TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      UNIQUE (base_id, name)
    );

    CREATE INDEX IF NOT EXISTS idx_kb_documents_status
      ON kb_documents(status);

    CREATE TABLE IF NOT EXISTS kb_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
      base_id INTEGER NOT NULL REFERENCES kb_bases(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      text TEXT NOT NULL,
      page INTEGER,
      heading TEXT,
      embedding BLOB
    );

    CREATE INDEX IF NOT EXISTS idx_kb_chunks_base ON kb_chunks(base_id);
    CREATE INDEX IF NOT EXISTS idx_kb_chunks_document ON kb_chunks(document_id, ordinal);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_kb_chunks_document;
    DROP INDEX IF EXISTS idx_kb_chunks_base;
    DROP TABLE IF EXISTS kb_chunks;
    DROP INDEX IF EXISTS idx_kb_documents_status;
    DROP TABLE IF EXISTS kb_documents;
    DROP TABLE IF EXISTS kb_bases;
  `);
}
