import crypto from 'crypto';
import type { Request } from 'express';

export function getRequestGroupId(req: Request): string {
  const raw = req.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || crypto.randomUUID();
}

export function shortRequestId(requestId: string): string {
  return requestId.replace(/-/g, '').slice(0, 6);
}

/**
 * Stamp the execution id onto a body that was stored by an EARLIER request
 * (response cache hit, idempotency replay). The id goes on the outbound copy
 * only — never on the stored entry — so a replay reports the id of THIS
 * request instead of the one that first filled the store, which is what makes
 * the field safe to trust on every response. Stored bodies are typed
 * `unknown`; a non-object entry (corrupt) is passed through untouched rather
 * than spread into indexed characters.
 */
export function withExecutionId(body: unknown, executionId: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return { ...(body as Record<string, unknown>), execution_id: executionId };
}

export type TraceEvent = 'start' | 'next' | 'ok' | 'fail';

export function traceRouteEvent(
  scope: 'Proxy' | 'Responses',
  opts: {
    event: TraceEvent;
    requestId: string;
    attempt: number;
    platform: string;
    model: string;
    requestedModel?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  },
) {
  const parts = [
    `[${scope}]`,
    new Date().toISOString().slice(11, 19),
    opts.event,
    shortRequestId(opts.requestId),
    `a${opts.attempt}`,
    opts.platform,
    '-',
    opts.model,
  ];
  if (opts.requestedModel) parts.push(`req=${opts.requestedModel}`);
  if (opts.latencyMs != null) parts.push(`lat=${opts.latencyMs}ms`);
  if (opts.inputTokens != null) parts.push(`in=${opts.inputTokens}`);
  if (opts.outputTokens != null) parts.push(`out=${opts.outputTokens}`);
  if (opts.error) parts.push(`err=${JSON.stringify(opts.error)}`);
  console.log(parts.join(' '));
}
