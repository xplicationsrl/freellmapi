// FreeLLMAPI sandbox worker: runs untrusted Python in a locked-down container.
//
// Separate process, separate trust boundary. It is the ONLY component that
// talks to the container daemon; the main server just POSTs jobs here. It has
// no provider keys and no access to the application database.
//
// No dependencies: Node 20+ and the `docker` CLI.
//
//   SANDBOX_WORKER_TOKEN   required, bearer token the main server presents
//   SANDBOX_IMAGE          runtime image (default freellmapi-sandbox:1)
//   SANDBOX_PORT           listen port (default 8787)
//   SANDBOX_HOST           listen host (default 127.0.0.1)
//   SANDBOX_MAX_JOBS       concurrent jobs (default 2)
//   SANDBOX_WORK_ROOT      host directory for job workspaces (default os tmpdir)
//
// Run it on the HOST (not inside a container) so the bind-mounted workspace
// path means the same thing to the daemon.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.env.SANDBOX_WORKER_TOKEN ?? '';
const IMAGE = process.env.SANDBOX_IMAGE || 'freellmapi-sandbox:1';
const PORT = Number(process.env.SANDBOX_PORT || 8787);
const HOST = process.env.SANDBOX_HOST || '127.0.0.1';
const MAX_JOBS = Number(process.env.SANDBOX_MAX_JOBS || 2);
const WORK_ROOT = process.env.SANDBOX_WORK_ROOT || os.tmpdir();

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_FILES_OUT = 10;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_OUT_BYTES = 10 * 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const LABEL = 'freellm-sandbox=1';

if (TOKEN.length < 16) {
  console.error('SANDBOX_WORKER_TOKEN must be set (16+ characters)');
  process.exit(1);
}

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.csv': 'text/csv', '.txt': 'text/plain', '.json': 'application/json', '.md': 'text/markdown',
  '.html': 'text/html', '.pdf': 'application/pdf',
};

const running = new Map(); // job id -> container name

function authorised(req) {
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeName(name) {
  const base = path.basename(String(name)).replace(/[^\w.\- ]+/g, '_').trim();
  return (base && base !== '.' && base !== '..' ? base : 'file').slice(0, 120);
}

function docker(args, { timeoutMs } = {}) {
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const cap = (buf, chunk) => (buf.length >= MAX_OUTPUT_BYTES ? buf : Buffer.concat([buf, chunk]).subarray(0, MAX_OUTPUT_BYTES));
    child.stdout.on('data', c => { stdout = cap(stdout, c); });
    child.stderr.on('data', c => { stderr = cap(stderr, c); });
    let timedOut = false;
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs) : null;
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, stdout: '', stderr: error.message, timedOut: false });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'), timedOut });
    });
  });
}

async function killContainer(name) {
  await docker(['kill', name]);
}

function collectOutputs(dir, skip) {
  const files = [];
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (files.length >= MAX_FILES_OUT) break;
    if (!entry.isFile() || skip.has(entry.name)) continue; // no symlinks, no directories
    const full = path.join(dir, entry.name);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES || total + stat.size > MAX_TOTAL_OUT_BYTES) continue;
    total += stat.size;
    files.push({
      name: entry.name,
      mimeType: MIME[path.extname(entry.name).toLowerCase()] ?? 'application/octet-stream',
      dataBase64: fs.readFileSync(full).toString('base64'),
    });
  }
  return files;
}

async function runJob(job) {
  const started = Date.now();
  const name = `fl-sbx-${job.id}`;
  const dir = fs.mkdtempSync(path.join(WORK_ROOT, 'flsbx-'));
  try {
    // The workspace is private to this job; the container user (nobody) must
    // be able to write to it.
    fs.chmodSync(dir, 0o777);
    const skip = new Set(['main.py']);
    for (const f of job.files) {
      const fileName = safeName(f.name);
      fs.writeFileSync(path.join(dir, fileName), Buffer.from(f.dataBase64, 'base64'), { mode: 0o644 });
      skip.add(fileName);
    }
    fs.writeFileSync(path.join(dir, 'main.py'), job.code, { mode: 0o644 });

    running.set(job.id, name);
    const args = [
      'run', '--rm', '--name', name, '--label', LABEL,
      '--network', 'none',
      '--read-only',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '128',
      '--memory', '512m', '--memory-swap', '512m',
      '--cpus', '1',
      '--ulimit', 'fsize=10485760',
      '--user', '65534:65534',
      '-v', `${dir}:/work:rw`,
      '-w', '/work',
      '-e', 'MPLBACKEND=Agg', '-e', 'HOME=/tmp', '-e', 'MPLCONFIGDIR=/tmp',
      IMAGE, 'python', 'main.py',
    ];
    const result = await docker(args, { timeoutMs: job.timeoutMs });
    let status = 'completed';
    if (!running.has(job.id)) status = 'cancelled';
    else if (result.timedOut) { status = 'timeout'; await killContainer(name); }
    else if (result.code !== 0) status = 'failed';

    return {
      status,
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      files: status === 'cancelled' ? [] : collectOutputs(dir, skip),
      image: IMAGE,
      durationMs: Date.now() - started,
    };
  } finally {
    running.delete(job.id);
    await docker(['rm', '-f', name]); // no-op when --rm already removed it
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (!authorised(req)) return send(res, 401, { error: 'unauthorised' });
    const url = new URL(req.url ?? '/', 'http://x');

    if (req.method === 'GET' && url.pathname === '/health') {
      const inspect = await docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE], { timeoutMs: 5000 });
      return send(res, 200, { ok: inspect.code === 0, image: IMAGE, jobs: running.size });
    }

    if (req.method === 'POST' && url.pathname === '/jobs') {
      if (running.size >= MAX_JOBS) return send(res, 429, { error: 'worker busy' });
      const body = JSON.parse(await readBody(req));
      if (!/^[0-9a-f-]{36}$/i.test(String(body.id ?? ''))) return send(res, 400, { error: 'bad id' });
      if (body.language !== 'python') return send(res, 400, { error: 'unsupported language' });
      if (typeof body.code !== 'string' || body.code.length > 100_000) return send(res, 400, { error: 'bad code' });
      const files = Array.isArray(body.files) ? body.files.slice(0, 5) : [];
      const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(body.timeoutMs) || 30_000));
      const out = await runJob({ id: body.id, code: body.code, files, timeoutMs });
      return send(res, 200, out);
    }

    const del = /^\/jobs\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (req.method === 'DELETE' && del) {
      const name = running.get(del[1]);
      if (name) {
        running.delete(del[1]); // marks the job cancelled
        await killContainer(name);
      }
      return send(res, 200, { ok: true });
    }

    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : 'error' });
  }
});

// Containers left behind by a crash are removed at start-up.
const leftovers = await docker(['ps', '-aq', '--filter', `label=${LABEL}`]);
for (const id of leftovers.stdout.split('\n').map(s => s.trim()).filter(Boolean)) {
  await docker(['rm', '-f', id]);
}

server.listen(PORT, HOST, () => {
  console.log(`sandbox worker on http://${HOST}:${PORT} (image ${IMAGE}, max ${MAX_JOBS} jobs)`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    for (const name of running.values()) await killContainer(name);
    process.exit(0);
  });
}
