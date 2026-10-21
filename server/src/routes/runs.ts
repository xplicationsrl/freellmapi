import { Router } from 'express';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { RunEvent } from '@freellmapi/shared/conversation-events.js';
import { getUnifiedApiKey } from '../db/index.js';
import { featureStates, isFeatureEnabled } from '../lib/features.js';
import { registerSandboxTool } from '../services/sandbox/executor.js';
import { registerKnowledgeTool } from '../services/knowledge/tool.js';
import { registerBuiltinTools } from '../services/tools/builtin.js';
import { getToolRegistry } from '../services/tools/registry.js';
import { artifactRoot, safeArtifactName } from '../services/conversations/artifact-store.js';
import { cancelRun, resolveApproval, startRun } from '../services/conversations/orchestrator.js';
import {
  conversationBelongsTo,
  getArtifactForUser,
  getRunForUser,
} from '../services/conversations/run-store.js';

// Server-side conversation runs, mounted under /api/runs behind the dashboard
// session gate. POST / streams one run as SSE (see shared/conversation-events);
// the other routes inspect, cancel and approve runs. Runs are scoped to the
// account that owns the conversation: anyone else's run answers 404.

export const runsRouter = Router();

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Register the tools whose feature is on and whose backend is configured. */
function ensureTools(): void {
  registerBuiltinTools();
  if (isFeatureEnabled('sandbox')) registerSandboxTool();
  if (isFeatureEnabled('knowledge')) registerKnowledgeTool();
}

function userId(req: Request): number {
  return (req as Request & { user: { userId: number } }).user.userId;
}

function loopbackChatUrl(req: Request): string {
  const port = req.socket.localPort;
  if (!port) throw new Error('Cannot determine the local port');
  let address = (req.socket.localAddress || '127.0.0.1').split('%')[0];
  if (address === '0.0.0.0') address = '127.0.0.1';
  if (address === '::') address = '::1';
  if (address.startsWith('::ffff:')) address = address.slice('::ffff:'.length);
  const host = address.includes(':') ? `[${address}]` : address;
  return `http://${host}:${port}/v1/chat/completions`;
}

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.union([z.string(), z.array(z.unknown())]),
});

const startSchema = z.object({
  conversationId: z.number().int().positive(),
  model: z.string().max(200).default('auto'),
  messages: z.array(messageSchema).min(1).max(400),
  systemPrompt: z.string().max(32_000).optional(),
  tools: z.array(z.string().max(64)).max(64).optional(),
  attachments: z.array(z.object({
    name: z.string().min(1).max(120),
    mimeType: z.string().max(100).default('application/octet-stream'),
    dataBase64: z.string().max(7_000_000),
  }).strict()).max(5).optional(),
  knowledgeBases: z.array(z.number().int().positive()).max(10).optional(),
  maxRounds: z.number().int().min(1).max(12).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(32_000).optional(),
}).strict();

function bad(res: Response, status: number, message: string): void {
  res.status(status).json({ error: { message } });
}

runsRouter.get('/features', (_req: Request, res: Response) => {
  res.json(featureStates());
});

/** Tools this account may use now: its own MCP tools only while the feature is on. */
function visibleTools(uid: number) {
  const flags = featureStates();
  return getToolRegistry().listForUser(uid).filter(t => {
    if (t.source === 'mcp') return flags.mcp_client;
    if (t.source === 'sandbox') return flags.sandbox;
    if (t.source === 'knowledge') return flags.knowledge;
    return true;
  });
}

runsRouter.get('/tools', (req: Request, res: Response) => {
  ensureTools();
  res.json(visibleTools(userId(req)).map(t => ({
    name: t.name,
    description: t.description,
    source: t.source,
    approval: t.approval,
    parameters: t.parameters,
  })));
});

runsRouter.post('/', async (req: Request, res: Response) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    bad(res, 400, parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    return;
  }
  const input = parsed.data;
  const uid = userId(req);
  if (!conversationBelongsTo(input.conversationId, uid)) {
    bad(res, 404, 'Conversation not found');
    return;
  }
  ensureTools();

  let chatUrl: string;
  try {
    chatUrl = loopbackChatUrl(req);
  } catch (error) {
    bad(res, 500, error instanceof Error ? error.message : 'Cannot reach the local router');
    return;
  }

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let runId: string | null = null;
  let clientGone = false;
  res.once('close', () => {
    clientGone = true;
    // The page closed or navigated away: stop the model call and any tool.
    if (runId) cancelRun(runId, uid);
  });

  const write = (event: RunEvent): void => {
    if (event.type === 'run.started') {
      runId = event.runId;
      // The close handler above may have fired before the id was known.
      if (clientGone) cancelRun(event.runId, uid);
    }
    if (clientGone || res.writableEnded) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const messages = [
    ...(input.systemPrompt ? [{ role: 'system' as const, content: input.systemPrompt }] : []),
    ...input.messages,
  ];

  // Only tools this account can see are honoured; anything else is dropped.
  const visible = new Set(visibleTools(uid).map(t => t.name));
  const toolNames = (input.tools ?? []).filter(n => visible.has(n));
  // Picking a knowledge base in the chat is what turns document search on.
  if ((input.knowledgeBases?.length ?? 0) > 0 && visible.has('knowledge__search')
      && !toolNames.includes('knowledge__search')) {
    toolNames.push('knowledge__search');
  }

  const attachments = (input.attachments ?? []).map(a => ({
    name: safeArtifactName(a.name),
    mimeType: a.mimeType,
    data: Buffer.from(a.dataBase64, 'base64'),
  }));
  if (attachments.reduce((n, a) => n + a.data.length, 0) > MAX_ATTACHMENT_BYTES) {
    res.write(`data: ${JSON.stringify({ type: 'run.failed', runId: '', code: 'internal', message: 'Attachments exceed 5 MB' })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  try {
    await startRun({
      attachments,
      knowledgeBaseIds: input.knowledgeBases,
      conversationId: input.conversationId,
      userId: uid,
      chatUrl,
      apiKey: getUnifiedApiKey(),
      model: input.model,
      messages,
      toolNames,
      maxRounds: input.maxRounds,
      temperature: input.temperature,
      maxTokens: input.maxTokens,
      emit: write,
    });
  } finally {
    if (!res.writableEnded) {
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

runsRouter.get('/:id', (req: Request, res: Response) => {
  const found = getRunForUser(String(req.params.id), userId(req));
  if (!found) {
    bad(res, 404, 'Run not found');
    return;
  }
  const { run, toolCalls } = found;
  res.json({
    id: run.id,
    conversationId: run.conversation_id,
    status: run.status,
    model: run.model,
    rounds: run.rounds,
    error: run.error_code ? { code: run.error_code, message: run.error_message } : null,
    startedAt: run.started_at_ms,
    finishedAt: run.finished_at_ms,
    toolCalls: toolCalls.map(t => ({
      callId: t.call_id,
      round: t.round,
      name: t.tool_name,
      source: t.source,
      status: t.status,
      outcome: t.outcome,
      error: t.error_code ? { code: t.error_code, message: t.error_message } : null,
    })),
  });
});

runsRouter.post('/:id/cancel', (req: Request, res: Response) => {
  const ok = cancelRun(String(req.params.id), userId(req));
  if (!ok) {
    bad(res, 404, 'No active run with that id');
    return;
  }
  res.json({ ok: true });
});

const approveSchema = z.object({ approved: z.boolean() }).strict();

runsRouter.post('/:id/tools/:callId/approval', (req: Request, res: Response) => {
  const parsed = approveSchema.safeParse(req.body);
  if (!parsed.success) {
    bad(res, 400, 'Body must be { approved: boolean }');
    return;
  }
  const ok = resolveApproval(
    String(req.params.id), userId(req), String(req.params.callId), parsed.data.approved,
  );
  if (!ok) {
    bad(res, 404, 'No pending approval for that call');
    return;
  }
  res.json({ ok: true });
});

runsRouter.get('/artifacts/:id', (req: Request, res: Response) => {
  const row = getArtifactForUser(String(req.params.id), userId(req));
  if (!row || (row.expires_at_ms !== null && row.expires_at_ms < Date.now())) {
    bad(res, 404, 'Artifact not found');
    return;
  }
  // Only ever serve from inside the artifact root, whatever the row says.
  const resolved = path.resolve(row.storage_path);
  if (!resolved.startsWith(artifactRoot() + path.sep) || !fs.existsSync(resolved)) {
    bad(res, 404, 'Artifact not found');
    return;
  }
  res.setHeader('Content-Type', row.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${row.name.replace(/[^\w.\- ]/g, '_')}"`,
  );
  fs.createReadStream(resolved).pipe(res);
});
