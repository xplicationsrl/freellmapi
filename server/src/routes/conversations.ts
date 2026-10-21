import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  DEFAULT_RECALL_LIMIT,
  MAX_RECALL_CANDIDATES,
  rankRecallSnippets,
  turnsFromMessages,
  type RecallTurnInput,
} from '../lib/conversation-recall.js';

// Playground conversation storage, mounted under /api/conversations behind the
// dashboard session gate like every other admin route. The Playground page is
// the only client: it lists conversations in its sidebar (summaries, no
// bodies), loads one when you switch to it, and PUTs the whole transcript back
// after each completed exchange.
//
// The transcript is stored as the client's own ChatMessage[] — `meta` routing
// info and `reasoning` included — so a restored conversation renders exactly
// like the live one. Validation is therefore shape-checking, not
// normalisation: unknown keys are stripped, everything the page draws survives.
//
// Conversations are per account (user_id): accounts sharing an install share
// its keys, but each sees and touches only the chats it started. Another
// account's conversation id answers 404, exactly like one that does not exist.
//
// Cross-chat recall keeps a denormalised `playground_chat_turns` index in sync
// with every transcript write, so a new chat can pull relevant past turns.

export const conversationsRouter = Router();

const MAX_TITLE_LEN = 200;
// A conversation is prose plus, occasionally, inlined image data URIs. 2 MB of
// serialised JSON is far more than any readable chat and still small enough to
// hand back on every switch without thinking about it. Over that we refuse the
// write rather than silently truncating someone's history.
export const MAX_MESSAGES_BYTES = 2 * 1024 * 1024;

// Mirrors the client's ChatMessage. Kept permissive on `content` (an empty
// assistant bubble is legitimate mid-fusion) and strict on `role`, which is the
// one field the renderer branches on.
const metaSchema = z.object({
  platform: z.string().optional(),
  model: z.string().optional(),
  latency: z.number().optional(),
  fallbackAttempts: z.number().optional(),
  // Server-side run that produced this reply (tool calls, artifacts live there).
  runId: z.string().max(64).optional(),
  fusionPanel: z.array(z.object({
    platform: z.string(),
    model: z.string(),
    status: z.enum(['ok', 'failed']).optional(),
    content: z.string().optional(),
    error: z.string().optional(),
  })).optional(),
  fusionJudge: z.object({ platform: z.string(), model: z.string() }).nullable().optional(),
  // Playground "Search the web" (#1174): the engine that ran and the sources
  // shown under the answer, so a reloaded chat keeps its citations.
  webSearch: z.object({
    engine: z.string().max(200).optional(),
    latency: z.number().optional(),
    sources: z.array(z.object({ title: z.string().max(1000), url: z.string().max(4000) })).max(50).optional(),
  }).optional(),
});

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  images: z.array(z.string()).optional(),
  // Images the Playground generated for this reply (data URIs). Kept apart from
  // `images`, which are the user's attachments and are replayed to the model;
  // a generated image is shown, never sent back as chat input.
  generatedImages: z.array(z.string()).max(4).optional(),
  isError: z.boolean().optional(),
  reasoning: z.string().optional(),
  // Playground thumbs on a reply. Local to the conversation: nothing reads it
  // but the transcript it is shown in.
  feedback: z.enum(['up', 'down']).optional(),
  meta: metaSchema.optional(),
});
// `streaming: true` is deliberately absent above (and so stripped): a stored
// message is finished by definition, and persisting the flag would restore a
// transcript stuck mid-answer.

const messagesSchema = z.array(messageSchema);

// 'auto', 'fusion', or a canonical model id — whatever the picker held. Not
// enumerated: the catalog changes under us, and a conversation pinned to a
// model that has since gone away should still load.
const modelSchema = z.string().max(200).nullable();
const systemPromptSchema = z.string().max(32_000).nullable();

// Nullable project folder id. null clears membership; omitted on PUT keeps
// the stored value. The id must belong to the same account (checked below).
const projectIdSchema = z.number().int().positive().nullable();

const createSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).optional(),
  messages: messagesSchema.optional(),
  model: modelSchema.optional(),
  systemPrompt: systemPromptSchema.optional(),
  projectId: projectIdSchema.optional(),
}).strict();

// PUT is a full upsert of the mutable state: every field the page owns, written
// in one statement. Fields left out keep their stored value, so a rename does
// not have to re-send the transcript (and cannot race one away).
const updateSchema = z.object({
  title: z.string().max(MAX_TITLE_LEN).optional(),
  messages: messagesSchema.optional(),
  model: modelSchema.optional(),
  systemPrompt: systemPromptSchema.optional(),
  projectId: projectIdSchema.optional(),
}).strict();

const recallSchema = z.object({
  query: z.string().min(1).max(4000),
  excludeConversationId: z.number().int().positive().nullable().optional(),
  limit: z.number().int().min(1).max(12).optional(),
}).strict();

interface ConversationRow {
  id: number;
  title: string;
  messages_json: string;
  model: string | null;
  system_prompt: string | null;
  project_id: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface SummaryRow {
  id: number;
  title: string;
  model: string | null;
  project_id: number | null;
  message_count: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface TurnCandidateRow {
  conversation_id: number;
  title: string;
  role: 'user' | 'assistant';
  content: string;
  updated_at_ms: number;
  turn_index: number;
}

function toJson(row: ConversationRow) {
  return {
    id: row.id,
    title: row.title,
    // Stored JSON is only ever written from a validated array, so a parse
    // failure means the row was corrupted outside this router: hand back an
    // empty transcript rather than 500-ing the whole sidebar.
    messages: parseMessages(row.messages_json),
    model: row.model,
    systemPrompt: row.system_prompt,
    projectId: row.project_id ?? null,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function parseMessages(json: string): unknown[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The signed-in dashboard account; requireAuth guarantees it on this router. */
function ownerId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

function getConversation(id: number, userId: number): ConversationRow | undefined {
  return getDb()
    .prepare('SELECT * FROM playground_conversations WHERE id = ? AND user_id = ?')
    .get(id, userId) as ConversationRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid conversation id' } });
    return null;
  }
  return id;
}

function notFound(res: Response): void {
  res.status(404).json({ error: { message: 'Conversation not found' } });
}

/** True when the project exists and belongs to this account (or id is null). */
function ownedProjectId(projectId: number | null, userId: number): boolean {
  if (projectId === null) return true;
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM playground_projects WHERE id = ? AND user_id = ?')
    .get(projectId, userId) as { ok: number } | undefined;
  return !!row;
}

/**
 * Serialise a validated transcript, refusing anything past the storage cap.
 * Returns null after answering with a 413 so callers can `return` on it.
 */
function serialiseMessages(messages: unknown[], res: Response): string | null {
  const json = JSON.stringify(messages);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_MESSAGES_BYTES) {
    res.status(413).json({
      error: {
        message:
          `Conversation is too large to save (${Math.round(bytes / 1024)} KB; the limit is ` +
          `${Math.round(MAX_MESSAGES_BYTES / 1024)} KB). Start a new conversation to keep going.`,
        type: 'conversation_too_large',
      },
    });
    return null;
  }
  return json;
}

/**
 * Replace the searchable turn index for one conversation. Called after every
 * transcript write so recall never reads a stale blob.
 */
function syncConversationTurns(
  userId: number,
  conversationId: number,
  messagesJson: string,
  updatedAtMs: number,
): void {
  const db = getDb();
  const turns = turnsFromMessages(parseMessages(messagesJson) as { role?: unknown; content?: unknown }[]);
  const replace = db.transaction(() => {
    db.prepare('DELETE FROM playground_chat_turns WHERE conversation_id = ? AND user_id = ?')
      .run(conversationId, userId);
    const insert = db.prepare(`
      INSERT INTO playground_chat_turns
        (user_id, conversation_id, turn_index, role, content, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const turn of turns) {
      insert.run(userId, conversationId, turn.turnIndex, turn.role, turn.content, updatedAtMs);
    }
  });
  replace();
}

// Summaries for the sidebar: no message bodies cross the wire, so the list stays
// small no matter how long the conversations are. json_array_length reads the
// count straight out of the stored blob (SQLite's JSON1, present in both the
// better-sqlite3 and node:sqlite drivers) instead of parsing every transcript.
conversationsRouter.get('/', (req: Request, res: Response) => {
  const rows = getDb().prepare(`
    SELECT id,
           title,
           model,
           project_id,
           json_array_length(messages_json) AS message_count,
           created_at_ms,
           updated_at_ms
      FROM playground_conversations
     WHERE user_id = ?
     ORDER BY updated_at_ms DESC, id DESC
  `).all(ownerId(req)) as SummaryRow[];
  res.json(rows.map(row => ({
    id: row.id,
    title: row.title,
    model: row.model,
    projectId: row.project_id ?? null,
    messageCount: row.message_count ?? 0,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  })));
});

// Cross-chat recall: rank past turns for the current question. Registered
// before `/:id` so "recall" is never parsed as a conversation id.
conversationsRouter.post('/recall', (req: Request, res: Response) => {
  const parsed = recallSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid recall request' } });
    return;
  }

  const userId = ownerId(req);
  const excludeId = parsed.data.excludeConversationId ?? null;
  const limit = parsed.data.limit ?? DEFAULT_RECALL_LIMIT;

  const rows = getDb().prepare(`
    SELECT t.conversation_id,
           c.title,
           t.role,
           t.content,
           t.updated_at_ms,
           t.turn_index
      FROM playground_chat_turns t
      JOIN playground_conversations c
        ON c.id = t.conversation_id
       AND c.user_id = t.user_id
     WHERE t.user_id = ?
       AND (? IS NULL OR t.conversation_id != ?)
     ORDER BY t.updated_at_ms DESC, t.conversation_id DESC, t.turn_index DESC
     LIMIT ?
  `).all(userId, excludeId, excludeId, MAX_RECALL_CANDIDATES) as TurnCandidateRow[];

  const candidates: RecallTurnInput[] = rows.map(row => ({
    conversationId: row.conversation_id,
    title: row.title ?? '',
    role: row.role,
    content: row.content,
    updatedAtMs: row.updated_at_ms,
    turnIndex: row.turn_index,
  }));

  const snippets = rankRecallSnippets(parsed.data.query, candidates, { limit });
  res.json({
    snippets: snippets.map(s => ({
      conversationId: s.conversationId,
      title: s.title,
      role: s.role,
      content: s.content,
    })),
  });
});

conversationsRouter.get('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getConversation(id, ownerId(req));
  if (!row) return notFound(res);
  res.json(toJson(row));
});

conversationsRouter.post('/', (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid conversation' } });
    return;
  }
  const messagesJson = serialiseMessages(parsed.data.messages ?? [], res);
  if (messagesJson === null) return;

  const userId = ownerId(req);
  const projectId = parsed.data.projectId ?? null;
  if (!ownedProjectId(projectId, userId)) {
    res.status(400).json({ error: { message: 'Invalid project' } });
    return;
  }
  const now = Date.now();
  const info = getDb().prepare(`
    INSERT INTO playground_conversations
      (user_id, title, messages_json, model, system_prompt, project_id, created_at_ms, updated_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    parsed.data.title ?? '',
    messagesJson,
    parsed.data.model ?? null,
    parsed.data.systemPrompt ?? null,
    projectId,
    now,
    now,
  );
  const id = Number(info.lastInsertRowid);
  syncConversationTurns(userId, id, messagesJson, now);
  res.status(201).json(toJson(getConversation(id, userId)!));
});

conversationsRouter.put('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid conversation update' } });
    return;
  }
  const userId = ownerId(req);
  const row = getConversation(id, userId);
  if (!row) return notFound(res);

  const { title, messages, model, systemPrompt, projectId } = parsed.data;
  const messagesJson = messages === undefined
    ? row.messages_json
    : serialiseMessages(messages, res);
  if (messagesJson === null) return;

  if (projectId !== undefined && !ownedProjectId(projectId, userId)) {
    res.status(400).json({ error: { message: 'Invalid project' } });
    return;
  }

  const now = Date.now();
  // One statement for the whole conversation: title, transcript, model and
  // system prompt always move together, so a save can never leave a row half
  // updated (the transcript of one exchange under the title of another).
  getDb().prepare(`
    UPDATE playground_conversations
       SET title = ?, messages_json = ?, model = ?, system_prompt = ?, project_id = ?, updated_at_ms = ?
     WHERE id = ? AND user_id = ?
  `).run(
    title ?? row.title,
    messagesJson,
    model === undefined ? row.model : model,
    systemPrompt === undefined ? row.system_prompt : systemPrompt,
    projectId === undefined ? row.project_id : projectId,
    now,
    id,
    userId,
  );

  // Rebuild the turn index whenever the transcript changes. Title-only renames
  // still refresh updated_at on turns so recall recency stays honest — cheap
  // for typical Playground lengths.
  syncConversationTurns(userId, id, messagesJson, now);
  res.json(toJson(getConversation(id, userId)!));
});

conversationsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const userId = ownerId(req);
  // Explicit turn cleanup so recall stays correct even when SQLite foreign
  // keys are off for a driver/path; CASCADE covers the happy path.
  getDb().prepare('DELETE FROM playground_chat_turns WHERE conversation_id = ? AND user_id = ?')
    .run(id, userId);
  const info = getDb()
    .prepare('DELETE FROM playground_conversations WHERE id = ? AND user_id = ?')
    .run(id, userId);
  if (info.changes === 0) return notFound(res);
  res.json({ success: true });
});
