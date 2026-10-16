// Creates or updates one backend instance per user from a JSON document on
// stdin, then (re)starts them all under pm2 together with the router.
//
//   { "alice": { "admin": {"email": "...", "password": "..."},
//                "keys": [{"platform": "groq", "key": "gsk_..."}] },
//     "bob":   { ... } }
//
// Each value is a FreeLLMAPI declarative config (see FREEAPI_CONFIG_JSON in
// .env.example): keys are upserted on every boot, the admin account is created
// only while that instance has no account yet.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const INSTANCES = path.join(ROOT, 'instances');
const REGISTRY = path.join(INSTANCES, 'registry.json');
const ECOSYSTEM = path.join(INSTANCES, 'ecosystem.config.cjs');
const FIRST_PORT = 3100;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NODE = process.env.FREELLMAPI_NODE ?? path.join(os.homedir(), '.local/node22/bin/node');

function writePrivate(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const wanted = input.users ?? input;
const names = Object.keys(wanted);
if (names.length === 0) throw new Error('no users in input');
for (const name of names) {
  if (!NAME_RE.test(name)) throw new Error(`invalid user name "${name}" (use a-z, 0-9, -)`);
}

fs.mkdirSync(INSTANCES, { recursive: true, mode: 0o700 });
const registry = fs.existsSync(REGISTRY) ? JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) : { users: {} };
const usedPorts = new Set(Object.values(registry.users).map((u) => u.port));
let nextPort = FIRST_PORT;

for (const name of names) {
  const dir = path.join(INSTANCES, name);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true, mode: 0o700 });

  if (!registry.users[name]) {
    while (usedPorts.has(nextPort)) nextPort++;
    registry.users[name] = { port: nextPort };
    usedPorts.add(nextPort);
  }
  const { port } = registry.users[name];

  // The encryption key is minted once; replacing it would orphan stored keys.
  const envFile = path.join(dir, '.env');
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const key = /^ENCRYPTION_KEY=(\w+)$/m.exec(existing)?.[1] ?? crypto.randomBytes(32).toString('hex');
  writePrivate(envFile, [
    'NODE_ENV=production',
    `ENCRYPTION_KEY=${key}`,
    `PORT=${port}`,
    'HOST=127.0.0.1',
    'TRUST_PROXY=1',
    `FREEAPI_DB_PATH=${path.join(dir, 'data', 'freeapi.db')}`,
    `FREEAPI_CONFIG_PATH=${path.join(dir, 'config.json')}`,
    'REQUEST_ANALYTICS_RETENTION_DAYS=90',
    'REQUEST_ANALYTICS_MAX_ROWS=100000',
    '',
  ].join('\n'));
  writePrivate(path.join(dir, 'config.json'), JSON.stringify(wanted[name], null, 2));
}

writePrivate(REGISTRY, JSON.stringify(registry, null, 2));

const apps = [
  {
    name: 'freellmapi-router',
    script: path.join(ROOT, 'deploy', 'router.mjs'),
    interpreter: NODE,
  },
  ...Object.keys(registry.users).map((name) => ({
    name: `freellmapi-${name}`,
    cwd: path.join(ROOT, 'server'),
    script: 'dist/index.js',
    interpreter: NODE,
    env: { FREEAPI_ENV_PATH: path.join(INSTANCES, name, '.env') },
    max_memory_restart: '1G',
  })),
];
writePrivate(ECOSYSTEM, `module.exports = ${JSON.stringify({ apps }, null, 2)};\n`);

execFileSync('pm2', ['startOrRestart', ECOSYSTEM, '--update-env'], { stdio: 'inherit' });
execFileSync('pm2', ['save'], { stdio: 'inherit' });

const stale = Object.keys(registry.users).filter((n) => !names.includes(n));
console.log(`[provision] ${names.length} user(s) applied: ${names.join(', ')}`);
if (stale.length) console.log(`[provision] not in input, left running: ${stale.join(', ')}`);
