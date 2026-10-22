import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';
import {
  MEMORY_CONTEXT_BUDGET,
  buildProjectContext,
  projectIdForConversation,
} from '../../services/project-memory.js';

async function request(
  app: Express,
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

describe('project memory', () => {
  let app: Express;
  let token: string;
  let userId: number;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken('project-memory@example.com');
  });

  beforeEach(async () => {
    getDb().prepare('DELETE FROM playground_conversations').run();
    getDb().prepare('DELETE FROM playground_projects').run();
    const created = await request(app, 'POST', '/api/projects', { token, body: { name: 'tmp' } });
    const owner = getDb()
      .prepare('SELECT user_id FROM playground_projects WHERE id = ?')
      .get(created.body.id) as { user_id: number };
    userId = owner.user_id;
    getDb().prepare('DELETE FROM playground_projects').run();
  });

  async function newProject(name = 'Atlas') {
    const res = await request(app, 'POST', '/api/projects', { token, body: { name } });
    expect(res.status).toBe(201);
    return res.body.id as number;
  }

  it('stores instructions and returns them with the memories', async () => {
    const id = await newProject();
    const put = await request(app, 'PUT', `/api/projects/${id}/instructions`, {
      token,
      body: { instructions: '  Reply in British English.  ' },
    });
    expect(put.status).toBe(200);
    expect(put.body.instructions).toBe('Reply in British English.');

    const got = await request(app, 'GET', `/api/projects/${id}/memory`, { token });
    expect(got.body).toEqual({ instructions: 'Reply in British English.', memories: [] });
  });

  it('adds, dedupes, pins, edits and deletes facts', async () => {
    const id = await newProject();
    const first = await request(app, 'POST', `/api/projects/${id}/memory`, {
      token,
      body: { content: 'Deploys go through Fly.io' },
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ pinned: false, source: 'manual' });

    const dup = await request(app, 'POST', `/api/projects/${id}/memory`, {
      token,
      body: { content: 'deploys go through fly.io', source: 'auto' },
    });
    expect(dup.status).toBe(200);
    expect(dup.body.id).toBe(first.body.id);

    const pinned = await request(app, 'PUT', `/api/projects/${id}/memory/${first.body.id}`, {
      token,
      body: { pinned: true, content: 'Deploys use Fly.io' },
    });
    expect(pinned.body).toMatchObject({ pinned: true, content: 'Deploys use Fly.io' });

    const del = await request(app, 'DELETE', `/api/projects/${id}/memory/${first.body.id}`, { token });
    expect(del.status).toBe(200);
    const gone = await request(app, 'DELETE', `/api/projects/${id}/memory/${first.body.id}`, { token });
    expect(gone.status).toBe(404);
  });

  it('keeps projects of other accounts closed', async () => {
    const id = await newProject();
    const other = mintDashboardToken('someone-else@example.com');
    expect((await request(app, 'GET', `/api/projects/${id}/memory`, { token: other })).status).toBe(404);
    expect((await request(app, 'POST', `/api/projects/${id}/memory`, {
      token: other, body: { content: 'x' },
    })).status).toBe(404);
    expect((await request(app, 'PUT', `/api/projects/${id}/instructions`, {
      token: other, body: { instructions: 'x' },
    })).status).toBe(404);
  });

  it('cascades memories when the project is deleted', async () => {
    const id = await newProject();
    await request(app, 'POST', `/api/projects/${id}/memory`, { token, body: { content: 'fact' } });
    await request(app, 'DELETE', `/api/projects/${id}`, { token });
    const left = getDb().prepare('SELECT COUNT(*) AS n FROM playground_project_memories').get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('builds context with the brief, pinned facts first, within the budget', async () => {
    const id = await newProject('Atlas');
    expect(buildProjectContext(id, userId)).toBeNull();

    await request(app, 'PUT', `/api/projects/${id}/instructions`, { token, body: { instructions: 'Be terse.' } });
    await request(app, 'POST', `/api/projects/${id}/memory`, { token, body: { content: 'older note' } });
    await request(app, 'POST', `/api/projects/${id}/memory`, { token, body: { content: 'pinned note', pinned: true } });

    const ctx = buildProjectContext(id, userId)!;
    expect(ctx).toContain('"Atlas"');
    expect(ctx).toContain('Be terse.');
    expect(ctx.indexOf('pinned note')).toBeLessThan(ctx.indexOf('older note'));

    for (let i = 0; i < 12; i++) {
      await request(app, 'POST', `/api/projects/${id}/memory`, {
        token, body: { content: `${i}-${'x'.repeat(480)}` },
      });
    }
    const big = buildProjectContext(id, userId)!;
    const noteChars = big.split('\n').filter(l => l.startsWith('- ')).join('').length;
    expect(noteChars).toBeLessThanOrEqual(MEMORY_CONTEXT_BUDGET + 2 * 20);
    expect(big).toContain('pinned note');
    expect(buildProjectContext(id, userId + 999)).toBeNull();
  });

  it('resolves a conversation to its project only for the owner', async () => {
    const id = await newProject();
    const convo = await request(app, 'POST', '/api/conversations', {
      token, body: { title: 'c', projectId: id },
    });
    expect(projectIdForConversation(convo.body.id, userId)).toBe(id);
    expect(projectIdForConversation(convo.body.id, userId + 999)).toBeNull();
  });
});
