// POST /v1/images/generations with response_format "b64_json": a provider that
// answers with a link has the file downloaded and returned inline, under the
// same SSRF and size rules as any server-side fetch of a provider-supplied URL.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';

const realFetch = globalThis.fetch;
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let server: Server;
let baseUrl: string;
let token: string;

beforeEach(async () => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const s = encrypt('siliconflow-media-key');
  getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('siliconflow', 'test', ?, ?, ?, 'healthy', 1)`).run(s.encrypted, s.iv, s.authTag);
  getDb().prepare(`INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label, key_id, meta_json)
    VALUES ('siliconflow', 'FLUX', 'FLUX', 'image', 1, 1, '', NULL, NULL)`).run();
  token = getUnifiedApiKey();
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
});

/** Upstream: the provider API answers with `link`; GET of the link answers with `file`. */
function upstream(link: string, file: () => Response) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('api.siliconflow.com')) {
      return new Response(JSON.stringify({ images: [{ url: link }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return file();
  }) as unknown as typeof fetch;
  return calls;
}

function generate(body: Record<string, unknown>) {
  return realFetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat', ...body }),
  });
}

const image = (type = 'image/png', extra: Record<string, string> = {}) =>
  () => new Response(PNG, { status: 200, headers: { 'Content-Type': type, ...extra } });

describe('image generation response_format', () => {
  it('returns the link untouched by default', async () => {
    const calls = upstream('https://cdn.example.com/cat.png', image());
    const res = await generate({});
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ url: 'https://cdn.example.com/cat.png' }]);
    expect(calls.some(u => u.includes('cdn.example.com'))).toBe(false);
  });

  it('downloads the file and returns base64 when b64_json is requested', async () => {
    const calls = upstream('https://cdn.example.com/cat.png', image());
    const res = await generate({ response_format: 'b64_json' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual([{ b64_json: PNG.toString('base64') }]);
    expect(calls.some(u => u === 'https://cdn.example.com/cat.png')).toBe(true);
  });

  it('refuses a link that points at cloud metadata, without fetching it', async () => {
    const calls = upstream('http://169.254.169.254/latest/meta-data/', image());
    const res = await generate({ response_format: 'b64_json' });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain('refused');
    expect(calls.some(u => u.includes('169.254.169.254'))).toBe(false);
  });

  it('rejects a link that is not an image', async () => {
    upstream('https://cdn.example.com/page', image('text/html'));
    const res = await generate({ response_format: 'b64_json' });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain('did not return an image');
  });

  it('rejects a file over the size cap, by declared length', async () => {
    upstream('https://cdn.example.com/huge.png', image('image/png', { 'Content-Length': String(50 * 1024 * 1024) }));
    const res = await generate({ response_format: 'b64_json' });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain('too large');
  });

  it('reports a failed download as a 502', async () => {
    upstream('https://cdn.example.com/gone.png', () => new Response('nope', { status: 404 }));
    const res = await generate({ response_format: 'b64_json' });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain('HTTP 404');
  });
});
