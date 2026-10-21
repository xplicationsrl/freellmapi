// Knowledge ingestion: persisted queue -> chunk -> embed -> store.
//
// A document is queued with its extracted pages (source_json) in the same
// statement that creates it, so work survives a restart: on start-up anything
// left 'processing' goes back to 'queued' and the queue drains again. Embedding
// goes through the fixed-family embeddings router; a base pins its family and
// dimensions on first indexing and refuses a different model afterwards.

import crypto from 'node:crypto';
import { getDb } from '../../db/index.js';
import { EmbeddingsError, getDefaultFamily, runEmbeddings } from '../embeddings.js';
import { chunkPages, type PageText } from './chunker.js';
import { packVector } from './vectors.js';

export const MAX_SOURCE_CHARS = 2_000_000;
const EMBED_BATCH = 24;
const MAX_ATTEMPTS = 3;

export interface BaseRow {
  id: number;
  user_id: number;
  name: string;
  embedding_family: string | null;
  dimensions: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface DocumentRow {
  id: number;
  base_id: number;
  name: string;
  mime_type: string;
  content_hash: string;
  size_bytes: number;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunk_count: number;
  attempts: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export function hashPages(pages: PageText[]): string {
  const h = crypto.createHash('sha256');
  for (const p of pages) h.update(`${p.page ?? ''}\u0000${p.text}\u0001`);
  return h.digest('hex');
}

export type EnqueueResult =
  | { kind: 'queued'; documentId: number }
  | { kind: 'unchanged'; documentId: number };

/**
 * Queue a document. Re-uploading identical content under the same name is a
 * no-op; different content under the same name replaces the old document, and
 * its chunks, in one transaction so stale text can never be retrieved.
 */
export function enqueueDocument(
  baseId: number,
  doc: { name: string; mimeType: string; pages: PageText[] },
): EnqueueResult {
  const db = getDb();
  const totalChars = doc.pages.reduce((n, p) => n + p.text.length, 0);
  if (totalChars === 0) throw new Error('The document has no readable text');
  if (totalChars > MAX_SOURCE_CHARS) throw new Error('The document is too large to index');

  const hash = hashPages(doc.pages);
  const now = Date.now();
  const tx = db.transaction((): EnqueueResult => {
    const existing = db.prepare('SELECT id, content_hash, status FROM kb_documents WHERE base_id = ? AND name = ?')
      .get(baseId, doc.name) as { id: number; content_hash: string; status: string } | undefined;
    if (existing && existing.content_hash === hash && existing.status !== 'failed') {
      return { kind: 'unchanged', documentId: existing.id };
    }
    if (existing) db.prepare('DELETE FROM kb_documents WHERE id = ?').run(existing.id);
    const res = db.prepare(`
      INSERT INTO kb_documents
        (base_id, name, mime_type, content_hash, size_bytes, status, source_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
    `).run(baseId, doc.name, doc.mimeType, hash, totalChars, JSON.stringify(doc.pages), now, now);
    return { kind: 'queued', documentId: Number(res.lastInsertRowid) };
  });
  const result = tx();
  if (result.kind === 'queued') void processQueue();
  return result;
}

let draining = false;

/** Drain the queue one document at a time. Single-flight; safe to call often. */
export async function processQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const db = getDb();
    for (;;) {
      const next = db.prepare(
        "SELECT id FROM kb_documents WHERE status = 'queued' ORDER BY id LIMIT 1",
      ).get() as { id: number } | undefined;
      if (!next) break;
      await ingestOne(next.id);
    }
  } finally {
    draining = false;
  }
}

function fail(documentId: number, message: string): void {
  getDb().prepare(
    "UPDATE kb_documents SET status = 'failed', error = ?, updated_at_ms = ? WHERE id = ?",
  ).run(message.slice(0, 500), Date.now(), documentId);
}

async function ingestOne(documentId: number): Promise<void> {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM kb_documents WHERE id = ?').get(documentId) as
    (DocumentRow & { source_json: string | null }) | undefined;
  if (!doc) return;
  db.prepare("UPDATE kb_documents SET status = 'processing', attempts = attempts + 1, updated_at_ms = ? WHERE id = ?")
    .run(Date.now(), documentId);

  try {
    const pages = JSON.parse(doc.source_json ?? '[]') as PageText[];
    const chunks = chunkPages(pages);
    if (chunks.length === 0) throw new Error('No text could be extracted');

    const base = db.prepare('SELECT * FROM kb_bases WHERE id = ?').get(doc.base_id) as BaseRow | undefined;
    if (!base) return; // base deleted while queued
    const family = base.embedding_family ?? getDefaultFamily();

    const vectors: number[][] = [];
    let dimensions = base.dimensions;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH).map(c => c.text);
      const out = await runEmbeddings(family, batch);
      if (out.family !== family) throw new Error(`Embedding family changed to ${out.family}`);
      if (dimensions !== null && out.dimensions !== dimensions) {
        throw new Error(
          `Embedding dimensions changed (${dimensions} -> ${out.dimensions}); reindex the base to switch models`,
        );
      }
      dimensions = out.dimensions;
      vectors.push(...out.vectors);
    }

    const tx = db.transaction(() => {
      // The document may have been replaced or deleted while embedding ran.
      const still = db.prepare("SELECT status FROM kb_documents WHERE id = ?").get(documentId) as
        { status: string } | undefined;
      if (!still || still.status !== 'processing') return;
      db.prepare('DELETE FROM kb_chunks WHERE document_id = ?').run(documentId);
      const insert = db.prepare(`
        INSERT INTO kb_chunks (document_id, base_id, ordinal, text, page, heading, embedding)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      chunks.forEach((c, i) => {
        insert.run(documentId, doc.base_id, c.ordinal, c.text, c.page, c.heading, packVector(vectors[i]));
      });
      db.prepare(
        'UPDATE kb_bases SET embedding_family = COALESCE(embedding_family, ?), dimensions = COALESCE(dimensions, ?), updated_at_ms = ? WHERE id = ?',
      ).run(family, dimensions, Date.now(), doc.base_id);
      db.prepare(
        "UPDATE kb_documents SET status = 'ready', error = NULL, chunk_count = ?, updated_at_ms = ? WHERE id = ?",
      ).run(chunks.length, Date.now(), documentId);
    });
    tx();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Indexing failed';
    const retryable = error instanceof EmbeddingsError && (error.status === 429 || error.status >= 500);
    const attempts = (doc.attempts ?? 0) + 1;
    if (retryable && attempts < MAX_ATTEMPTS) {
      db.prepare("UPDATE kb_documents SET status = 'queued', error = ?, updated_at_ms = ? WHERE id = ?")
        .run(message.slice(0, 500), Date.now(), documentId);
      await new Promise(r => setTimeout(r, 2000 * attempts));
    } else {
      fail(documentId, message);
    }
  }
}

/** Start-up: work interrupted by a restart goes back on the queue. */
export function resumeIngestion(): void {
  const db = getDb();
  db.prepare("UPDATE kb_documents SET status = 'queued' WHERE status = 'processing'").run();
  void processQueue();
}

/** Put a failed document back on the queue. */
export function retryDocument(documentId: number): boolean {
  const res = getDb().prepare(
    "UPDATE kb_documents SET status = 'queued', error = NULL, attempts = 0, updated_at_ms = ? WHERE id = ? AND status = 'failed'",
  ).run(Date.now(), documentId);
  if (res.changes > 0) void processQueue();
  return res.changes > 0;
}

/**
 * Switch a base to a different embedding family: drops every chunk, clears the
 * pinned model and requeues every document from its stored source text.
 */
export function reindexBase(baseId: number, family: string | null): void {
  const db = getDb();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM kb_chunks WHERE base_id = ?').run(baseId);
    db.prepare('UPDATE kb_bases SET embedding_family = ?, dimensions = NULL, updated_at_ms = ? WHERE id = ?')
      .run(family, Date.now(), baseId);
    db.prepare(
      "UPDATE kb_documents SET status = 'queued', error = NULL, attempts = 0, chunk_count = 0, updated_at_ms = ? WHERE base_id = ?",
    ).run(Date.now(), baseId);
  });
  tx();
  void processQueue();
}
