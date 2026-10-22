import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  MAX_INSTRUCTIONS_LEN,
  MAX_PROJECT_MEMORY_LEN,
  listProjectMemories,
  upsertProjectMemory,
  type ProjectMemoryRow,
} from '../services/project-memory.js';

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

const knowledgeSchema = z.object({
  baseIds: z.array(z.number().int().positive()).max(10),
}).strict();

const instructionsSchema = z.object({
  instructions: z.string().max(MAX_INSTRUCTIONS_LEN),
}).strict();

const memoryCreateSchema = z.object({
  content: z.string().trim().min(1).max(MAX_PROJECT_MEMORY_LEN),
  pinned: z.boolean().optional(),
  source: z.enum(['manual', 'auto']).optional(),
  conversationId: z.number().int().positive().nullable().optional(),
}).strict();

const memoryUpdateSchema = z.object({
  content: z.string().trim().min(1).max(MAX_PROJECT_MEMORY_LEN).optional(),
  pinned: z.boolean().optional(),
}).strict().refine(v => v.content !== undefined || v.pinned !== undefined);

interface ProjectRow {
  id: number;
  name: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function ownerId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

function linkedBaseIds(projectId: number): number[] {
  const rows = getDb()
    .prepare('SELECT base_id FROM playground_project_knowledge WHERE project_id = ? ORDER BY base_id')
    .all(projectId) as { base_id: number }[];
  return rows.map(r => r.base_id);
}

function toJson(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    knowledgeBaseIds: linkedBaseIds(row.id),
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

// Replaces the set of knowledge bases every chat in this folder searches.
// Runs in the folder pick these up automatically (see routes/runs.ts).
projectsRouter.put('/:id/knowledge', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = knowledgeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid knowledge selection' } });
    return;
  }
  const userId = ownerId(req);
  if (!getProject(id, userId)) return notFound(res);

  const baseIds = [...new Set(parsed.data.baseIds)];
  const db = getDb();
  if (baseIds.length > 0) {
    const owned = db
      .prepare(`SELECT id FROM kb_bases WHERE user_id = ? AND id IN (${baseIds.map(() => '?').join(',')})`)
      .all(userId, ...baseIds) as { id: number }[];
    if (owned.length !== baseIds.length) {
      res.status(400).json({ error: { message: 'Unknown knowledge base' } });
      return;
    }
  }

  const now = Date.now();
  db.transaction(() => {
    db.prepare('DELETE FROM playground_project_knowledge WHERE project_id = ?').run(id);
    const insert = db.prepare(
      'INSERT INTO playground_project_knowledge (project_id, base_id, created_at_ms) VALUES (?, ?, ?)',
    );
    for (const baseId of baseIds) insert.run(id, baseId, now);
    db.prepare('UPDATE playground_projects SET updated_at_ms = ? WHERE id = ?').run(now, id);
  })();
  res.json(toJson(getProject(id, userId)!));
});

// ── Project memory: the brief and durable facts for this folder ──────────

function memoryJson(row: ProjectMemoryRow) {
  return {
    id: row.id,
    content: row.content,
    pinned: row.pinned === 1,
    source: row.source,
    conversationId: row.source_conversation_id,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function getInstructions(id: number): string {
  const row = getDb()
    .prepare('SELECT instructions FROM playground_projects WHERE id = ?')
    .get(id) as { instructions: string };
  return row.instructions;
}

function touchProject(id: number): void {
  getDb().prepare('UPDATE playground_projects SET updated_at_ms = ? WHERE id = ?').run(Date.now(), id);
}

projectsRouter.get('/:id/memory', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  if (!getProject(id, ownerId(req))) return notFound(res);
  res.json({
    instructions: getInstructions(id),
    memories: listProjectMemories(id).map(memoryJson),
  });
});

projectsRouter.put('/:id/instructions', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = instructionsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid instructions' } });
    return;
  }
  if (!getProject(id, ownerId(req))) return notFound(res);
  getDb().prepare('UPDATE playground_projects SET instructions = ?, updated_at_ms = ? WHERE id = ?')
    .run(parsed.data.instructions.trim(), Date.now(), id);
  res.json({ instructions: getInstructions(id) });
});

projectsRouter.post('/:id/memory', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = memoryCreateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid memory' } });
    return;
  }
  const userId = ownerId(req);
  if (!getProject(id, userId)) return notFound(res);

  // A source chat must be this account's own; otherwise drop the back-reference.
  let conversationId = parsed.data.conversationId ?? null;
  if (conversationId !== null) {
    const owned = getDb()
      .prepare('SELECT 1 AS ok FROM playground_conversations WHERE id = ? AND user_id = ?')
      .get(conversationId, userId);
    if (!owned) conversationId = null;
  }

  const result = upsertProjectMemory({
    projectId: id,
    content: parsed.data.content,
    source: parsed.data.source ?? 'manual',
    pinned: parsed.data.pinned,
    conversationId,
  });
  if (result === 'limit') {
    res.status(400).json({ error: { message: 'Project memory limit reached' } });
    return;
  }
  touchProject(id);
  const row = listProjectMemories(id).find(m => m.id === result.id)!;
  res.status(result.created ? 201 : 200).json(memoryJson(row));
});

projectsRouter.put('/:id/memory/:memoryId', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const memoryId = Number(req.params.memoryId);
  const parsed = memoryUpdateSchema.safeParse(req.body ?? {});
  if (!Number.isInteger(memoryId) || memoryId <= 0 || !parsed.success) {
    res.status(400).json({ error: { message: 'Invalid memory update' } });
    return;
  }
  if (!getProject(id, ownerId(req))) return notFound(res);
  const existing = listProjectMemories(id).find(m => m.id === memoryId);
  if (!existing) {
    res.status(404).json({ error: { message: 'Memory not found' } });
    return;
  }
  getDb().prepare(`
    UPDATE playground_project_memories
       SET content = ?, pinned = ?, updated_at_ms = ?
     WHERE id = ? AND project_id = ?
  `).run(
    parsed.data.content ?? existing.content,
    parsed.data.pinned === undefined ? existing.pinned : (parsed.data.pinned ? 1 : 0),
    Date.now(),
    memoryId,
    id,
  );
  touchProject(id);
  res.json(memoryJson(listProjectMemories(id).find(m => m.id === memoryId)!));
});

projectsRouter.delete('/:id/memory/:memoryId', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const memoryId = Number(req.params.memoryId);
  if (!Number.isInteger(memoryId) || memoryId <= 0) {
    res.status(400).json({ error: { message: 'Invalid memory id' } });
    return;
  }
  if (!getProject(id, ownerId(req))) return notFound(res);
  const info = getDb()
    .prepare('DELETE FROM playground_project_memories WHERE id = ? AND project_id = ?')
    .run(memoryId, id);
  if (info.changes === 0) {
    res.status(404).json({ error: { message: 'Memory not found' } });
    return;
  }
  res.json({ success: true });
});
