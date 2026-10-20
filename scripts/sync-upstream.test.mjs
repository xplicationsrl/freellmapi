import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'sync-upstream.sh');
let dir;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd, file, content, msg) {
  writeFileSync(join(cwd, file), content);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', msg);
}

function setup(name) {
  const up = join(dir, `${name}-up`);
  const fork = join(dir, `${name}-fork`);
  git(dir, 'init', '-q', '-b', 'main', up);
  for (const c of [up]) { git(c, 'config', 'user.email', 't@t'); git(c, 'config', 'user.name', 't'); }
  commit(up, 'shared.txt', 'base\n', 'base');
  git(dir, 'clone', '-q', up, fork);
  git(fork, 'config', 'user.email', 't@t');
  git(fork, 'config', 'user.name', 't');
  return { up, fork };
}

function sync(fork, up) {
  const out = execFileSync('bash', [SCRIPT], { cwd: fork, encoding: 'utf8', env: { ...process.env, UPSTREAM_URL: up, GITHUB_OUTPUT: '' } });
  return Object.fromEntries(out.trim().split('\n').map(l => l.split(/=(.*)/s).slice(0, 2)));
}

describe('sync-upstream.sh', () => {
  before(() => { dir = mkdtempSync(join(tmpdir(), 'sync-')); });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('reports uptodate when upstream has nothing new', () => {
    const { up, fork } = setup('a');
    assert.deepEqual(sync(fork, up), { result: 'uptodate', behind: '0' });
  });

  it('merges new upstream commits, keeping fork-only work', () => {
    const { up, fork } = setup('b');
    commit(fork, 'fork.txt', 'mine\n', 'fork work');
    commit(up, 'provider.txt', 'new provider\n', 'feat(providers): add X');
    const r = sync(fork, up);
    assert.deepEqual(r, { result: 'merged', behind: '1' });
    assert.equal(readFileSync(join(fork, 'provider.txt'), 'utf8'), 'new provider\n');
    assert.equal(readFileSync(join(fork, 'fork.txt'), 'utf8'), 'mine\n');
    assert.match(git(fork, 'log', '-1', '--format=%s'), /chore\(sync\): merge upstream main \(1 commits\)/);
    assert.deepEqual(sync(fork, up), { result: 'uptodate', behind: '0' });
  });

  it('keeps the fork version where both sides edited the same lines', () => {
    const { up, fork } = setup('e');
    commit(fork, 'shared.txt', 'fork edit\n', 'fork edit');
    commit(up, 'shared.txt', 'upstream edit\n', 'upstream edit');
    commit(up, 'provider.txt', 'new provider\n', 'feat(providers): add Y');
    assert.deepEqual(sync(fork, up), { result: 'merged', behind: '2' });
    assert.equal(readFileSync(join(fork, 'shared.txt'), 'utf8'), 'fork edit\n');
    assert.equal(readFileSync(join(fork, 'provider.txt'), 'utf8'), 'new provider\n');
    assert.deepEqual(sync(fork, up), { result: 'uptodate', behind: '0' });
  });

  it('SYNC_PREFER=none conflicts on overlapping edits and aborts cleanly', () => {
    const { up, fork } = setup('c');
    commit(fork, 'shared.txt', 'fork edit\n', 'fork edit');
    commit(up, 'shared.txt', 'upstream edit\n', 'upstream edit');
    const head = git(fork, 'rev-parse', 'HEAD');
    process.env.SYNC_PREFER = 'none';
    let r;
    try { r = sync(fork, up); } finally { delete process.env.SYNC_PREFER; }
    assert.equal(r.result, 'conflict');
    assert.equal(r.files, 'shared.txt');
    assert.equal(git(fork, 'rev-parse', 'HEAD'), head);
    assert.equal(git(fork, 'status', '--porcelain'), '');
  });

  it('structural conflict (fork deleted, upstream edited) aborts even with fork preferred', () => {
    const { up, fork } = setup('f');
    git(fork, 'rm', '-q', 'shared.txt');
    git(fork, 'commit', '-q', '-m', 'fork removes file');
    commit(up, 'shared.txt', 'upstream edit\n', 'upstream edit');
    const head = git(fork, 'rev-parse', 'HEAD');
    const r = sync(fork, up);
    assert.equal(r.result, 'conflict');
    assert.equal(r.files, 'shared.txt');
    assert.equal(git(fork, 'rev-parse', 'HEAD'), head);
    assert.equal(git(fork, 'status', '--porcelain'), '');
  });

  it('refuses a dirty working tree', () => {
    const { up, fork } = setup('d');
    writeFileSync(join(fork, 'shared.txt'), 'dirty\n');
    assert.throws(() => sync(fork, up), /uncommitted/);
  });
});
