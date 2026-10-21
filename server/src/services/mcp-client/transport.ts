// Minimal MCP client transports: Streamable HTTP and stdio. JSON-RPC 2.0 only,
// tools/list and tools/call are all the chat needs, so this is written against
// the wire protocol directly rather than pulling in the SDK (a new dependency
// would also change package-lock.json and break `npm ci` on the deployed
// image until it is regenerated).

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { assessProviderUrl } from '../../lib/url-guard.js';
import { getGuardedDispatcher } from '../../lib/guarded-dispatcher.js';

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class McpError extends Error {
  constructor(message: string, public code?: number) {
    super(message);
    this.name = 'McpError';
  }
}

/** The request may have reached the server but no answer came back. */
export class McpResponseLostError extends McpError {
  constructor(message: string) {
    super(message);
    this.name = 'McpResponseLostError';
  }
}

export interface McpTransport {
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  close(): Promise<void>;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
}

function unwrap(message: JsonRpcResponse): unknown {
  if (message.error) {
    throw new McpError(message.error.message ?? 'MCP error', message.error.code);
  }
  return message.result;
}

// ---------- Streamable HTTP ----------

export interface HttpTransportOptions {
  url: string;
  headers: Record<string, string>;
  allowPrivate: boolean;
  timeoutMs: number;
}

export class HttpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(private readonly opts: HttpTransportOptions) {}

  private async post(body: unknown, signal: AbortSignal | undefined): Promise<Response> {
    // Checked on every request, not just at save time: DNS can change.
    const verdict = await assessProviderUrl(this.opts.url, { blockPrivate: !this.opts.allowPrivate });
    if (!verdict.allowed) throw new McpError(`Server URL blocked: ${verdict.reason}`);

    const headers: Record<string, string> = {
      ...this.opts.headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const timeout = AbortSignal.timeout(this.opts.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const init: RequestInit & { dispatcher?: unknown } = {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined,
      // A redirect could carry the credentials to another host.
      redirect: 'manual',
    };
    if (!this.opts.allowPrivate) {
      const dispatcher = await getGuardedDispatcher();
      if (dispatcher) init.dispatcher = dispatcher as RequestInit["dispatcher"];
    }
    const response = await fetch(this.opts.url, init);
    if (response.status >= 300 && response.status < 400) {
      throw new McpError('Server answered with a redirect, which is not followed');
    }
    return response;
  }

  async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = this.nextId++;
    let response: Response;
    try {
      response = await this.post({ jsonrpc: '2.0', id, method, params }, signal);
    } catch (error) {
      if (error instanceof McpError) throw error;
      // Sent, but no response: the call may have taken effect.
      throw new McpResponseLostError(error instanceof Error ? error.message : 'Request failed');
    }
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).slice(0, 300);
      throw new McpError(`HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }
    const type = response.headers.get('content-type') ?? '';
    try {
      if (type.includes('text/event-stream')) return await this.readSse(response, id);
      const raw = await response.text();
      if (raw.length > MAX_RESPONSE_BYTES) throw new McpError('Response too large');
      return unwrap(JSON.parse(raw) as JsonRpcResponse);
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpResponseLostError(error instanceof Error ? error.message : 'Response lost');
    }
  }

  private async readSse(response: Response, id: number): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new McpResponseLostError('Empty response stream');
    const decoder = new TextDecoder();
    let buffer = '';
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.length;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new McpError('Response too large');
        }
        buffer += decoder.decode(value, { stream: !done });
      }
      let sep: RegExpExecArray | null;
      while ((sep = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, sep.index);
        buffer = buffer.slice(sep.index + sep[0].length);
        const data = frame
          .split(/\r\n|\r|\n/)
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim())
          .join('\n');
        if (!data) continue;
        let message: JsonRpcResponse;
        try { message = JSON.parse(data) as JsonRpcResponse; } catch { continue; }
        if (message.id === id) {
          await reader.cancel().catch(() => undefined);
          return unwrap(message);
        }
      }
      if (done) break;
    }
    throw new McpResponseLostError('Stream ended without a response');
  }

  async notify(method: string, params?: unknown): Promise<void> {
    const response = await this.post({ jsonrpc: '2.0', method, params }, undefined);
    const session = response.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    await response.body?.cancel().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const headers = { ...this.opts.headers, 'Mcp-Session-Id': this.sessionId };
      await fetch(this.opts.url, {
        method: 'DELETE', headers, redirect: 'manual', signal: AbortSignal.timeout(3000),
      });
    } catch { /* best effort */ }
    this.sessionId = null;
  }
}

// ---------- stdio ----------

export interface StdioTransportOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// Only what a typical server needs; the application's own environment (which
// holds provider keys and the database path) is NOT inherited.
const SAFE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT'];

export class StdioTransport implements McpTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private buffer = '';
  private readonly pending = new Map<number, Pending>();
  private exited: string | null = null;

  constructor(private readonly opts: StdioTransportOptions) {}

  private start(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const env: Record<string, string> = {};
    for (const key of SAFE_ENV_KEYS) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    Object.assign(env, this.opts.env);
    const child = spawn(this.opts.command, this.opts.args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.on('data', () => undefined); // drained so the child never blocks
    child.on('error', error => this.onExit(`Could not start: ${error.message}`));
    child.on('exit', (code, signal) => this.onExit(`Process exited (${signal ?? code})`));
    this.child = child;
    return child;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_RESPONSE_BYTES * 2) {
      this.onExit('Output too large');
      this.child?.kill('SIGKILL');
      return;
    }
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let message: JsonRpcResponse;
      try { message = JSON.parse(line) as JsonRpcResponse; } catch { continue; }
      if (typeof message.id !== 'number') continue; // server notifications/requests are ignored
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      try { pending.resolve(unwrap(message)); } catch (error) { pending.reject(error as Error); }
    }
  }

  private onExit(reason: string): void {
    if (this.exited) return;
    this.exited = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new McpResponseLostError(reason));
      this.pending.delete(id);
    }
  }

  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.exited) return Promise.reject(new McpError(this.exited));
    const child = this.start();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpResponseLostError(`Timed out after ${this.opts.timeoutMs} ms`));
      }, this.opts.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const onAbort = () => {
        if (this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new McpResponseLostError('Cancelled'));
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (error && this.pending.delete(id)) {
          clearTimeout(timer);
          reject(new McpError(`Write failed: ${error.message}`));
        }
      });
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.exited) throw new McpError(this.exited);
    this.start().stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    this.onExit('Closed');
    try { child.stdin.end(); } catch { /* already closed */ }
    const killer = setTimeout(() => child.kill('SIGKILL'), 2000);
    killer.unref?.();
    child.once('exit', () => clearTimeout(killer));
    child.kill('SIGTERM');
  }
}
