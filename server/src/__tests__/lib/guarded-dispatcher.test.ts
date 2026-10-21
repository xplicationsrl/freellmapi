import dns from 'node:dns';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from 'undici';
import { createGuardedLookup, assessAddress } from '../../lib/url-guard.js';
import { getGuardedDispatcher, resetGuardedDispatcher } from '../../lib/guarded-dispatcher.js';
import { proxyFetch } from '../../lib/proxy.js';

const answer = (...addresses: string[]) =>
  async () => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));

/** Run a lookup to completion, as net.connect would, and return what it called back with. */
function lookup(fn: ReturnType<typeof createGuardedLookup>, host: string, options: dns.LookupOptions = {}) {
  return new Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }>(resolve => {
    fn(host, options, (err, address, family) => resolve({ err, address, family }));
  });
}

describe('assessAddress', () => {
  it('always refuses metadata and link-local, and private ranges only on request', () => {
    expect(assessAddress('169.254.169.254', false).allowed).toBe(false);
    expect(assessAddress('fe80::1', false).allowed).toBe(false);
    expect(assessAddress('::ffff:169.254.169.254', false).allowed).toBe(false);
    expect(assessAddress('10.0.0.5', false).allowed).toBe(true);
    expect(assessAddress('10.0.0.5', true).allowed).toBe(false);
    expect(assessAddress('127.0.0.1', true).reason).toContain('FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS');
    expect(assessAddress('93.184.216.34', true).allowed).toBe(true);
  });
});

describe('createGuardedLookup', () => {
  it('returns the addresses it resolved, in the shape net asked for', async () => {
    const guarded = createGuardedLookup({ resolve: answer('93.184.216.34', '2606:2800::1'), blockPrivate: () => false });
    expect((await lookup(guarded, 'api.example.com', { all: true })).address).toEqual([
      { address: '93.184.216.34', family: 4 }, { address: '2606:2800::1', family: 6 },
    ]);
    const single = await lookup(guarded, 'api.example.com');
    expect(single).toMatchObject({ err: null, address: '93.184.216.34', family: 4 });
  });

  it('refuses a name that resolves to cloud metadata', async () => {
    const guarded = createGuardedLookup({ resolve: answer('169.254.169.254'), blockPrivate: () => false });
    const { err } = await lookup(guarded, 'rebind.example', { all: true });
    expect(err?.code).toBe('ERR_BLOCKED_ADDRESS');
    expect(err?.message).toContain('cloud metadata');
  });

  it('refuses the whole lookup when ANY address is refused, not just the first', async () => {
    const guarded = createGuardedLookup({ resolve: answer('93.184.216.34', '169.254.169.254'), blockPrivate: () => false });
    expect((await lookup(guarded, 'mixed.example', { all: true })).err?.code).toBe('ERR_BLOCKED_ADDRESS');
    expect((await lookup(guarded, 'mixed.example')).err?.code).toBe('ERR_BLOCKED_ADDRESS');
  });

  it('applies the private-range switch at lookup time', async () => {
    let block = false;
    const guarded = createGuardedLookup({ resolve: answer('192.168.1.20'), blockPrivate: () => block });
    expect((await lookup(guarded, 'lan.example')).err).toBeNull();
    block = true;
    expect((await lookup(guarded, 'lan.example')).err?.code).toBe('ERR_BLOCKED_ADDRESS');
  });

  it('passes resolver errors through, forwards the family, and accepts the legacy numeric options', async () => {
    const failing = createGuardedLookup({ resolve: async () => { throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' }); } });
    expect((await lookup(failing, 'missing.example')).err?.code).toBe('ENOTFOUND');

    const seen: dns.LookupOptions[] = [];
    const spying = createGuardedLookup({
      resolve: async (_host, options) => { seen.push(options); return [{ address: '93.184.216.34', family: 4 }]; },
      blockPrivate: () => false,
    });
    await lookup(spying, 'a.example', { family: 6 });
    await new Promise<void>(resolve => (spying as unknown as (h: string, o: number, cb: () => void) => void)('a.example', 4, resolve));
    expect(seen[0]).toMatchObject({ family: 6, all: true, verbatim: true });
    expect(seen[1]).toMatchObject({ family: 4, all: true });
  });
});

describe('an Agent whose connect uses the guarded lookup', () => {
  let server: http.Server;
  let port: number;
  let hits: number;

  beforeEach(async () => {
    hits = 0;
    server = http.createServer((_req, res) => { hits++; res.end('reached the server'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  });

  it('connects to the address the lookup returned for a name that has no real DNS record', async () => {
    const agent = new Agent({ connect: { lookup: createGuardedLookup({ resolve: answer('127.0.0.1'), blockPrivate: () => false }) } });
    const res = await fetch(`http://pinned.example:${port}/`, { dispatcher: agent } as RequestInit);
    expect(await res.text()).toBe('reached the server');
    await agent.close();
  });

  it('never opens a connection when the lookup refuses the address', async () => {
    const agent = new Agent({ connect: { lookup: createGuardedLookup({ resolve: answer('127.0.0.1'), blockPrivate: () => true }) } });
    const failure = await fetch(`http://pinned.example:${port}/`, { dispatcher: agent } as RequestInit).catch(e => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('ERR_BLOCKED_ADDRESS');
    expect(hits).toBe(0);
    await agent.close();
  });
});

describe('proxyFetch for a custom provider under DNS rebinding', () => {
  let server: http.Server;
  let port: number;
  let hits: number;

  beforeEach(async () => {
    hits = 0;
    server = http.createServer((_req, res) => { hits++; res.end('internal service'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetGuardedDispatcher();
    await new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  });

  /** A resolver that answers the pre-flight check with a public address and every later lookup with loopback. */
  function rebindingDns() {
    let calls = 0;
    return vi.spyOn(dns.promises, 'lookup').mockImplementation((async () => {
      calls++;
      return [{ address: calls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    }) as unknown as typeof dns.promises.lookup);
  }

  it('refuses the connection when the name is re-pointed at a blocked address after the check', async () => {
    vi.stubEnv('FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS', 'true');
    const spy = rebindingDns();

    const failure = await proxyFetch(`http://rebind.example:${port}/v1`, {}, 'custom', 'chat', 5000).catch(e => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('ERR_BLOCKED_ADDRESS');
    expect(hits).toBe(0);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // the check AND the connect-time lookup
  });

  it('still reaches a local server the policy allows (the guard is not a blanket block)', async () => {
    const spy = rebindingDns();

    const res = await proxyFetch(`http://rebind.example:${port}/v1`, {}, 'custom', 'chat', 5000);

    expect(await res.text()).toBe('internal service');
    expect(hits).toBe(1);
    expect(spy).toHaveBeenCalled();
  });

  it('gives an untrusted link on any platform the same protection', async () => {
    vi.stubEnv('FREEAPI_BLOCK_PRIVATE_PROVIDER_URLS', 'true');
    rebindingDns();

    const failure = await proxyFetch(`http://rebind.example:${port}/image.png`, {}, 'siliconflow', 'image', 5000, { untrustedTarget: true }).catch(e => e);

    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('ERR_BLOCKED_ADDRESS');
    expect(hits).toBe(0);
  });

  it('does not follow a redirect from an untrusted link', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => { hits++; res.writeHead(302, { Location: 'http://169.254.169.254/latest/' }); res.end(); });
    rebindingDns();

    const failure = await proxyFetch(`http://rebind.example:${port}/image.png`, {}, 'siliconflow', 'image', 5000, { untrustedTarget: true }).catch(e => e);

    expect(String((failure as Error).message)).toContain('redirect');
  });

  it('builds one shared dispatcher and rebuilds it after a reset', async () => {
    const first = await getGuardedDispatcher();
    expect(first).not.toBeNull();
    expect(await getGuardedDispatcher()).toBe(first);
    resetGuardedDispatcher();
    expect(await getGuardedDispatcher()).not.toBe(first);
  });
});
