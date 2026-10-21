// Conversation orchestrator: drives one assistant run.
//
//   build messages -> pick a capable model -> stream the reply -> assemble tool
//   calls -> validate, approve and execute them -> append results -> continue,
//   until the model answers without tools, the run is cancelled, or a limit hits.
//
// The orchestrator sits ABOVE the provider router. Model calls go through the
// server's own /v1/chat/completions over loopback, so routing, failover,
// cooldowns, compression and the cache behave exactly as for any client. Tool
// execution records live in chat_tool_calls, independent of provider retries:
// a model call that fails is retried by the router without touching the tools,
// and a tool call that completed is never executed again within the run.

import crypto from 'node:crypto';
import type {
  RunErrorCode,
  RunEvent,
  ToolCallOutcome,
} from '@freellmapi/shared/conversation-events.js';
import { buildModelListing } from '../model-listing.js';
import {
  getToolRegistry,
  ToolArgumentError,
  type RunAttachment,
  ToolOutcomeUncertainError,
  toOpenAiTool,
  type ToolDefinition,
} from '../tools/registry.js';
import { storeArtifact } from './artifact-store.js';
import {
  createRun,
  finishRun,
  insertToolCall,
  updateRunProgress,
  updateToolCall,
} from './run-store.js';

export const DEFAULT_MAX_ROUNDS = 6;
export const DEFAULT_MAX_RUN_MS = 180_000;
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
export const MAX_TOOL_RESULT_CHARS = 12_000;
const MAX_TOOL_CALLS_PER_ROUND = 8;

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface RunOptions {
  conversationId: number;
  userId: number;
  /** Loopback URL of this server's /v1/chat/completions. */
  chatUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessageIn[];
  /** Tool names the conversation enabled. Empty or omitted = no tools. */
  toolNames?: string[];
  /** Files attached to this run, readable by tools (the code sandbox). */
  attachments?: RunAttachment[];
  /** Knowledge bases enabled for this conversation. */
  knowledgeBaseIds?: number[];
  maxRounds?: number;
  maxRunMs?: number;
  toolTimeoutMs?: number;
  temperature?: number;
  maxTokens?: number;
  emit: (event: RunEvent) => void;
}

interface ActiveRun {
  runId: string;
  userId: number;
  controller: AbortController;
  approvals: Map<string, (approved: boolean) => void>;
}

const activeRuns = new Map<string, ActiveRun>();

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

/** Cancel a run owned by `userId`. Returns false when it is not active. */
export function cancelRun(runId: string, userId: number): boolean {
  const run = activeRuns.get(runId);
  if (!run || run.userId !== userId) return false;
  run.controller.abort();
  return true;
}

/** Answer a pending approval. Returns false when nothing is waiting. */
export function resolveApproval(runId: string, userId: number, callId: string, approved: boolean): boolean {
  const run = activeRuns.get(runId);
  if (!run || run.userId !== userId) return false;
  const settle = run.approvals.get(callId);
  if (!settle) return false;
  run.approvals.delete(callId);
  settle(approved);
  return true;
}

/** Abort every active run (graceful shutdown). */
export function abortAllRuns(): void {
  for (const run of activeRuns.values()) run.controller.abort();
}

class RunFailure extends Error {
  constructor(public code: RunErrorCode, message: string) {
    super(message);
    this.name = 'RunFailure';
  }
}

interface AssembledToolCall {
  callId: string;
  name: string;
  argumentsText: string;
}

interface ModelRound {
  content: string;
  reasoning: string;
  toolCalls: AssembledToolCall[];
  model: string | null;
  finishReason: string | null;
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: string }).name === 'AbortError';
}

function truncateResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated ${text.length - MAX_TOOL_RESULT_CHARS} characters]`;
}

function summarize(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= 240 ? flat : `${flat.slice(0, 240)}…`;
}

/**
 * Only models that can take tools are eligible when tools are offered. A
 * specific model choice is honoured as-is; `auto` is resolved to the best
 * model that can serve a tool call right now.
 */
export function resolveRunModel(requested: string, needsTools: boolean): string {
  const wanted = requested.trim();
  if (!needsTools || (wanted !== '' && wanted !== 'auto')) return wanted || 'auto';
  const { models } = buildModelListing();
  const pick = models.find(m => m.supportsTools && m.available === 1 && m.executionStatus === 'ready');
  if (!pick) {
    throw new RunFailure('no_capable_model', 'No tool-capable model is available right now');
  }
  return pick.id;
}

async function readModelStream(
  response: Response,
  onDelta: (text: string) => void,
  onReasoning: (text: string) => void,
): Promise<ModelRound> {
  const reader = response.body?.getReader();
  if (!reader) throw new RunFailure('provider_exhausted', 'Model response had no body');
  const decoder = new TextDecoder();
  let buffer = '';
  const round: ModelRound = { content: '', reasoning: '', toolCalls: [], model: null, finishReason: null };
  const partial = new Map<number, { id: string; name: string; args: string }>();

  const handleFrame = (frame: string): boolean => {
    const data = frame
      .split(/\r\n|\r|\n/)
      .map(l => l.trim())
      .filter(l => l.startsWith('data:'))
      .map(l => l.slice(5).trim())
      .join('\n');
    if (!data) return false;
    if (data === '[DONE]') return true;
    let chunk: {
      model?: unknown;
      error?: { message?: unknown };
      choices?: {
        delta?: {
          content?: unknown;
          reasoning_content?: unknown;
          tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
        finish_reason?: unknown;
      }[];
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      return false;
    }
    if (chunk.error) {
      throw new RunFailure('provider_exhausted', String(chunk.error.message ?? 'Upstream error'));
    }
    if (typeof chunk.model === 'string') round.model = chunk.model;
    const choice = chunk.choices?.[0];
    if (!choice) return false;
    const delta = choice.delta;
    if (typeof delta?.content === 'string' && delta.content) {
      round.content += delta.content;
      onDelta(delta.content);
    }
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content) {
      round.reasoning += delta.reasoning_content;
      onReasoning(delta.reasoning_content);
    }
    for (const tc of delta?.tool_calls ?? []) {
      const index = typeof tc.index === 'number' ? tc.index : 0;
      const cur = partial.get(index) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      partial.set(index, cur);
    }
    if (typeof choice.finish_reason === 'string') round.finishReason = choice.finish_reason;
    return false;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let sep: RegExpExecArray | null;
    while ((sep = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, sep.index);
      buffer = buffer.slice(sep.index + sep[0].length);
      if (handleFrame(frame)) {
        buffer = '';
        break;
      }
    }
    if (done) {
      if (buffer.trim()) handleFrame(buffer);
      break;
    }
  }

  round.toolCalls = [...partial.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({ callId: v.id, name: v.name, argumentsText: v.args }))
    .filter(tc => tc.name);
  return round;
}

async function callModel(
  opts: RunOptions,
  model: string,
  messages: ChatMessageIn[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  onDelta: (text: string) => void,
  onReasoning: (text: string) => void,
): Promise<ModelRound> {
  const body: Record<string, unknown> = { model, messages, stream: true };
  if (tools.length > 0) body.tools = tools.map(toOpenAiTool);
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens;

  const response = await fetch(opts.chatUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(await response.text()) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === 'string') message = parsed.error.message;
    } catch { /* keep the status line */ }
    throw new RunFailure('provider_exhausted', message);
  }
  return readModelStream(response, onDelta, onReasoning);
}

function waitForApproval(active: ActiveRun, callId: string, signal: AbortSignal): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
    const onAbort = () => finish(false);
    const finish = (approved: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      active.approvals.delete(callId);
      resolve(approved);
    };
    active.approvals.set(callId, finish);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface ToolExecution {
  message: ChatMessageIn;
}

async function executeToolCall(
  opts: RunOptions,
  active: ActiveRun,
  runId: string,
  round: number,
  call: AssembledToolCall,
  signal: AbortSignal,
  emit: (e: RunEvent) => void,
): Promise<ToolExecution> {
  const registry = getToolRegistry();
  const tool = registry.get(call.name);
  const reply = (content: string): ToolExecution => ({
    message: { role: 'tool', tool_call_id: call.callId, name: call.name, content: truncateResult(content) },
  });
  const source = tool?.source ?? 'builtin';

  let args: unknown = {};
  try {
    args = call.argumentsText.trim() ? JSON.parse(call.argumentsText) : {};
  } catch {
    args = null;
  }

  const rowId = insertToolCall({
    runId,
    callId: call.callId,
    round,
    toolName: call.name,
    source,
    argumentsJson: call.argumentsText.slice(0, 20_000) || '{}',
    status: 'pending',
  });

  const fail = (
    status: 'failed' | 'denied' | 'cancelled',
    outcome: ToolCallOutcome,
    code: string,
    message: string,
  ): ToolExecution => {
    updateToolCall(runId, call.callId, {
      status, outcome, errorCode: code, errorMessage: message, finished: true,
    });
    emit({ type: 'tool.completed', runId, callId: call.callId, status, outcome, summary: summarize(message) });
    return reply(`Error: ${message}`);
  };

  if (!tool) return fail('failed', 'error', 'unknown_tool', `Unknown tool: ${call.name}`);

  let validated: Record<string, unknown>;
  try {
    validated = registry.validateArguments(call.name, args);
  } catch (error) {
    const message = error instanceof ToolArgumentError ? error.message : 'Invalid arguments';
    return fail('failed', 'error', 'invalid_arguments', message);
  }

  if (tool.approval === 'always') {
    updateToolCall(runId, call.callId, { status: 'awaiting_approval' });
    emit({
      type: 'tool.approval_required',
      runId, callId: call.callId, name: call.name, source: tool.source, arguments: validated,
    });
    const approved = await waitForApproval(active, call.callId, signal);
    if (signal.aborted) return fail('cancelled', 'unknown', 'cancelled', 'Run cancelled before approval');
    if (!approved) return fail('denied', 'unknown', 'denied', 'The user denied this action');
  }

  updateToolCall(runId, call.callId, { status: 'running', started: true });
  emit({
    type: 'tool.started',
    runId, callId: call.callId, name: call.name, source: tool.source, arguments: validated,
  });

  const timeoutMs = opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const toolController = new AbortController();
  const timer = setTimeout(() => toolController.abort(new Error('timeout')), timeoutMs);
  const onRunAbort = () => toolController.abort(signal.reason);
  signal.addEventListener('abort', onRunAbort, { once: true });

  try {
    const result = await tool.execute(validated, {
      attachments: opts.attachments ?? [],
      knowledgeBaseIds: opts.knowledgeBaseIds ?? [],
      runId,
      conversationId: opts.conversationId,
      userId: opts.userId,
      signal: toolController.signal,
      addArtifact: artifact => {
        const stored = storeArtifact({ runId, toolCallRowId: rowId, ...artifact });
        emit({ type: 'artifact.created', runId, callId: call.callId, artifact: stored });
      },
      addCitation: citation => emit({ type: 'citation.added', runId, citation }),
    });
    const outcome: ToolCallOutcome = result.isError ? 'error' : 'ok';
    updateToolCall(runId, call.callId, {
      status: result.isError ? 'failed' : 'completed',
      outcome,
      resultJson: JSON.stringify({ content: truncateResult(result.content) }),
      finished: true,
    });
    emit({
      type: 'tool.completed',
      runId, callId: call.callId,
      status: result.isError ? 'failed' : 'completed',
      outcome,
      summary: summarize(result.content),
    });
    return reply(result.content);
  } catch (error) {
    const aborted = toolController.signal.aborted;
    const timedOut = aborted && !signal.aborted;
    // A call that may have taken effect is never repeated: record it as
    // uncertain when the tool says so, or when a non-idempotent call was cut off.
    const uncertain = error instanceof ToolOutcomeUncertainError || (aborted && !tool.idempotent);
    const outcome: ToolCallOutcome = uncertain ? 'uncertain' : 'error';
    const message = timedOut
      ? `Tool timed out after ${timeoutMs} ms`
      : error instanceof Error ? error.message : 'Tool failed';
    if (signal.aborted) {
      return fail('cancelled', outcome, 'cancelled', 'Run cancelled while the tool was running');
    }
    return fail('failed', outcome, timedOut ? 'timeout' : 'tool_error',
      uncertain ? `${message} (the action may have been applied; do not repeat it)` : message);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onRunAbort);
  }
}

/**
 * Run one assistant turn to completion. Always ends with exactly one terminal
 * event (`run.completed` or `run.failed`) and a matching chat_runs update.
 * Resolves with the run id.
 */
export async function startRun(opts: RunOptions): Promise<string> {
  const runId = crypto.randomUUID();
  const controller = new AbortController();
  const active: ActiveRun = { runId, userId: opts.userId, controller, approvals: new Map() };
  activeRuns.set(runId, active);
  const { signal } = controller;

  let terminal = false;
  const emit = (event: RunEvent): void => {
    if (terminal) return;
    if (event.type === 'run.completed' || event.type === 'run.failed') terminal = true;
    try { opts.emit(event); } catch { /* a closed client must not stop the run's bookkeeping */ }
  };

  const maxRunMs = opts.maxRunMs ?? DEFAULT_MAX_RUN_MS;
  const deadline = setTimeout(() => controller.abort(new RunFailure('timeout', 'Run time limit reached')), maxRunMs);

  createRun(runId, opts.conversationId, null);
  emit({ type: 'run.started', runId, conversationId: opts.conversationId });

  try {
    const registry = getToolRegistry();
    const allow = new Set(opts.toolNames ?? []);
    const lastUser = [...opts.messages].reverse().find(m => m.role === 'user');
    const hint = typeof lastUser?.content === 'string' ? lastUser.content : '';
    const tools = allow.size > 0 ? registry.select({ allow, hint }) : [];
    const model = resolveRunModel(opts.model, tools.length > 0);
    updateRunProgress(runId, 0, model);

    const messages: ChatMessageIn[] = [...opts.messages];
    const maxRounds = Math.max(1, opts.maxRounds ?? DEFAULT_MAX_ROUNDS);

    for (let round = 0; round < maxRounds; round += 1) {
      if (signal.aborted) throw signal.reason ?? Object.assign(new Error('Aborted'), { name: 'AbortError' });

      const modelRound = await callModel(
        opts, model, messages, tools, signal,
        text => emit({ type: 'message.delta', runId, text }),
        text => emit({ type: 'message.reasoning', runId, text }),
      );
      updateRunProgress(runId, round + 1, modelRound.model);

      if (modelRound.toolCalls.length === 0) {
        finishRun(runId, 'completed');
        emit({ type: 'run.completed', runId, status: 'completed' });
        return runId;
      }

      // Our own call ids, stable across provider changes and unique per run:
      // models reuse or omit ids, and a message history must pair each result
      // with exactly one call.
      const calls = modelRound.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND).map((c, i) => ({
        ...c,
        callId: `call_${round}_${i}_${crypto.randomBytes(4).toString('hex')}`,
      }));

      messages.push({
        role: 'assistant',
        content: modelRound.content || null,
        tool_calls: calls.map(c => ({
          id: c.callId,
          type: 'function',
          function: { name: c.name, arguments: c.argumentsText || '{}' },
        })),
      });

      // Sequential on purpose: results must be appended in call order, and
      // approvals are asked one at a time.
      for (const call of calls) {
        const executed = await executeToolCall(opts, active, runId, round, call, signal, emit);
        messages.push(executed.message);
        if (signal.aborted) break;
      }
    }

    throw new RunFailure('max_rounds', `Stopped after ${maxRounds} tool rounds`);
  } catch (error) {
    if (signal.aborted) {
      const reason = signal.reason;
      if (reason instanceof RunFailure) {
        finishRun(runId, 'failed', { code: reason.code, message: reason.message });
        emit({ type: 'run.failed', runId, code: reason.code, message: reason.message });
      } else {
        finishRun(runId, 'cancelled', { code: 'cancelled', message: 'Cancelled' });
        emit({ type: 'run.completed', runId, status: 'cancelled' });
      }
    } else if (error instanceof RunFailure) {
      finishRun(runId, 'failed', { code: error.code, message: error.message });
      emit({ type: 'run.failed', runId, code: error.code, message: error.message });
    } else if (isAbortError(error)) {
      finishRun(runId, 'cancelled', { code: 'cancelled', message: 'Cancelled' });
      emit({ type: 'run.completed', runId, status: 'cancelled' });
    } else {
      const message = error instanceof Error ? error.message : 'Run failed';
      finishRun(runId, 'failed', { code: 'internal', message });
      emit({ type: 'run.failed', runId, code: 'internal', message });
    }
    return runId;
  } finally {
    clearTimeout(deadline);
    activeRuns.delete(runId);
  }
}
