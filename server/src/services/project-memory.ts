import { getDb } from '../db/index.js';

// Project memory: the brief and the durable facts attached to one Playground
// project folder. Every chat in the folder gets them as a system message, so
// the model keeps context across chats without the user repeating it.

export const MAX_INSTRUCTIONS_LEN = 4000;
export const MAX_PROJECT_MEMORY_LEN = 500;
export const MAX_PROJECT_MEMORIES = 200;
/** Characters of facts injected per request; pinned first, then newest. */
export const MEMORY_CONTEXT_BUDGET = 4000;

export interface ProjectMemoryRow {
  id: number;
  project_id: number;
  content: string;
  pinned: number;
  source: 'manual' | 'auto';
  source_conversation_id: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export function listProjectMemories(projectId: number): ProjectMemoryRow[] {
  return getDb().prepare(`
    SELECT id, project_id, content, pinned, source, source_conversation_id, created_at_ms, updated_at_ms
      FROM playground_project_memories
     WHERE project_id = ?
     ORDER BY pinned DESC, updated_at_ms DESC, id DESC
  `).all(projectId) as ProjectMemoryRow[];
}

/** Project folder a conversation sits in, when it belongs to this account. */
export function projectIdForConversation(conversationId: number, userId: number): number | null {
  const row = getDb()
    .prepare('SELECT project_id FROM playground_conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId) as { project_id: number | null } | undefined;
  return row?.project_id ?? null;
}

/**
 * System message for a project's chats, or null when the folder has neither a
 * brief nor any facts. The brief is the user's own instruction; facts are
 * notes (some learned automatically), so they are framed as context, not orders.
 */
export function buildProjectContext(projectId: number, userId: number): string | null {
  const db = getDb();
  const project = db
    .prepare('SELECT name, instructions FROM playground_projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId) as { name: string; instructions: string } | undefined;
  if (!project) return null;

  const instructions = project.instructions.trim();
  const facts: string[] = [];
  let used = 0;
  for (const row of listProjectMemories(projectId)) {
    const line = row.content.trim();
    if (!line || used + line.length > MEMORY_CONTEXT_BUDGET) continue;
    facts.push(line);
    used += line.length;
  }
  if (!instructions && facts.length === 0) return null;

  const parts = [
    `This chat belongs to the project "${project.name}". Use the project context below to stay consistent with earlier work in this project.`,
  ];
  if (instructions) {
    parts.push('', 'Project instructions (from the user, follow them):', instructions);
  }
  if (facts.length > 0) {
    parts.push(
      '',
      'Project memory (notes saved from earlier work in this project; use when relevant, do not recite unprompted, and trust the user\'s current message over a note if they conflict):',
      ...facts.map(f => `- ${f}`),
    );
  }
  return parts.join('\n');
}

/** Insert a fact unless the same text is already stored; returns the row id. */
export function upsertProjectMemory(opts: {
  projectId: number;
  content: string;
  source: 'manual' | 'auto';
  pinned?: boolean;
  conversationId?: number | null;
}): { id: number; created: boolean } | 'limit' {
  const db = getDb();
  const now = Date.now();
  const existing = db.prepare(
    'SELECT id FROM playground_project_memories WHERE project_id = ? AND lower(content) = lower(?) LIMIT 1',
  ).get(opts.projectId, opts.content) as { id: number } | undefined;
  if (existing) {
    db.prepare('UPDATE playground_project_memories SET content = ?, updated_at_ms = ? WHERE id = ?')
      .run(opts.content, now, existing.id);
    return { id: existing.id, created: false };
  }
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM playground_project_memories WHERE project_id = ?')
    .get(opts.projectId) as { n: number };
  if (n >= MAX_PROJECT_MEMORIES) return 'limit';
  const info = db.prepare(`
    INSERT INTO playground_project_memories
      (project_id, content, pinned, source, source_conversation_id, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(opts.projectId, opts.content, opts.pinned ? 1 : 0, opts.source, opts.conversationId ?? null, now, now);
  return { id: Number(info.lastInsertRowid), created: true };
}
