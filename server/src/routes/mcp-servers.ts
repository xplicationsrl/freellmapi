import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { isFeatureEnabled } from '../lib/features.js';
import { assessProviderUrl } from '../lib/url-guard.js';
import {
  isConnected,
  isStdioAllowed,
  listConnectedTools,
  readSecrets,
  removeServer,
  sealSecrets,
  syncServer,
  type McpServerRow,
} from '../services/mcp-client/manager.js';

// MCP client server configuration for the Integrations page, mounted under
// /api/mcp-servers behind the dashboard session gate. Per account. Secrets are
// write-only: responses carry the header/env NAMES, never the values.

export const mcpServersRouter = Router();

mcpServersRouter.use((_req: Request, res: Response, next: NextFunction) => {
  if (!isFeatureEnabled('mcp_client')) {
    res.status(404).json({ error: { message: 'MCP client is disabled' } });
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

const policy = z.enum(['allow', 'ask', 'deny']);
const stringMap = z.record(z.string().min(1).max(100), z.string().max(4000)).refine(
  m => Object.keys(m).length <= 30, 'Too many entries',
);

const baseSchema = z.object({
  name: z.string().trim().min(1).max(60).regex(/^[\w .-]+$/, 'Letters, digits, space, dot, dash and underscore only'),
  transport: z.enum(['http', 'stdio']),
  url: z.string().trim().max(2000).optional(),
  command: z.string().trim().max(500).optional(),
  args: z.array(z.string().max(1000)).max(50).optional(),
  headers: stringMap.optional(),
  env: stringMap.optional(),
  enabled: z.boolean().optional(),
  allowPrivate: z.boolean().optional(),
  defaultPolicy: policy.optional(),
  toolPolicy: z.record(z.string().max(200), policy).optional(),
}).strict();

const createSchema = baseSchema;
// On update every field is optional; omitted secrets keep their stored value.
const updateSchema = baseSchema.partial().strict();

function toJson(row: McpServerRow) {
  const secrets = readSecrets(row);
  let args: string[] = [];
  let toolPolicy: Record<string, string> = {};
  try { args = JSON.parse(row.args_json) as string[]; } catch { /* leave empty */ }
  try { toolPolicy = JSON.parse(row.tool_policy_json) as Record<string, string>; } catch { /* leave empty */ }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    url: row.url,
    command: row.command,
    args,
    headerNames: Object.keys(secrets.headers ?? {}),
    envNames: Object.keys(secrets.env ?? {}),
    enabled: row.enabled === 1,
    allowPrivate: row.allow_private === 1,
    defaultPolicy: row.default_policy,
    toolPolicy,
    connected: isConnected(row.id),
    lastError: row.last_error,
    lastConnectedAt: row.last_connected_at_ms,
    createdAt: row.created_at_ms,
    updatedAt: row.updated_at_ms,
  };
}

function getRow(id: number, uid: number): McpServerRow | undefined {
  return getDb().prepare('SELECT * FROM mcp_servers WHERE id = ? AND user_id = ?').get(id, uid) as
    McpServerRow | undefined;
}

function parseId(req: Request, res: Response): number | null {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    bad(res, 400, 'Invalid server id');
    return null;
  }
  return id;
}

/** Validate the transport-specific fields. Returns an error message or null. */
async function checkTarget(
  transport: 'http' | 'stdio',
  url: string | null | undefined,
  command: string | null | undefined,
  allowPrivate: boolean,
): Promise<string | null> {
  if (transport === 'stdio') {
    if (!isStdioAllowed()) return 'stdio servers are disabled on this install (MCP_ALLOW_STDIO=1 enables them)';
    if (!command) return 'A command is required for a stdio server';
    return null;
  }
  if (!url) return 'A URL is required for an http server';
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'Invalid URL'; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'URL must be http or https';
  if (parsed.username || parsed.password) return 'Put credentials in headers, not in the URL';
  const verdict = await assessProviderUrl(url, { blockPrivate: !allowPrivate });
  return verdict.allowed ? null : `URL blocked: ${verdict.reason}`;
}

mcpServersRouter.get('/', (req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT * FROM mcp_servers WHERE user_id = ? ORDER BY name')
    .all(userId(req)) as McpServerRow[];
  res.json({ stdioAllowed: isStdioAllowed(), servers: rows.map(toJson) });
});

mcpServersRouter.post('/', async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    bad(res, 400, parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    return;
  }
  const d = parsed.data;
  const problem = await checkTarget(d.transport, d.url, d.command, d.allowPrivate === true);
  if (problem) { bad(res, 400, problem); return; }

  const sealed = sealSecrets({ headers: d.headers, env: d.env });
  const now = Date.now();
  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO mcp_servers
        (user_id, name, transport, url, command, args_json, secrets_encrypted, secrets_iv, secrets_auth_tag,
         enabled, allow_private, default_policy, tool_policy_json, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId(req), d.name, d.transport,
      d.transport === 'http' ? d.url ?? null : null,
      d.transport === 'stdio' ? d.command ?? null : null,
      JSON.stringify(d.args ?? []),
      sealed?.encrypted ?? null, sealed?.iv ?? null, sealed?.authTag ?? null,
      d.enabled === false ? 0 : 1, d.allowPrivate ? 1 : 0,
      d.defaultPolicy ?? 'ask', JSON.stringify(d.toolPolicy ?? {}), now, now,
    );
    const row = getRow(Number(result.lastInsertRowid), userId(req))!;
    const status = await syncServer(row);
    res.status(201).json({ ...toJson(getRow(row.id, userId(req))!), tools: status.tools });
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      bad(res, 409, 'A server with that name already exists');
      return;
    }
    throw error;
  }
});

mcpServersRouter.put('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const uid = userId(req);
  const row = getRow(id, uid);
  if (!row) { bad(res, 404, 'Server not found'); return; }
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    bad(res, 400, parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    return;
  }
  const d = parsed.data;
  const transport = d.transport ?? row.transport;
  const url = d.url !== undefined ? d.url : row.url;
  const command = d.command !== undefined ? d.command : row.command;
  const allowPrivate = d.allowPrivate ?? row.allow_private === 1;
  const problem = await checkTarget(transport, url, command, allowPrivate);
  if (problem) { bad(res, 400, problem); return; }

  // Secrets are replaced only when sent; an omitted map keeps what is stored.
  const current = readSecrets(row);
  const sealed = sealSecrets({
    headers: d.headers ?? current.headers,
    env: d.env ?? current.env,
  });
  try {
    getDb().prepare(`
      UPDATE mcp_servers SET
        name = ?, transport = ?, url = ?, command = ?, args_json = ?,
        secrets_encrypted = ?, secrets_iv = ?, secrets_auth_tag = ?,
        enabled = ?, allow_private = ?, default_policy = ?, tool_policy_json = ?, updated_at_ms = ?
      WHERE id = ? AND user_id = ?
    `).run(
      d.name ?? row.name, transport,
      transport === 'http' ? url ?? null : null,
      transport === 'stdio' ? command ?? null : null,
      d.args ? JSON.stringify(d.args) : row.args_json,
      sealed?.encrypted ?? null, sealed?.iv ?? null, sealed?.authTag ?? null,
      d.enabled === undefined ? row.enabled : d.enabled ? 1 : 0,
      allowPrivate ? 1 : 0,
      d.defaultPolicy ?? row.default_policy,
      d.toolPolicy ? JSON.stringify(d.toolPolicy) : row.tool_policy_json,
      Date.now(), id, uid,
    );
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) {
      bad(res, 409, 'A server with that name already exists');
      return;
    }
    throw error;
  }
  const updated = getRow(id, uid)!;
  const status = await syncServer(updated);
  res.json({ ...toJson(getRow(id, uid)!), tools: status.tools });
});

mcpServersRouter.delete('/:id', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const uid = userId(req);
  if (!getRow(id, uid)) { bad(res, 404, 'Server not found'); return; }
  await removeServer(id);
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ? AND user_id = ?').run(id, uid);
  res.status(204).end();
});

// Reconnect and rediscover tools; the Integrations "Test connection" button.
mcpServersRouter.post('/:id/test', async (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getRow(id, userId(req));
  if (!row) { bad(res, 404, 'Server not found'); return; }
  const status = await syncServer(row);
  res.json({ ok: status.ok, tools: status.tools, error: status.error ?? null });
});

mcpServersRouter.get('/:id/tools', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getRow(id, userId(req));
  if (!row) { bad(res, 404, 'Server not found'); return; }
  res.json({ connected: isConnected(id), tools: listConnectedTools(id) });
});

// Recent calls to this server's tools, for the activity list.
mcpServersRouter.get('/:id/calls', (req: Request, res: Response) => {
  const id = parseId(req, res);
  if (id === null) return;
  const row = getRow(id, userId(req));
  if (!row) { bad(res, 404, 'Server not found'); return; }
  const calls = getDb().prepare(`
    SELECT t.call_id, t.tool_name, t.status, t.outcome, t.error_message, t.started_at_ms, t.finished_at_ms
      FROM chat_tool_calls t
     WHERE t.source = 'mcp' AND t.tool_name LIKE ? ESCAPE '\\'
     ORDER BY t.id DESC LIMIT 50
  `).all(`m${id}\\_\\_%`) as Record<string, unknown>[];
  res.json(calls);
});
