// Persistence for conversation runs and their tool calls (chat_runs,
// chat_tool_calls, chat_artifacts; see migration 20261021_000001). Plain
// statements, no logic: the orchestrator owns the lifecycle.

import { getDb } from '../../db/index.js';
import type {
  RunErrorCode,
  RunStatus,
  ToolCallOutcome,
  ToolCallStatus,
} from '@freellmapi/shared/conversation-events.js';

export interface RunRow {
  id: string;
  conversation_id: number;
  status: RunStatus;
  model: string | null;
  rounds: number;
  error_code: string | null;
  error_message: string | null;
  started_at_ms: number;
  finished_at_ms: number | null;
}

export interface ToolCallRow {
  id: number;
  run_id: string;
  call_id: string;
  round: number;
  tool_name: string;
  source: string;
  arguments_json: string;
  status: ToolCallStatus;
  outcome: ToolCallOutcome;
  result_json: string | null;
  error_code: string | null;
  error_message: string | null;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

export function createRun(runId: string, conversationId: number, model: string | null): void {
  getDb().prepare(`
    INSERT INTO chat_runs (id, conversation_id, status, model, started_at_ms)
    VALUES (?, ?, 'running', ?, ?)
  `).run(runId, conversationId, model, Date.now());
}

export function updateRunProgress(runId: string, rounds: number, model: string | null): void {
  getDb().prepare('UPDATE chat_runs SET rounds = ?, model = COALESCE(?, model) WHERE id = ?')
    .run(rounds, model, runId);
}

export function finishRun(
  runId: string,
  status: Exclude<RunStatus, 'running'>,
  error?: { code: RunErrorCode; message: string },
): void {
  getDb().prepare(`
    UPDATE chat_runs
       SET status = ?, error_code = ?, error_message = ?, finished_at_ms = ?
     WHERE id = ? AND status = 'running'
  `).run(status, error?.code ?? null, error?.message.slice(0, 2000) ?? null, Date.now(), runId);
}

/**
 * A run still 'running' after a restart has no process behind it. Mark it
 * failed, and any tool call that was mid-flight `uncertain` (it may have taken
 * effect). Called once at start-up.
 */
export function failInterruptedRuns(): number {
  const db = getDb();
  const now = Date.now();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE chat_tool_calls
         SET status = 'failed', outcome = 'uncertain',
             error_code = 'interrupted', finished_at_ms = ?
       WHERE status = 'running'
         AND run_id IN (SELECT id FROM chat_runs WHERE status = 'running')
    `).run(now);
    db.prepare(`
      UPDATE chat_tool_calls
         SET status = 'cancelled', finished_at_ms = ?
       WHERE status IN ('pending', 'awaiting_approval')
         AND run_id IN (SELECT id FROM chat_runs WHERE status = 'running')
    `).run(now);
    return db.prepare(`
      UPDATE chat_runs
         SET status = 'failed', error_code = 'internal',
             error_message = 'Interrupted by a server restart', finished_at_ms = ?
       WHERE status = 'running'
    `).run(now).changes;
  });
  return tx() as number;
}

export function insertToolCall(row: {
  runId: string;
  callId: string;
  round: number;
  toolName: string;
  source: string;
  argumentsJson: string;
  status: ToolCallStatus;
}): number {
  const res = getDb().prepare(`
    INSERT INTO chat_tool_calls (run_id, call_id, round, tool_name, source, arguments_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.runId, row.callId, row.round, row.toolName, row.source, row.argumentsJson, row.status);
  return Number(res.lastInsertRowid);
}

export function updateToolCall(
  runId: string,
  callId: string,
  patch: {
    status: ToolCallStatus;
    outcome?: ToolCallOutcome;
    resultJson?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    started?: boolean;
    finished?: boolean;
  },
): void {
  const now = Date.now();
  getDb().prepare(`
    UPDATE chat_tool_calls
       SET status = ?,
           outcome = COALESCE(?, outcome),
           result_json = COALESCE(?, result_json),
           error_code = COALESCE(?, error_code),
           error_message = COALESCE(?, error_message),
           started_at_ms = CASE WHEN ? = 1 THEN ? ELSE started_at_ms END,
           finished_at_ms = CASE WHEN ? = 1 THEN ? ELSE finished_at_ms END
     WHERE run_id = ? AND call_id = ?
  `).run(
    patch.status,
    patch.outcome ?? null,
    patch.resultJson ?? null,
    patch.errorCode ?? null,
    patch.errorMessage?.slice(0, 2000) ?? null,
    patch.started ? 1 : 0, now,
    patch.finished ? 1 : 0, now,
    runId, callId,
  );
}

/** A run with its tool calls, scoped to the owner of the conversation. */
export function getRunForUser(runId: string, userId: number): { run: RunRow; toolCalls: ToolCallRow[] } | null {
  const db = getDb();
  const run = db.prepare(`
    SELECT r.* FROM chat_runs r
      JOIN playground_conversations c ON c.id = r.conversation_id
     WHERE r.id = ? AND c.user_id = ?
  `).get(runId, userId) as RunRow | undefined;
  if (!run) return null;
  const toolCalls = db.prepare(
    'SELECT * FROM chat_tool_calls WHERE run_id = ? ORDER BY round, id',
  ).all(runId) as ToolCallRow[];
  return { run, toolCalls };
}

/** True when the conversation exists and belongs to the user. */
export function conversationBelongsTo(conversationId: number, userId: number): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS ok FROM playground_conversations WHERE id = ? AND user_id = ?')
    .get(conversationId, userId) as { ok: number } | undefined;
  return !!row;
}

/** Knowledge bases linked to the conversation's project folder (owner's only). */
export function projectKnowledgeBaseIds(conversationId: number, userId: number): number[] {
  const rows = getDb().prepare(`
    SELECT pk.base_id
      FROM playground_conversations c
      JOIN playground_project_knowledge pk ON pk.project_id = c.project_id
      JOIN kb_bases b ON b.id = pk.base_id AND b.user_id = c.user_id
     WHERE c.id = ? AND c.user_id = ?
     ORDER BY pk.base_id
  `).all(conversationId, userId) as { base_id: number }[];
  return rows.map(r => r.base_id);
}

export function insertArtifact(row: {
  id: string;
  runId: string;
  toolCallRowId: number | null;
  name: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storagePath: string;
  expiresAtMs: number | null;
}): void {
  getDb().prepare(`
    INSERT INTO chat_artifacts
      (id, run_id, tool_call_id, name, mime_type, size_bytes, sha256, storage_path, created_at_ms, expires_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id, row.runId, row.toolCallRowId, row.name, row.mimeType,
    row.sizeBytes, row.sha256, row.storagePath, Date.now(), row.expiresAtMs,
  );
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  expires_at_ms: number | null;
}

export function getArtifactForUser(artifactId: string, userId: number): ArtifactRow | null {
  const row = getDb().prepare(`
    SELECT a.* FROM chat_artifacts a
      JOIN chat_runs r ON r.id = a.run_id
      JOIN playground_conversations c ON c.id = r.conversation_id
     WHERE a.id = ? AND c.user_id = ?
  `).get(artifactId, userId) as ArtifactRow | undefined;
  return row ?? null;
}
