// MCP server connections and their tools in the shared registry.
//
// Each enabled server gets a connection (initialize handshake, tool discovery)
// and its tools are registered as `m<server id>__<tool>`: the id keeps two
// servers exposing the same tool name apart, and a stable prefix makes removal
// exact. Per-tool policy decides whether a tool is offered at all (deny), runs
// straight away (allow) or waits for approval in the chat (ask).

import { getDb } from '../../db/index.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { getToolRegistry, ToolOutcomeUncertainError, sanitizeToolSegment, type ToolDefinition } from '../tools/registry.js';
import {
  HttpTransport,
  McpError,
  McpResponseLostError,
  MCP_PROTOCOL_VERSION,
  StdioTransport,
  type McpTransport,
} from './transport.js';

export type McpPolicy = 'allow' | 'ask' | 'deny';

export interface McpServerRow {
  id: number;
  user_id: number;
  name: string;
  transport: 'http' | 'stdio';
  url: string | null;
  command: string | null;
  args_json: string;
  secrets_encrypted: string | null;
  secrets_iv: string | null;
  secrets_auth_tag: string | null;
  enabled: number;
  allow_private: number;
  default_policy: McpPolicy;
  tool_policy_json: string;
  last_error: string | null;
  last_connected_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface McpSecrets {
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; idempotentHint?: boolean };
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_TOOLS_PER_SERVER = 100;
const MAX_RESULT_CHARS = 100_000;

/** Running a stdio server runs software on the host: opt-in only. */
export function isStdioAllowed(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.MCP_ALLOW_STDIO ?? '');
}

export function toolPrefix(serverId: number): string {
  return `m${serverId}__`;
}

export function readSecrets(row: McpServerRow): McpSecrets {
  if (!row.secrets_encrypted || !row.secrets_iv || !row.secrets_auth_tag) return {};
  try {
    return JSON.parse(decrypt(row.secrets_encrypted, row.secrets_iv, row.secrets_auth_tag)) as McpSecrets;
  } catch {
    return {};
  }
}

export function sealSecrets(secrets: McpSecrets): { encrypted: string; iv: string; authTag: string } | null {
  const empty = !Object.keys(secrets.headers ?? {}).length && !Object.keys(secrets.env ?? {}).length;
  return empty ? null : encrypt(JSON.stringify(secrets));
}

function parsePolicies(row: McpServerRow): Record<string, McpPolicy> {
  try {
    const parsed = JSON.parse(row.tool_policy_json) as Record<string, unknown>;
    const out: Record<string, McpPolicy> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === 'allow' || v === 'ask' || v === 'deny') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function buildTransport(row: McpServerRow): McpTransport {
  const secrets = readSecrets(row);
  if (row.transport === 'http') {
    if (!row.url) throw new McpError('Server has no URL');
    return new HttpTransport({
      url: row.url,
      headers: secrets.headers ?? {},
      allowPrivate: row.allow_private === 1,
      timeoutMs: CALL_TIMEOUT_MS,
    });
  }
  if (!isStdioAllowed()) {
    throw new McpError('stdio servers are disabled (set MCP_ALLOW_STDIO=1 to allow them)');
  }
  if (!row.command) throw new McpError('Server has no command');
  let args: string[] = [];
  try { args = (JSON.parse(row.args_json) as unknown[]).map(String); } catch { args = []; }
  return new StdioTransport({
    command: row.command,
    args,
    env: secrets.env ?? {},
    timeoutMs: CALL_TIMEOUT_MS,
  });
}

function textOf(result: unknown): { text: string; isError: boolean } {
  const r = (result ?? {}) as { content?: unknown; isError?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  if (Array.isArray(r.content)) {
    for (const item of r.content as { type?: string; text?: string; uri?: string; mimeType?: string }[]) {
      if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
      else if (item?.type === 'resource_link' && item.uri) parts.push(`[resource: ${item.uri}]`);
      else if (item?.type === 'image') parts.push('[image omitted]');
      else if (item?.type === 'audio') parts.push('[audio omitted]');
      else if (item?.type) parts.push(`[${item.type} omitted]`);
    }
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  let text = parts.join('\n');
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`;
  return { text, isError: r.isError === true };
}

class McpConnection {
  private transport: McpTransport | null = null;
  tools: McpToolInfo[] = [];

  constructor(public row: McpServerRow) {}

  async connect(): Promise<void> {
    await this.disconnect();
    const transport = buildTransport(this.row);
    this.transport = transport;
    const signal = AbortSignal.timeout(CONNECT_TIMEOUT_MS);
    try {
      await transport.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'freellmapi', version: '1' },
      }, signal);
      await transport.notify('notifications/initialized');
      this.tools = await this.listTools(signal);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  private async listTools(signal: AbortSignal): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.transport!.request('tools/list', cursor ? { cursor } : {}, signal) as {
        tools?: McpToolInfo[];
        nextCursor?: string;
      };
      for (const t of result.tools ?? []) {
        if (typeof t?.name === 'string') out.push(t);
      }
      if (!result.nextCursor || out.length >= MAX_TOOLS_PER_SERVER) break;
      cursor = result.nextCursor;
    }
    return out.slice(0, MAX_TOOLS_PER_SERVER);
  }

  async call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!this.transport) await this.connect();
    return this.transport!.request('tools/call', { name, arguments: args }, signal);
  }

  async disconnect(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    if (t) await t.close().catch(() => undefined);
  }
}

const connections = new Map<number, McpConnection>();

function setStatus(id: number, error: string | null): void {
  getDb().prepare(`
    UPDATE mcp_servers
       SET last_error = ?,
           last_connected_at_ms = CASE WHEN ? IS NULL THEN ? ELSE last_connected_at_ms END
     WHERE id = ?
  `).run(error ? error.slice(0, 500) : null, error, Date.now(), id);
}

function registerTools(conn: McpConnection): number {
  const registry = getToolRegistry();
  const row = conn.row;
  registry.unregisterPrefix(toolPrefix(row.id));
  const policies = parsePolicies(row);
  let count = 0;
  for (const info of conn.tools) {
    const policy = policies[info.name] ?? row.default_policy;
    if (policy === 'deny') continue;
    const name = `${toolPrefix(row.id)}${sanitizeToolSegment(info.name)}`.slice(0, 64);
    if (registry.get(name)) continue; // two server tools collapsing to one name: keep the first
    const idempotent = info.annotations?.readOnlyHint === true || info.annotations?.idempotentHint === true;
    const definition: ToolDefinition = {
      name,
      description: `[${row.name}] ${info.description ?? info.name}`.slice(0, 1000),
      parameters: info.inputSchema && typeof info.inputSchema === 'object'
        ? info.inputSchema
        : { type: 'object', properties: {} },
      source: 'mcp',
      approval: policy === 'allow' ? 'never' : 'always',
      ownerUserId: row.user_id,
      idempotent,
      async execute(args, ctx) {
        if (ctx.userId !== row.user_id) {
          return { content: 'This tool belongs to another account', isError: true };
        }
        const live = connections.get(row.id);
        if (!live) return { content: 'The server is disconnected', isError: true };
        try {
          const raw = await live.call(info.name, args, ctx.signal);
          const { text, isError } = textOf(raw);
          return { content: text || (isError ? 'The tool reported an error' : '(no output)'), isError };
        } catch (error) {
          if (error instanceof McpResponseLostError) {
            if (idempotent) return { content: `Connection lost: ${error.message}`, isError: true };
            throw new ToolOutcomeUncertainError(`Connection lost: ${error.message}`);
          }
          return { content: error instanceof Error ? error.message : 'Tool call failed', isError: true };
        }
      },
    };
    try {
      registry.register(definition);
      count += 1;
    } catch {
      // A tool whose schema does not compile is skipped, not fatal for the server.
    }
  }
  return count;
}

/** Connect (or reconnect) one server and refresh its tools. Never throws. */
export async function syncServer(row: McpServerRow): Promise<{ ok: boolean; tools: number; error?: string }> {
  const existing = connections.get(row.id);
  if (existing) await existing.disconnect();
  connections.delete(row.id);
  getToolRegistry().unregisterPrefix(toolPrefix(row.id));
  if (row.enabled !== 1) return { ok: true, tools: 0 };

  const conn = new McpConnection(row);
  try {
    await conn.connect();
    connections.set(row.id, conn);
    const tools = registerTools(conn);
    setStatus(row.id, null);
    return { ok: true, tools };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Connection failed';
    setStatus(row.id, message);
    return { ok: false, tools: 0, error: message };
  }
}

export async function removeServer(id: number): Promise<void> {
  const existing = connections.get(id);
  connections.delete(id);
  getToolRegistry().unregisterPrefix(toolPrefix(id));
  if (existing) await existing.disconnect();
}

/** Tool names (before policy filtering is applied) a connected server offers. */
export function listConnectedTools(id: number): { name: string; description: string; readOnly: boolean }[] {
  const conn = connections.get(id);
  if (!conn) return [];
  return conn.tools.map(t => ({
    name: t.name,
    description: t.description ?? '',
    readOnly: t.annotations?.readOnlyHint === true,
  }));
}

export function isConnected(id: number): boolean {
  return connections.has(id);
}

/** Start-up: connect every enabled server in the background. */
export async function connectAllEnabled(): Promise<void> {
  const rows = getDb().prepare('SELECT * FROM mcp_servers WHERE enabled = 1').all() as McpServerRow[];
  await Promise.allSettled(rows.map(r => syncServer(r)));
}

export async function disconnectAll(): Promise<void> {
  const all = [...connections.values()];
  connections.clear();
  await Promise.allSettled(all.map(c => c.disconnect()));
}
