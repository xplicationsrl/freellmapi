import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

// Playground cross-chat memories. Mounted under /api/memories behind the
// dashboard session gate. Facts are per account: each user sees and edits only
// their own. The Playground page injects them into requests and may POST new
// ones after an exchange; this router is storage, not extraction.

export const memoriesRouter = Router();

export const MAX_MEMORY_LEN = 500;
export const MAX_MEMORIES_PER_USER = 100;

const contentSchema = z.string().trim().min(1).max(MAX_MEMORY_LEN);

const createSchema = z.object({
  content: contentSchema,
}).strict();

const updateSchema = z.object({
  content: contentSchema,
}).strict();

interface MemoryRow {
  id: number;
  content: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function ownerId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

function toJson(row: MemoryRow) {
  return {
    id: row.id,
    content: row.content,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function getMemory(id: number, userId: number): MemoryRow | undefined {
  return getDb()
    .prepare('SELECT id, content, created_at_ms, updated_at_ms FROM playground_memories WHERE id = ? AND user_id = ?')
    .get(id, userId) as MemoryRow | undefined;
}

function countMemories(userId: number): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM playground_memories WHERE user_id = ?')
    .get(userId) as { n: number };
  return row.n;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid memory id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Memory not found' } });
}

memoriesRouter.get('/', (req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT id, content, created_at_ms, updated_at_ms
      FROM playground_memories
     WHERE user_id = ?
     ORDER BY updated_at_ms DESC, id DESC
  `).all(ownerId(req)) as MemoryRow[];
  res.json(rows.map(toJson));
});

memoriesRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid memory' } });
    return;
  }
  const userId = ownerId(req);
  if (countMemories(userId) >= MAX_MEMORIES_PER_USER) {
    res.status(400).json({
      error: { message: `Memory limit reached (${MAX_MEMORIES_PER_USER})` },
    });
    return;
  }

  // Same text twice is not two memories — update the existing row's timestamp
  // so it floats to the top of the list instead of duplicating.
  const existing = getDb().prepare(`
    SELECT id, content, created_at_ms, updated_at_ms
      FROM playground_memories
     WHERE user_id = ? AND lower(content) = lower(?)
     LIMIT 1
  `).get(userId, parsed.data.content) as MemoryRow | undefined;
  const now = Date.now();
  if (existing) {
    getDb().prepare(`
      UPDATE playground_memories
         SET content = ?, updated_at_ms = ?
       WHERE id = ? AND user_id = ?
    `).run(parsed.data.content, now, existing.id, userId);
    res.json(toJson(getMemory(existing.id, userId)!));
    return;
  }

  const info = getDb().prepare(`
    INSERT INTO playground_memories (user_id, content, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(userId, parsed.data.content, now, now);
  res.status(201).json(toJson(getMemory(Number(info.lastInsertRowid), userId)!));
});

memoriesRouter.put('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid memory update' } });
    return;
  }
  const userId = ownerId(req);
  const row = getMemory(id, userId);
  if (!row) return notFound(res);

  getDb().prepare(`
    UPDATE playground_memories
       SET content = ?, updated_at_ms = ?
     WHERE id = ? AND user_id = ?
  `).run(parsed.data.content, Date.now(), id, userId);
  res.json(toJson(getMemory(id, userId)!));
});

memoriesRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const userId = ownerId(req);
  const row = getMemory(id, userId);
  if (!row) return notFound(res);

  getDb().prepare('DELETE FROM playground_memories WHERE id = ? AND user_id = ?').run(id, userId);
  res.json({ success: true });
});
