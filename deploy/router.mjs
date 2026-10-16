// Front door for per-user instances. /u/<name>/... is forwarded, prefix
// stripped, to that user's backend; anything else goes to the default one.
// The name -> port map is instances/registry.json, re-read when it changes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const REGISTRY = path.join(ROOT, 'instances', 'registry.json');
const PORT = Number(process.env.ROUTER_PORT ?? 3010);
const DEFAULT_PORT = Number(process.env.DEFAULT_BACKEND_PORT ?? 3011);
const PREFIX_RE = /^\/u\/([a-z0-9-]+)(\/.*)?$/;

let cache = { mtimeMs: -1, users: {} };
function registry() {
  try {
    const { mtimeMs } = fs.statSync(REGISTRY);
    if (mtimeMs !== cache.mtimeMs) {
      cache = { mtimeMs, users: JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).users ?? {} };
    }
  } catch {
    cache = { mtimeMs: -1, users: {} };
  }
  return cache.users;
}

function reply(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'routing_error' } }));
}

// The root dashboard is a shared sign-in page: it never offers first-run
// setup, and its login is sent to whichever instance owns that email.
const ROOT_STATUS = JSON.stringify({ needsSetup: false, authenticated: false, email: null, desktop: false });
const MAX_LOGIN_BODY = 64 * 1024;

function instanceForEmail(email) {
  const wanted = String(email ?? '').trim().toLowerCase();
  if (!wanted) return null;
  for (const [name, user] of Object.entries(registry())) {
    if (user.email && user.email.toLowerCase() === wanted) return { name, port: user.port };
  }
  return null;
}

function directoryLogin(req, res) {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_LOGIN_BODY) req.destroy();
    else chunks.push(chunk);
  });
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    let email = null;
    try { email = JSON.parse(body.toString('utf8')).email; } catch { /* instance rejects it */ }
    // An unknown email still goes to an instance, so the reply is the same
    // "Invalid email or password" and does not reveal which emails exist.
    const target = instanceForEmail(email);
    // Uncompressed, so the reply can be read and tagged with the instance.
    const headers = { ...req.headers, 'content-length': String(body.length), 'accept-encoding': 'identity' };
    const upstream = http.request(
      { host: '127.0.0.1', port: target?.port ?? DEFAULT_PORT, method: 'POST', path: '/api/auth/login', headers },
      (up) => {
        const out = [];
        up.on('data', (c) => out.push(c));
        up.on('end', () => {
          let payload = Buffer.concat(out);
          const ok = (up.statusCode ?? 500) < 300;
          if (ok && target) {
            try { payload = Buffer.from(JSON.stringify({ ...JSON.parse(payload.toString('utf8')), instance: target.name })); } catch { /* pass through */ }
          }
          console.log(`POST /api/auth/login -> ${target ? target.name : 'none'} ${up.statusCode}`);
          const outHeaders = { ...up.headers, 'content-length': String(payload.length) };
          delete outHeaders['transfer-encoding'];
          res.writeHead(up.statusCode ?? 502, outHeaders);
          res.end(payload);
        });
      },
    );
    upstream.on('error', () => reply(res, 502, 'instance is not running'));
    upstream.end(body);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(ROOT_STATUS);
  }
  if (pathname === '/api/auth/login' && req.method === 'POST') return directoryLogin(req, res);

  let port = DEFAULT_PORT;
  let target = req.url;
  const match = PREFIX_RE.exec(req.url.split('?')[0]);
  if (match) {
    const user = registry()[match[1]];
    if (!user) return reply(res, 404, `unknown instance: ${match[1]}`);
    port = user.port;
    target = req.url.slice(`/u/${match[1]}`.length) || '/';
  }

  const upstream = http.request(
    { host: '127.0.0.1', port, method: req.method, path: target, headers: req.headers },
    (up) => {
      console.log(`${req.method} ${req.url.split('?')[0]} -> :${port} ${up.statusCode}`);
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (!res.headersSent) reply(res, 502, 'instance is not running');
    else res.destroy();
  });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[router] listening on 127.0.0.1:${PORT}, default backend :${DEFAULT_PORT}`);
});
