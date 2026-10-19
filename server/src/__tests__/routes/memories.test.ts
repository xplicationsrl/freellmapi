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

describe('playground memories', () => {
  let app: Express;
  let dashToken: string;
  let otherToken: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    getUnifiedApiKey();
    dashToken = mintDashboardToken('memories@example.com');
    otherToken = mintDashboardToken('other-memories@example.com');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM playground_memories').run();
  });

  it('creates, lists, updates and deletes a memory', async () => {
    const created = await request(app, 'POST', '/api/memories', {
      token: dashToken,
      body: { content: 'User prefers TypeScript' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ content: 'User prefers TypeScript' });
    expect(created.body.id).toBeGreaterThan(0);

    const list = await request(app, 'GET', '/api/memories', { token: dashToken });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const updated = await request(app, 'PUT', `/api/memories/${created.body.id}`, {
      token: dashToken,
      body: { content: 'User prefers Rust' },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.content).toBe('User prefers Rust');

    const del = await request(app, 'DELETE', `/api/memories/${created.body.id}`, { token: dashToken });
    expect(del.status).toBe(200);
    expect((await request(app, 'GET', '/api/memories', { token: dashToken })).body).toEqual([]);
  });

  it('dedupes the same content case-insensitively', async () => {
    const first = await request(app, 'POST', '/api/memories', {
      token: dashToken,
      body: { content: 'Lives in Bucharest' },
    });
    expect(first.status).toBe(201);

    const second = await request(app, 'POST', '/api/memories', {
      token: dashToken,
      body: { content: 'lives in bucharest' },
    });
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);

    const list = await request(app, 'GET', '/api/memories', { token: dashToken });
    expect(list.body).toHaveLength(1);
  });

  it('hides another account\'s memories', async () => {
    const created = await request(app, 'POST', '/api/memories', {
      token: dashToken,
      body: { content: 'Private fact' },
    });
    expect(created.status).toBe(201);

    const otherList = await request(app, 'GET', '/api/memories', { token: otherToken });
    expect(otherList.status).toBe(200);
    expect(otherList.body).toEqual([]);

    // PUT/DELETE from another account must 404 the same way an unknown id does.
    const steal = await request(app, 'PUT', `/api/memories/${created.body.id}`, {
      token: otherToken,
      body: { content: 'Hijacked' },
    });
    expect(steal.status).toBe(404);
  });

  it('rejects empty content', async () => {
    const res = await request(app, 'POST', '/api/memories', {
      token: dashToken,
      body: { content: '   ' },
    });
    expect(res.status).toBe(400);
  });
});
