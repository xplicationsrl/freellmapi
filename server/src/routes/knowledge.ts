import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { isFeatureEnabled } from '../lib/features.js';
import { listEmbeddingModels, getDefaultFamily } from '../services/embeddings.js';
import { pagesFromText, type PageText } from '../services/knowledge/chunker.js';
import {
  enqueueDocument,
  reindexBase,
  retryDocument,
  type BaseRow,
  type DocumentRow,
} from '../services/knowledge/ingest.js';
import { KnowledgeError, searchKnowledge } from '../services/knowledge/retrieve.js';

// Knowledge bases for the Knowledge page, mounted under /api/knowledge behind
// the dashboard session gate. Per account; 404 while the feature flag is off.
// PDF and Word text is extracted in the browser (no document parser ships in
// the server) and arrives here as pages of plain text.

export const knowledgeRouter = Router();

knowledgeRouter.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isFeatureEnabled('knowledge')) {
    res.status(404).json({ error: { message: 'Knowledge is disabled' } });
    return;
  }
  next();
});

function userId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

function bad(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

function intParam(req: Request, res: Response, name: string): number | null {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) {
    bad(res, 400, `Invalid ${name}`);
    return null;
  }
  return n;
}

function getBase(id: number, uid: number): BaseRow | undefined {
  return getDb().prepare('SELECT * FROM kb_bases WHERE id = ? AND user_id = ?').get(id, uid) as BaseRow | undefined;
}

function getOwnedDocument(id: number, uid: number): DocumentRow | undefined {
  return getDb().prepare(`
    SELECT d.id, d.base_id, d.name, d.mime_type, d.content_hash, d.size_bytes, d.status, d.error,
           d.chunk_count, d.attempts, d.created_at_ms, d.updated_at_ms
      FROM kb_documents d JOIN kb_bases b ON b.id = d.base_id
     WHERE d.id = ? AND b.user_id = ?
  `).get(id, uid) as DocumentRow | undefined;
}

function baseJson(row: BaseRow, counts: { documents: number; ready: number; failed: number }) {
  return {
    id: row.id,
    name: row.name,
    embeddingFamily: row.embedding_family,
    dimensions: row.dimensions,
    documents: counts.documents,
    ready: counts.ready,
    failed: counts.failed,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function documentJson(d: DocumentRow) {
  return {
    id: d.id,
    baseId: d.base_id,
    name: d.name,
    mimeType: d.mime_type,
    sizeChars: d.size_bytes,
    status: d.status,
    error: d.error,
    chunks: d.chunk_count,
    updatedAt: d.updated_at_ms,
  };
}

knowledgeRouter.get('/embedding-families', (_req: Request, res: Response) => {
  const families = [...new Set(listEmbeddingModels().filter(m => m.enabled === 1).map(m => m.family))];
  res.json({ default: getDefaultFamily(), families });
});

knowledgeRouter.get('/bases', (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM kb_bases WHERE user_id = ? ORDER BY name').all(userId(req)) as BaseRow[];
  res.json(rows.map(b => {
    const c = db.prepare(`
      SELECT COUNT(*) AS documents,
             COALESCE(SUM(status = 'ready'), 0) AS ready,
             COALESCE(SUM(status = 'failed'), 0) AS failed
        FROM kb_documents WHERE base_id = ?
    `).get(b.id) as { documents: number; ready: number; failed: number };
    return baseJson(b, c);
  }));
});

const createBaseSchema = z.object({
  name: z.string().trim().min(1).max(80),
  embeddingFamily: z.string().trim().min(1).max(120).optional(),
}).strict();

function knownFamily(family: string): boolean {
  return listEmbeddingModels().some(m => m.family === family);
}

knowledgeRouter.post('/bases', (req: Request, res: Response) => {
  const parsed = createBaseSchema.safeParse(req.body);
  if (!parsed.success) { bad(res, 400, 'Invalid body'); return; }
  const { name, embeddingFamily } = parsed.data;
  if (embeddingFamily && !knownFamily(embeddingFamily)) { bad(res, 400, 'Unknown embedding family'); return; }
  const now = Date.now();
  try {
    const result = getDb().prepare(`
      INSERT INTO kb_bases (user_id, name, embedding_family, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId(req), name, embeddingFamily ?? null, now, now);
    const row = getBase(Number(result.lastInsertRowid), userId(req))!;
    res.status(201).json(baseJson(row, { documents: 0, ready: 0, failed: 0 }));
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      bad(res, 409, 'A knowledge base with that name already exists');
      return;
    }
    throw error;
  }
});

knowledgeRouter.delete('/bases/:id', (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  if (id === null) return;
  if (!getBase(id, userId(req))) { bad(res, 404, 'Knowledge base not found'); return; }
  getDb().prepare('DELETE FROM kb_bases WHERE id = ? AND user_id = ?').run(id, userId(req));
  res.status(204).end();
});

const reindexSchema = z.object({ embeddingFamily: z.string().trim().min(1).max(120).optional() }).strict();

knowledgeRouter.post('/bases/:id/reindex', (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  if (id === null) return;
  const base = getBase(id, userId(req));
  if (!base) { bad(res, 404, 'Knowledge base not found'); return; }
  const parsed = reindexSchema.safeParse(req.body ?? {});
  if (!parsed.success) { bad(res, 400, 'Invalid body'); return; }
  const family = parsed.data.embeddingFamily ?? base.embedding_family;
  if (family && !knownFamily(family)) { bad(res, 400, 'Unknown embedding family'); return; }
  reindexBase(id, family ?? null);
  res.status(202).json({ ok: true });
});

knowledgeRouter.get('/bases/:id/documents', (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  if (id === null) return;
  if (!getBase(id, userId(req))) { bad(res, 404, 'Knowledge base not found'); return; }
  const rows = getDb().prepare(`
    SELECT id, base_id, name, mime_type, content_hash, size_bytes, status, error, chunk_count, attempts,
           created_at_ms, updated_at_ms
      FROM kb_documents WHERE base_id = ? ORDER BY name
  `).all(id) as DocumentRow[];
  res.json(rows.map(documentJson));
});

const TEXT_TYPES = new Set([
  'text/plain', 'text/markdown', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const uploadSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().max(100).default('text/plain'),
  // Plain text (TXT/MD). Form feeds mark page breaks.
  text: z.string().max(2_000_000).optional(),
  // Pre-extracted pages (PDF, DOCX).
  pages: z.array(z.string().max(200_000)).max(2000).optional(),
}).strict().refine(d => (d.text !== undefined) !== (d.pages !== undefined), 'Send either text or pages');

knowledgeRouter.post('/bases/:id/documents', (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  if (id === null) return;
  if (!getBase(id, userId(req))) { bad(res, 404, 'Knowledge base not found'); return; }
  const parsed = uploadSchema.safeParse(req.body);
  if (!parsed.success) { bad(res, 400, parsed.error.issues.map(i => i.message).join('; ')); return; }
  const d = parsed.data;
  if (!TEXT_TYPES.has(d.mimeType)) { bad(res, 415, 'Unsupported document type'); return; }

  // NUL bytes break SQLite text handling and mean the input is not text.
  const clean = (s: string) => s.split(String.fromCharCode(0)).join('');
  const pages: PageText[] = d.pages
    ? d.pages.map((t, i) => ({ page: i + 1, text: clean(t) }))
    : pagesFromText(clean(d.text ?? ''));
  try {
    const result = enqueueDocument(id, { name: d.name, mimeType: d.mimeType, pages });
    const doc = getOwnedDocument(result.documentId, userId(req))!;
    res.status(result.kind === 'queued' ? 202 : 200).json({ ...documentJson(doc), unchanged: result.kind === 'unchanged' });
  } catch (error) {
    bad(res, 422, error instanceof Error ? error.message : 'Could not queue the document');
  }
});

knowledgeRouter.delete('/documents/:id', (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  if (id === null) return;
  if (!getOwnedDocument(id, userId(req))) { bad(res, 404, 'Document not found'); return; }
  // Chunks cascade, so the content stops being retrievable immediately.
  getDb().prepare('DELETE FROM kb_documents WHERE id = ?').run(id);
  res.status(204).end();
});

knowledgeRouter.post('/documents/:id/retry', (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  if (id === null) return;
  if (!getOwnedDocument(id, userId(req))) { bad(res, 404, 'Document not found'); return; }
  if (!retryDocument(id)) { bad(res, 409, 'Only failed documents can be retried'); return; }
  res.status(202).json({ ok: true });
});

// Source preview: the cited chunk with its neighbours, for the citation viewer.
knowledgeRouter.get('/documents/:id/chunks/:ordinal', (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  const ordinal = Number(req.params.ordinal);
  if (id === null) return;
  if (!Number.isInteger(ordinal) || ordinal < 0) { bad(res, 400, 'Invalid ordinal'); return; }
  const doc = getOwnedDocument(id, userId(req));
  if (!doc) { bad(res, 404, 'Document not found'); return; }
  const rows = getDb().prepare(`
    SELECT ordinal, text, page, heading FROM kb_chunks
     WHERE document_id = ? AND ordinal BETWEEN ? AND ? ORDER BY ordinal
  `).all(id, ordinal - 1, ordinal + 1) as { ordinal: number; text: string; page: number | null; heading: string | null }[];
  if (!rows.some(r => r.ordinal === ordinal)) { bad(res, 404, 'Passage not found'); return; }
  res.json({ document: documentJson(doc), focus: ordinal, chunks: rows });
});

const searchSchema = z.object({ query: z.string().trim().min(1).max(1000) }).strict();

// Try retrieval from the Knowledge page without going through a chat.
knowledgeRouter.post('/bases/:id/search', async (req: Request, res: Response) => {
  const id = intParam(req, res, 'id');
  if (id === null) return;
  if (!getBase(id, userId(req))) { bad(res, 404, 'Knowledge base not found'); return; }
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) { bad(res, 400, 'Invalid body'); return; }
  try {
    const out = await searchKnowledge({ userId: userId(req), baseIds: [id], query: parsed.data.query });
    res.json(out);
  } catch (error) {
    bad(res, error instanceof KnowledgeError ? 502 : 500, error instanceof Error ? error.message : 'Search failed');
  }
});
