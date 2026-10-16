// Applies the shared install's config from a JSON document on stdin, then
// restarts the backend so it takes effect.
//
//   { "users": [{"email": "...", "password": "..."}, ...],
//     "keys":  [{"platform": "groq", "key": "gsk_...", "label": "main"}] }
//
// This is a FreeLLMAPI declarative config (see FREEAPI_CONFIG_JSON in
// .env.example). Every user signs in to the same install and shares its keys.
// Missing accounts are created on boot; existing ones are never changed, and
// keys are upserted by platform + label.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG = path.join(ROOT, 'server', 'data', 'config.json');
const ENV_FILE = path.join(ROOT, '.env');
const APP = 'freellmapi';

const config = JSON.parse(fs.readFileSync(0, 'utf8'));
if (!Array.isArray(config.users) || config.users.length === 0) {
  throw new Error('config needs a non-empty "users" list');
}

fs.mkdirSync(path.dirname(CONFIG), { recursive: true, mode: 0o700 });
fs.writeFileSync(CONFIG, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.chmodSync(CONFIG, 0o600);

// Point the backend at the config file once.
const env = fs.readFileSync(ENV_FILE, 'utf8');
if (!/^FREEAPI_CONFIG_PATH=/m.test(env)) {
  fs.appendFileSync(ENV_FILE, `${env.endsWith('\n') ? '' : '\n'}FREEAPI_CONFIG_PATH=${CONFIG}\n`);
}

execFileSync('pm2', ['restart', APP, '--update-env'], { stdio: 'inherit' });
execFileSync('pm2', ['save'], { stdio: 'inherit' });
console.log(`[provision] ${config.users.length} user(s), ${(config.keys ?? []).length} key(s) applied`);
