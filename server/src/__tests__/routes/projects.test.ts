import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

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

describe('playground projects', () => {
  let app: Express;
  let dashToken: string;
  let unifiedKey: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    unifiedKey = getUnifiedApiKey();
    dashToken = mintDashboardToken('projects@example.com');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM playground_conversations').run();
    getDb().prepare('DELETE FROM playground_projects').run();
  });

  async function createProject(name = 'Alpha') {
    const res = await request(app, 'POST', '/api/projects', { token: dashToken, body: { name } });
    expect(res.status).toBe(201);
    return res.body;
  }

  it('creates, lists, renames and deletes a project', async () => {
    const created = await createProject('Research');
    expect(created).toMatchObject({ name: 'Research' });
    expect(created.id).toBeGreaterThan(0);

    const list = await request(app, 'GET', '/api/projects', { token: dashToken });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].name).toBe('Research');

    const renamed = await request(app, 'PUT', `/api/projects/${created.id}`, {
      token: dashToken,
      body: { name: 'Lab' },
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Lab');

    const del = await request(app, 'DELETE', `/api/projects/${created.id}`, { token: dashToken });
    expect(del.status).toBe(200);
    expect((await request(app, 'GET', '/api/projects', { token: dashToken })).body).toEqual([]);
  });

  it('moves a conversation into a project and unassigns it when the project is deleted', async () => {
    const project = await createProject('Folder');
    const convo = await request(app, 'POST', '/api/conversations', {
      token: dashToken,
      body: { title: 'chat', projectId: project.id },
    });
    expect(convo.status).toBe(201);
    expect(convo.body.projectId).toBe(project.id);

    const listed = await request(app, 'GET', '/api/conversations', { token: dashToken });
    expect(listed.body[0].projectId).toBe(project.id);

    await request(app, 'DELETE', `/api/projects/${project.id}`, { token: dashToken });
    const after = await request(app, 'GET', '/api/conversations', { token: dashToken });
    expect(after.body[0].projectId).toBeNull();
  });

  it('rejects a project id that belongs to another account', async () => {
    const otherToken = mintDashboardToken('other-projects@example.com');
    const theirs = await request(app, 'POST', '/api/projects', {
      token: otherToken,
      body: { name: 'Theirs' },
    });
    expect(theirs.status).toBe(201);

    const bad = await request(app, 'POST', '/api/conversations', {
      token: dashToken,
      body: { title: 'x', projectId: theirs.body.id },
    });
    expect(bad.status).toBe(400);
  });

  it('the unified /v1 key does not open the projects API', async () => {
    const { status } = await request(app, 'GET', '/api/projects', { token: unifiedKey });
    expect(status).toBe(401);
  });
});
