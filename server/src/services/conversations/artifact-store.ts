// Files a run produces (sandbox output, charts). Bytes live on disk under
// <data dir>/artifacts/<run id>/<artifact id>; the chat_artifacts row keeps the
// path, size and hash. Artifacts outlive the execution environment that made
// them and expire after a retention window.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDefaultDbPath } from '../../db/index.js';
import { getDb } from '../../db/index.js';
import { insertArtifact } from './run-store.js';

export const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function artifactRoot(): string {
  return path.join(path.dirname(path.resolve(getDefaultDbPath())), 'artifacts');
}

/** Keep only a safe file name: no directories, no control characters. */
export function safeArtifactName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ]+/g, '_').trim();
  return (base || 'file').slice(0, 120);
}

export interface StoredArtifact {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export function storeArtifact(options: {
  runId: string;
  toolCallRowId: number | null;
  name: string;
  mimeType: string;
  data: Buffer;
}): StoredArtifact {
  if (options.data.length > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const id = crypto.randomUUID();
  const dir = path.join(artifactRoot(), options.runId.replace(/[^\w-]/g, ''));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, id);
  fs.writeFileSync(file, options.data, { mode: 0o600 });
  const name = safeArtifactName(options.name);
  insertArtifact({
    id,
    runId: options.runId,
    toolCallRowId: options.toolCallRowId,
    name,
    mimeType: options.mimeType,
    sizeBytes: options.data.length,
    sha256: crypto.createHash('sha256').update(options.data).digest('hex'),
    storagePath: file,
    expiresAtMs: Date.now() + ARTIFACT_RETENTION_MS,
  });
  return { id, name, mimeType: options.mimeType, sizeBytes: options.data.length };
}

/** Delete expired artifact files and rows. Safe to call on a timer. */
export function purgeExpiredArtifacts(now = Date.now()): number {
  const db = getDb();
  const rows = db.prepare(
    'SELECT id, storage_path FROM chat_artifacts WHERE expires_at_ms IS NOT NULL AND expires_at_ms < ?',
  ).all(now) as { id: string; storage_path: string }[];
  const root = artifactRoot();
  for (const row of rows) {
    // Only ever unlink inside the artifact root, whatever the row says.
    const resolved = path.resolve(row.storage_path);
    if (resolved.startsWith(root + path.sep)) {
      try { fs.rmSync(resolved, { force: true }); } catch { /* already gone */ }
    }
    db.prepare('DELETE FROM chat_artifacts WHERE id = ?').run(row.id);
  }
  return rows.length;
}
