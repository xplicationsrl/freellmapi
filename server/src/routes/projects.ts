import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';

// Playground project folders for the chat sidebar. Mounted under /api/projects
// behind the dashboard session gate. A project is just a named group — chats
// point at it via playground_conversations.project_id; deleting the folder
// unassigns them rather than deleting the transcripts.

export const projectsRouter = Router();

const MAX_NAME_LEN = 100;

const createSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
}).strict();

const updateSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LEN),
}).strict();

interface ProjectRow {
  id: number;
  name: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function ownerId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

function toJson(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function getProject(id: number, userId: number): ProjectRow | undefined {
  return getDb()
    .prepare('SELECT id, name, created_at_ms, updated_at_ms FROM playground_projects WHERE id = ? AND user_id = ?')
    .get(id, userId) as ProjectRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid project id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Project not found' } });
}

projectsRouter.get('/', (req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT id, name, created_at_ms, updated_at_ms
      FROM playground_projects
     WHERE user_id = ?
     ORDER BY updated_at_ms DESC, id DESC
  `).all(ownerId(req)) as ProjectRow[];
  res.json(rows.map(toJson));
});

projectsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid project' } });
    return;
  }
  const userId = ownerId(req);
  const now = Date.now();
  const info = getDb().prepare(`
    INSERT INTO playground_projects (user_id, name, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(userId, parsed.data.name, now, now);
  res.status(201).json(toJson(getProject(Number(info.lastInsertRowid), userId)!));
});

projectsRouter.put('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid project update' } });
    return;
  }
  const userId = ownerId(req);
  const row = getProject(id, userId);
  if (!row) return notFound(res);

  getDb().prepare(`
    UPDATE playground_projects
       SET name = ?, updated_at_ms = ?
     WHERE id = ? AND user_id = ?
  `).run(parsed.data.name, Date.now(), id, userId);
  res.json(toJson(getProject(id, userId)!));
});

projectsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const userId = ownerId(req);
  const db = getDb();
  // Unassign first, then drop the folder. FK ON DELETE SET NULL would do the
  // same; clearing explicitly keeps chats visible if foreign keys were off.
  const info = db
    .prepare('DELETE FROM playground_projects WHERE id = ? AND user_id = ?')
    .run(id, userId);
  if (info.changes === 0) return notFound(res);
  db.prepare('UPDATE playground_conversations SET project_id = NULL WHERE project_id = ?')
    .run(id);
  res.json({ success: true });
});
