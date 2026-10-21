import { describe, it, expect, beforeAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';

vi.mock('../../services/embeddings.js', () => {
  const embed = (text: string): number[] => {
    const v = new Array<number>(16).fill(0);
    for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 16;
      v[h] += 1;
    }
    return v;
  };
  class EmbeddingsError extends Error { status = 500; }
  return {
    EmbeddingsError,
    getDefaultFamily: () => 'fam',
    listEmbeddingModels: () => [{ family: 'fam', enabled: 1 }],
    runEmbeddings: async (_m: string | undefined, inputs: string[]) => ({
      family: 'fam', platform: 'p', modelId: 'm', dimensions: 16, vectors: inputs.map(embed), inputTokens: 1,
    }),
  };
});

import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function call(app: Express, method: string, path: string, opts: { body?: unknown; token?: string } = {}) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
  const port = (server.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  server.close();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function fakeMcp(): Promise<{ url: string; close: () => void }> {
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', d => { b += d; });
    req.on('end', () => {
      const m = JSON.parse(b || '{}');
      if (m.id === undefined) { res.writeHead(202).end(); return; }
      const result = m.method === 'tools/list'
        ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
        : { protocolVersion: '2025-06-18', capabilities: {} };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => server.close() })));
}

describe('agentic routes', () => {
  let app: Express;
  let tokenA: string;
  let tokenB: string;
  let convoA: number;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    tokenA = mintDashboardToken('a-agentic@example.com');
    tokenB = mintDashboardToken('b-agentic@example.com');
    const c = await call(app, 'POST', '/api/conversations', { token: tokenA, body: { title: 'x' } });
    convoA = c.body.id;
  });

  it('requires a dashboard session', async () => {
    expect((await call(app, 'GET', '/api/runs/features')).status).toBe(401);
    expect((await call(app, 'GET', '/api/knowledge/bases')).status).toBe(401);
    expect((await call(app, 'GET', '/api/mcp-servers')).status).toBe(401);
  });

  it('has every feature on by default', async () => {
    const f = await call(app, 'GET', '/api/runs/features', { token: tokenA });
    expect(f.body).toEqual({ mcp_client: true, sandbox: true, knowledge: true, voice: true });
    expect((await call(app, 'GET', '/api/mcp-servers', { token: tokenA })).status).toBe(200);
    expect((await call(app, 'GET', '/api/knowledge/bases', { token: tokenA })).status).toBe(200);
  });

  it('lists built-in and knowledge tools, but no sandbox tool until a worker is set', async () => {
    const t = await call(app, 'GET', '/api/runs/tools', { token: tokenA });
    expect(t.status).toBe(200);
    const names = t.body.map((x: any) => x.name);
    expect(names).toEqual(expect.arrayContaining(['builtin__echo', 'builtin__current_time', 'knowledge__search']));
    expect(names).not.toContain('sandbox__run_python');
  });

  it('settings: save sandbox config, mask the token, register the tool, validate the URL', async () => {
    const initial = await call(app, 'GET', '/api/agentic-settings', { token: tokenA });
    expect(initial.body).toEqual({ sandboxUrl: '', hasSandboxToken: false, allowStdio: false, sandboxAutoApprove: false });
    expect((await call(app, 'GET', '/api/agentic-settings')).status).toBe(401);

    expect((await call(app, 'PUT', '/api/agentic-settings', { token: tokenA, body: { sandboxUrl: 'ftp://x' } })).status).toBe(400);
    expect((await call(app, 'PUT', '/api/agentic-settings', { token: tokenA, body: { nope: 1 } })).status).toBe(400);
    expect((await call(app, 'POST', '/api/agentic-settings/sandbox/test', { token: tokenA })).body.ok).toBe(false);

    const saved = await call(app, 'PUT', '/api/agentic-settings', {
      token: tokenA, body: { sandboxUrl: 'http://127.0.0.1:9/', sandboxToken: 'super-secret-token' },
    });
    expect(saved.body).toMatchObject({ sandboxUrl: 'http://127.0.0.1:9', hasSandboxToken: true });
    expect(JSON.stringify(saved.body)).not.toContain('super-secret-token');
    const raw = getDb().prepare("SELECT value FROM settings WHERE key = 'agentic_sandbox_token'").get() as any;
    expect(raw.value).not.toContain('super-secret-token');

    const tools = await call(app, 'GET', '/api/runs/tools', { token: tokenA });
    const sandbox = tools.body.find((x: any) => x.name === 'sandbox__run_python');
    expect(sandbox).toMatchObject({ approval: 'always' });

    await call(app, 'PUT', '/api/agentic-settings', { token: tokenA, body: { sandboxAutoApprove: true, allowStdio: true } });
    const after = await call(app, 'GET', '/api/runs/tools', { token: tokenA });
    expect(after.body.find((x: any) => x.name === 'sandbox__run_python')).toMatchObject({ approval: 'never' });
    expect((await call(app, 'GET', '/api/agentic-settings', { token: tokenA })).body).toMatchObject({ allowStdio: true });

    // Clearing the token removes the tool again.
    await call(app, 'PUT', '/api/agentic-settings', { token: tokenA, body: { sandboxToken: '', allowStdio: false } });
    const cleared = await call(app, 'GET', '/api/runs/tools', { token: tokenA });
    expect(cleared.body.some((x: any) => x.name === 'sandbox__run_python')).toBe(false);
  });

  it('validates run requests and conversation ownership', async () => {
    const bad = await call(app, 'POST', '/api/runs', { token: tokenA, body: { conversationId: 'x' } });
    expect(bad.status).toBe(400);
    const foreign = await call(app, 'POST', '/api/runs', {
      token: tokenB, body: { conversationId: convoA, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(foreign.status).toBe(404);
    expect((await call(app, 'POST', '/api/runs/nope/cancel', { token: tokenA })).status).toBe(404);
    expect((await call(app, 'GET', '/api/runs/nope', { token: tokenA })).status).toBe(404);
    expect((await call(app, 'GET', '/api/runs/artifacts/nope', { token: tokenA })).status).toBe(404);
  });

  it('knowledge: create, upload, index, search, isolate, delete', async () => {
    const base = await call(app, 'POST', '/api/knowledge/bases', { token: tokenA, body: { name: 'kb1' } });
    expect(base.status).toBe(201);
    const dup = await call(app, 'POST', '/api/knowledge/bases', { token: tokenA, body: { name: 'kb1' } });
    expect(dup.status).toBe(409);

    const up = await call(app, 'POST', `/api/knowledge/bases/${base.body.id}/documents`, {
      token: tokenA,
      body: { name: 'notes.md', mimeType: 'text/markdown', text: '# Plan\n\nThe launch is scheduled for the first of June.' },
    });
    expect(up.status).toBe(202);
    for (let i = 0; i < 50; i += 1) {
      const docs = await call(app, 'GET', `/api/knowledge/bases/${base.body.id}/documents`, { token: tokenA });
      if (docs.body[0]?.status === 'ready') break;
      await new Promise(r => setTimeout(r, 50));
    }
    const docs = await call(app, 'GET', `/api/knowledge/bases/${base.body.id}/documents`, { token: tokenA });
    expect(docs.body[0]).toMatchObject({ name: 'notes.md', status: 'ready' });

    const found = await call(app, 'POST', `/api/knowledge/bases/${base.body.id}/search`, { token: tokenA, body: { query: 'when is the launch' } });
    expect(found.status).toBe(200);
    expect(found.body.passages[0].text).toMatch(/launch/);

    const preview = await call(app, 'GET', `/api/knowledge/documents/${found.body.passages[0].documentId}/chunks/${found.body.passages[0].ordinal}`, { token: tokenA });
    expect(preview.status).toBe(200);

    // Another account sees nothing of it.
    expect((await call(app, 'GET', `/api/knowledge/bases/${base.body.id}/documents`, { token: tokenB })).status).toBe(404);
    expect((await call(app, 'DELETE', `/api/knowledge/documents/${docs.body[0].id}`, { token: tokenB })).status).toBe(404);

    expect((await call(app, 'POST', `/api/knowledge/bases/${base.body.id}/documents`, {
      token: tokenA, body: { name: 'x.exe', mimeType: 'application/x-msdownload', text: 'a' },
    })).status).toBe(415);

    expect((await call(app, 'DELETE', `/api/knowledge/documents/${docs.body[0].id}`, { token: tokenA })).status).toBe(204);
    const after = await call(app, 'POST', `/api/knowledge/bases/${base.body.id}/search`, { token: tokenA, body: { query: 'launch' } });
    expect(after.body.passages).toHaveLength(0);
  });

  it('mcp servers: validate, create, hide secrets, isolate, delete', async () => {
    const mcp = await fakeMcp();
    try {
      const blocked = await call(app, 'POST', '/api/mcp-servers', {
        token: tokenA, body: { name: 'local', transport: 'http', url: mcp.url },
      });
      expect(blocked.status).toBe(400); // loopback needs allowPrivate

      const stdio = await call(app, 'POST', '/api/mcp-servers', {
        token: tokenA, body: { name: 'proc', transport: 'stdio', command: 'ls' },
      });
      expect(stdio.status).toBe(400); // stdio not allowed in settings

      const created = await call(app, 'POST', '/api/mcp-servers', {
        token: tokenA,
        body: { name: 'local', transport: 'http', url: mcp.url, allowPrivate: true, headers: { Authorization: 'Bearer secret-token' }, defaultPolicy: 'allow' },
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ connected: true, tools: 1, headerNames: ['Authorization'] });
      expect(JSON.stringify(created.body)).not.toContain('secret-token');

      const raw = getDb().prepare('SELECT secrets_encrypted FROM mcp_servers WHERE id = ?').get(created.body.id) as any;
      expect(raw.secrets_encrypted).not.toContain('secret-token');

      const tools = await call(app, 'GET', `/api/runs/tools`, { token: tokenA });
      expect(tools.body.some((t: any) => t.name === `m${created.body.id}__ping`)).toBe(true);
      const otherTools = await call(app, 'GET', `/api/runs/tools`, { token: tokenB });
      expect(otherTools.body.some((t: any) => t.name === `m${created.body.id}__ping`)).toBe(false);

      expect((await call(app, 'GET', `/api/mcp-servers/${created.body.id}/tools`, { token: tokenB })).status).toBe(404);
      expect((await call(app, 'DELETE', `/api/mcp-servers/${created.body.id}`, { token: tokenB })).status).toBe(404);

      const dup = await call(app, 'POST', '/api/mcp-servers', {
        token: tokenA, body: { name: 'local', transport: 'http', url: mcp.url, allowPrivate: true },
      });
      expect(dup.status).toBe(409);

      expect((await call(app, 'DELETE', `/api/mcp-servers/${created.body.id}`, { token: tokenA })).status).toBe(204);
      const gone = await call(app, 'GET', `/api/runs/tools`, { token: tokenA });
      expect(gone.body.some((t: any) => t.name === `m${created.body.id}__ping`)).toBe(false);
    } finally {
      mcp.close();
    }
  });
});
