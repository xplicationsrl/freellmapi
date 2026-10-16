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

const server = http.createServer((req, res) => {
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
