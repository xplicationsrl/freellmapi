import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RunEvent } from '@freellmapi/shared/conversation-events.js';

// Embeddings are the only network dependency of the knowledge base: replace
// them with a deterministic bag-of-words vector so retrieval is testable.
vi.mock('../../services/embeddings.js', () => {
  const DIM = 32;
  const embed = (text: string): number[] => {
    const v = new Array<number>(DIM).fill(0);
    for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      let h = 0;
      for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % DIM;
      v[h] += 1;
    }
    return v;
  };
  class EmbeddingsError extends Error {
    status = 500;
  }
  return {
    EmbeddingsError,
    getDefaultFamily: () => 'test-family',
    listEmbeddingModels: () => [{ family: 'test-family', enabled: 1 }],
    runEmbeddings: async (_model: string | undefined, inputs: string[]) => ({
      family: 'test-family', platform: 'test', modelId: 'm', dimensions: DIM,
      vectors: inputs.map(embed), inputTokens: 1,
    }),
  };
});

import { initDb, getDb } from '../../db/index.js';
import { createUser } from '../../services/auth.js';
import { cancelRun, resolveApproval, startRun } from '../../services/conversations/orchestrator.js';
import { failInterruptedRuns } from '../../services/conversations/run-store.js';
import { registerBuiltinTools } from '../../services/tools/builtin.js';
import {
  getToolRegistry, ToolOutcomeUncertainError, type ToolDefinition,
} from '../../services/tools/registry.js';
import { syncServer, type McpServerRow } from '../../services/mcp-client/manager.js';
import { enqueueDocument, processQueue } from '../../services/knowledge/ingest.js';
import { searchKnowledge } from '../../services/knowledge/retrieve.js';

// ---- a fake OpenAI-compatible model: scripted replies, records requests ----

type Script = { tool?: { name: string; args: string }; text?: string };

function sse(res: http.ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function startFakeModel(): Promise<{ url: string; requests: { messages: any[]; tools?: any[] }[]; script: Script[]; close: () => void }> {
  const requests: { messages: any[]; tools?: any[] }[] = [];
  const script: Script[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      requests.push(JSON.parse(body));
      const step = script.shift() ?? { text: 'done' };
      if (step.tool) {
        // Arguments arrive split across frames, as real providers do.
        const half = Math.floor(step.tool.args.length / 2);
        sse(res, [
          { model: 'fake', choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: step.tool.name, arguments: step.tool.args.slice(0, half) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: step.tool.args.slice(half) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      } else {
        sse(res, [
          { model: 'fake', choices: [{ delta: { content: step.text ?? '' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ]);
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/v1/chat/completions`, requests, script, close: () => server.close() });
    });
  });
}

// ---- a fake MCP server (Streamable HTTP, JSON responses) ----

function startFakeMcp(): Promise<{ url: string; calls: string[]; close: () => void }> {
  const calls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      const msg = JSON.parse(body || '{}') as { id?: number; method: string; params?: any };
      calls.push(msg.method);
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      const reply = (result: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 's1' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } });
      if (msg.method === 'tools/list') {
        return reply({ tools: [
          { name: 'ping', description: 'Ping', inputSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] }, annotations: { readOnlyHint: true } },
          { name: 'secret', description: 'hidden by policy', inputSchema: { type: 'object' } },
        ] });
      }
      if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text: `pong ${msg.params.arguments.who}` }] });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls, close: () => server.close() });
    });
  });
}

describe('agentic runs', () => {
  let userId: number;
  let conversationId: number;
  let model: Awaited<ReturnType<typeof startFakeModel>>;

  const run = async (opts: { tools?: string[]; text?: string }) => {
    const events: RunEvent[] = [];
    const runId = await startRun({
      conversationId, userId, chatUrl: model.url, apiKey: 'k', model: 'pinned',
      messages: [{ role: 'user', content: opts.text ?? 'hi' }],
      toolNames: opts.tools, emit: e => events.push(e),
    });
    return { runId, events };
  };

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    userId = createUser('agentic@example.com', 'password123').userId;
    conversationId = Number(getDb().prepare(
      'INSERT INTO playground_conversations (user_id, title, messages_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run(userId, 't', '[]', Date.now(), Date.now()).lastInsertRowid);
    registerBuiltinTools();
    model = await startFakeModel();
    // A model that supports tools must exist for `auto` to resolve; tests pin a model id instead.
  });
  afterAll(() => model.close());

  const modelPinned = (opts: Parameters<typeof run>[0]) => run(opts);

  it('streams text with no tools', async () => {
    model.script.push({ text: 'hello there' });
    const { events } = await modelPinned({});
    expect(events.map(e => e.type)).toEqual(['run.started', 'message.delta', 'run.completed']);
    expect(events.find(e => e.type === 'message.delta')).toMatchObject({ text: 'hello there' });
  });

  it('runs a tool, feeds the result back and continues', async () => {
    registerPinned();
    model.script.push({ tool: { name: 'builtin__echo', args: '{"text":"hi"}' } }, { text: 'It said hi' });
    const before = model.requests.length;
    const { runId, events } = await modelPinned({ tools: ['builtin__echo'] });
    const types = events.map(e => e.type);
    expect(types).toEqual(['run.started', 'tool.started', 'tool.completed', 'message.delta', 'run.completed']);
    expect(events.find(e => e.type === 'tool.completed')).toMatchObject({ status: 'completed', outcome: 'ok', summary: 'hi' });

    // Second model request carries the assistant tool call and the tool result, correctly paired.
    const second = model.requests[before + 1].messages;
    const assistant = second.find((m: any) => m.tool_calls);
    const toolMsg = second.find((m: any) => m.role === 'tool');
    expect(assistant.tool_calls[0].function.arguments).toBe('{"text":"hi"}');
    expect(toolMsg.tool_call_id).toBe(assistant.tool_calls[0].id);
    expect(toolMsg.content).toBe('hi');

    const row = getDb().prepare('SELECT status, outcome FROM chat_tool_calls WHERE run_id = ?').get(runId) as any;
    expect(row).toMatchObject({ status: 'completed', outcome: 'ok' });
    expect((getDb().prepare('SELECT status FROM chat_runs WHERE id = ?').get(runId) as any).status).toBe('completed');
  });

  it('rejects invalid arguments before executing and keeps going', async () => {
    registerPinned();
    model.script.push({ tool: { name: 'builtin__echo', args: '{"wrong":1}' } }, { text: 'sorry' });
    const { events } = await modelPinned({ tools: ['builtin__echo'] });
    expect(events.find(e => e.type === 'tool.completed')).toMatchObject({ status: 'failed', outcome: 'error' });
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'completed' });
  });

  it('waits for approval, then runs; denial skips execution', async () => {
    let executed = 0;
    const gated: ToolDefinition = {
      name: 'test__gated', description: 'gated', parameters: { type: 'object', properties: {} },
      source: 'builtin', approval: 'always', idempotent: false,
      execute: async () => { executed += 1; return { content: 'ran' }; },
    };
    if (!getToolRegistry().get('test__gated')) getToolRegistry().register(gated);

    for (const approve of [true, false]) {
      const before = executed;
      model.script.push({ tool: { name: 'test__gated', args: '{}' } }, { text: 'ok' });
      const events: RunEvent[] = [];
      let id = '';
      const done = startRun({
        conversationId, userId, chatUrl: model.url, apiKey: 'k', model: 'auto-x',
        messages: [{ role: 'user', content: 'go' }], toolNames: ['test__gated'],
        emit: e => {
          events.push(e);
          if (e.type === 'run.started') id = e.runId;
          if (e.type === 'tool.approval_required') queueMicrotask(() => resolveApproval(id, userId, e.callId, approve));
        },
      });
      await done;
      expect(events.some(e => e.type === 'tool.approval_required')).toBe(true);
      expect(executed - before).toBe(approve ? 1 : 0);
      expect(events.find(e => e.type === 'tool.completed')).toMatchObject({ status: approve ? 'completed' : 'denied' });
    }
  });

  it('refuses approval answers from another account', async () => {
    expect(resolveApproval('nope', userId + 1, 'c', true)).toBe(false);
    expect(cancelRun('nope', userId)).toBe(false);
  });

  it('cancels a running tool cleanly', async () => {
    let aborted = false;
    const slow: ToolDefinition = {
      name: 'test__slow', description: 'slow', parameters: { type: 'object', properties: {} },
      source: 'builtin', approval: 'never', idempotent: true,
      execute: (_a, ctx) => new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
      }),
    };
    if (!getToolRegistry().get('test__slow')) getToolRegistry().register(slow);
    model.script.push({ tool: { name: 'test__slow', args: '{}' } });
    const events: RunEvent[] = [];
    let id = '';
    await startRun({
      conversationId, userId, chatUrl: model.url, apiKey: 'k', model: 'auto-x',
      messages: [{ role: 'user', content: 'go' }], toolNames: ['test__slow'],
      emit: e => {
        events.push(e);
        if (e.type === 'run.started') id = e.runId;
        if (e.type === 'tool.started') setTimeout(() => cancelRun(id, userId), 10);
      },
    });
    expect(aborted).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run.completed', status: 'cancelled' });
    expect((getDb().prepare('SELECT status FROM chat_runs WHERE id = ?').get(id) as any).status).toBe('cancelled');
  });

  it('records a lost non-idempotent call as uncertain and tells the model', async () => {
    const lossy: ToolDefinition = {
      name: 'test__lossy', description: 'lossy', parameters: { type: 'object', properties: {} },
      source: 'builtin', approval: 'never', idempotent: false,
      execute: async () => { throw new ToolOutcomeUncertainError('connection lost'); },
    };
    if (!getToolRegistry().get('test__lossy')) getToolRegistry().register(lossy);
    model.script.push({ tool: { name: 'test__lossy', args: '{}' } }, { text: 'noted' });
    const before = model.requests.length;
    const { events } = await modelPinned2(['test__lossy']);
    expect(events.find(e => e.type === 'tool.completed')).toMatchObject({ status: 'failed', outcome: 'uncertain' });
    const toolMsg = model.requests[before + 1].messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/do not repeat/);
  });

  it('marks runs left running by a restart as failed', () => {
    getDb().prepare("INSERT INTO chat_runs (id, conversation_id, status, started_at_ms) VALUES ('stale', ?, 'running', ?)")
      .run(conversationId, Date.now());
    getDb().prepare("INSERT INTO chat_tool_calls (run_id, call_id, tool_name, status) VALUES ('stale', 'c', 't', 'running')").run();
    expect(failInterruptedRuns()).toBeGreaterThanOrEqual(1);
    expect(getDb().prepare("SELECT status FROM chat_runs WHERE id = 'stale'").get()).toMatchObject({ status: 'failed' });
    expect(getDb().prepare("SELECT outcome FROM chat_tool_calls WHERE run_id = 'stale'").get()).toMatchObject({ outcome: 'uncertain' });
  });

  it('cascades run data when the conversation is deleted', () => {
    getDb().prepare("INSERT INTO chat_runs (id, conversation_id, status, started_at_ms) VALUES ('gone', ?, 'completed', ?)")
      .run(conversationId, Date.now());
    getDb().prepare('PRAGMA foreign_keys = ON').run();
    const c2 = Number(getDb().prepare(
      'INSERT INTO playground_conversations (user_id, title, messages_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?)',
    ).run(userId, 'x', '[]', 1, 1).lastInsertRowid);
    getDb().prepare("INSERT INTO chat_runs (id, conversation_id, status, started_at_ms) VALUES ('c2run', ?, 'completed', 1)").run(c2);
    getDb().prepare('DELETE FROM playground_conversations WHERE id = ?').run(c2);
    expect(getDb().prepare("SELECT 1 FROM chat_runs WHERE id = 'c2run'").get()).toBeUndefined();
  });

  // `auto` needs a tool-capable catalog model; these tests pin a model name instead.
  function registerPinned(): void { /* builtin tools are registered in beforeAll */ }
  async function modelPinned2(tools: string[]) {
    const events: RunEvent[] = [];
    await startRun({
      conversationId, userId, chatUrl: model.url, apiKey: 'k', model: 'pinned',
      messages: [{ role: 'user', content: 'x' }], toolNames: tools, emit: e => events.push(e),
    });
    return { events };
  }

  describe('MCP client', () => {
    it('connects, registers namespaced tools honouring policy, and calls them', async () => {
      const mcp = await startFakeMcp();
      try {
        const now = Date.now();
        const id = Number(getDb().prepare(`
          INSERT INTO mcp_servers (user_id, name, transport, url, enabled, allow_private, default_policy, tool_policy_json, created_at_ms, updated_at_ms)
          VALUES (?, 'fake', 'http', ?, 1, 1, 'allow', '{"secret":"deny"}', ?, ?)
        `).run(userId, mcp.url, now, now).lastInsertRowid);
        const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow;
        const status = await syncServer(row);
        expect(status).toMatchObject({ ok: true, tools: 1 });
        expect(mcp.calls).toEqual(expect.arrayContaining(['initialize', 'notifications/initialized', 'tools/list']));

        const tool = getToolRegistry().get(`m${id}__ping`)!;
        expect(tool).toBeDefined();
        expect(tool.ownerUserId).toBe(userId);
        expect(tool.approval).toBe('never');
        expect(getToolRegistry().get(`m${id}__secret`)).toBeUndefined();

        const ctx = { runId: 'r', conversationId, userId, signal: new AbortController().signal, attachments: [], knowledgeBaseIds: [] };
        await expect(tool.execute({ who: 'bob' }, ctx)).resolves.toMatchObject({ content: 'pong bob' });
        await expect(tool.execute({ who: 'bob' }, { ...ctx, userId: userId + 1 })).resolves.toMatchObject({ isError: true });
      } finally {
        mcp.close();
      }
    });

    it('blocks a private address unless the server allows it', async () => {
      const mcp = await startFakeMcp();
      try {
        const now = Date.now();
        const id = Number(getDb().prepare(`
          INSERT INTO mcp_servers (user_id, name, transport, url, enabled, allow_private, default_policy, created_at_ms, updated_at_ms)
          VALUES (?, 'priv', 'http', ?, 1, 0, 'ask', ?, ?)
        `).run(userId, mcp.url, now, now).lastInsertRowid);
        const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow;
        const status = await syncServer(row);
        expect(status.ok).toBe(false);
        expect(status.error).toMatch(/blocked/i);
        expect(mcp.calls).toHaveLength(0);
      } finally {
        mcp.close();
      }
    });
  });

  describe('knowledge base', () => {
    let baseId: number;
    beforeAll(() => {
      baseId = Number(getDb().prepare(
        'INSERT INTO kb_bases (user_id, name, created_at_ms, updated_at_ms) VALUES (?, ?, 1, 1)',
      ).run(userId, 'docs').lastInsertRowid);
    });

    it('indexes, retrieves with page numbers, replaces and deletes', async () => {
      const r1 = enqueueDocument(baseId, {
        name: 'sales.txt', mimeType: 'text/plain',
        pages: [
          { page: 1, text: 'Quarterly revenue grew twelve percent in March driven by enterprise renewals.' },
          { page: 2, text: 'The cafeteria menu changes every Tuesday and includes soup.' },
        ],
      });
      expect(r1.kind).toBe('queued');
      await processQueue();
      const doc = getDb().prepare('SELECT status, chunk_count FROM kb_documents WHERE base_id = ?').get(baseId) as any;
      expect(doc).toMatchObject({ status: 'ready' });
      expect(doc.chunk_count).toBeGreaterThan(0);
      expect(getDb().prepare('SELECT embedding_family, dimensions FROM kb_bases WHERE id = ?').get(baseId))
        .toMatchObject({ embedding_family: 'test-family', dimensions: 32 });

      const hit = await searchKnowledge({ userId, baseIds: [baseId], query: 'revenue growth in March' });
      expect(hit.passages.length).toBeGreaterThan(0);
      expect(hit.passages[0].text).toMatch(/revenue/i);
      expect(hit.passages[0].page).toBe(1);
      expect(hit.passages[0].id).toMatch(/^kb:\d+#\d+$/);

      // Identical re-upload is a no-op.
      expect(enqueueDocument(baseId, {
        name: 'sales.txt', mimeType: 'text/plain',
        pages: [
          { page: 1, text: 'Quarterly revenue grew twelve percent in March driven by enterprise renewals.' },
          { page: 2, text: 'The cafeteria menu changes every Tuesday and includes soup.' },
        ],
      }).kind).toBe('unchanged');

      // Replacing removes stale content.
      enqueueDocument(baseId, { name: 'sales.txt', mimeType: 'text/plain', pages: [{ page: 1, text: 'Completely different text about giraffes.' }] });
      await processQueue();
      const after = await searchKnowledge({ userId, baseIds: [baseId], query: 'revenue growth in March' });
      expect(after.passages.some(p => /revenue/i.test(p.text))).toBe(false);

      // Deleting removes it from retrieval.
      getDb().prepare('PRAGMA foreign_keys = ON').run();
      getDb().prepare('DELETE FROM kb_documents WHERE base_id = ?').run(baseId);
      const gone = await searchKnowledge({ userId, baseIds: [baseId], query: 'giraffes' });
      expect(gone.passages).toHaveLength(0);
    });

    it('does not search another account\'s base', async () => {
      const out = await searchKnowledge({ userId: userId + 99, baseIds: [baseId], query: 'anything' });
      expect(out).toEqual({ passages: [], evidence: 'none' });
    });
  });
});
