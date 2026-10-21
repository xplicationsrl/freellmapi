// Code sandbox client. The main server never runs user code and never talks to
// a container daemon: it submits jobs to a separate worker (see /sandbox-worker)
// over a narrow HTTP API and gets stdout, stderr and output files back.
//
//   POST   {SANDBOX_WORKER_URL}/jobs        run code, answer when finished
//   DELETE {SANDBOX_WORKER_URL}/jobs/:id    cancel a running job
//   GET    {SANDBOX_WORKER_URL}/health      worker + runtime image status
//
// The worker holds no provider keys and gets no application data: only the
// files a run explicitly attached are copied into a job.

import crypto from 'node:crypto';
import { getToolRegistry, type ToolDefinition } from '../tools/registry.js';

export type SandboxStatus = 'completed' | 'failed' | 'timeout' | 'cancelled';

export interface SandboxFileIn {
  name: string;
  dataBase64: string;
}

export interface SandboxRequest {
  language: 'python';
  code: string;
  files: SandboxFileIn[];
  timeoutMs: number;
}

export interface SandboxFileOut {
  name: string;
  mimeType: string;
  dataBase64: string;
}

export interface SandboxResult {
  status: SandboxStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  files: SandboxFileOut[];
  /** Runtime image the job ran on, recorded with each execution. */
  image: string;
  durationMs: number;
}

/** The boundary the tool talks to; a test double or another runtime can implement it. */
export interface SandboxExecutor {
  run(request: SandboxRequest, signal: AbortSignal): Promise<SandboxResult>;
  health(): Promise<{ ok: boolean; image?: string; error?: string }>;
}

export function sandboxWorkerUrl(): string | null {
  const url = process.env.SANDBOX_WORKER_URL?.trim();
  return url ? url.replace(/\/+$/, '') : null;
}

export class HttpSandboxExecutor implements SandboxExecutor {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' };
  }

  async run(request: SandboxRequest, signal: AbortSignal): Promise<SandboxResult> {
    const jobId = crypto.randomUUID();
    const onAbort = () => {
      // Tell the worker to kill the container; the fetch below is aborted too.
      void fetch(`${this.baseUrl}/jobs/${jobId}`, {
        method: 'DELETE', headers: this.headers(), signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await fetch(`${this.baseUrl}/jobs`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ id: jobId, ...request }),
        // Worker enforces the job timeout; this is the outer bound.
        signal: AbortSignal.any([signal, AbortSignal.timeout(request.timeoutMs + 30_000)]),
      });
      if (!response.ok) {
        const text = (await response.text().catch(() => '')).slice(0, 300);
        throw new Error(`Sandbox worker error (HTTP ${response.status})${text ? `: ${text}` : ''}`);
      }
      return await response.json() as SandboxResult;
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async health(): Promise<{ ok: boolean; image?: string; error?: string }> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(), signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const body = await response.json() as { ok?: boolean; image?: string };
      return { ok: body.ok !== false, image: body.image };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'unreachable' };
    }
  }
}

export function getSandboxExecutor(): SandboxExecutor | null {
  const url = sandboxWorkerUrl();
  const token = process.env.SANDBOX_WORKER_TOKEN?.trim();
  if (!url || !token) return null;
  return new HttpSandboxExecutor(url, token);
}

const MAX_CODE_CHARS = 50_000;
const MAX_OUTPUT_CHARS = 8_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

function clip(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS ? text : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]`;
}

export function sandboxRequiresApproval(): boolean {
  return !/^(1|true|yes|on)$/i.test(process.env.SANDBOX_AUTO_APPROVE ?? '');
}

/** Build the run_python tool around an executor (injectable for tests). */
export function buildPythonTool(executor: SandboxExecutor): ToolDefinition {
  return {
    name: 'sandbox__run_python',
    description:
      'Run Python 3 in an isolated sandbox with no network access. pandas, numpy and matplotlib are installed. '
      + 'Attached files are available in the working directory under their own names. Write result files '
      + '(CSV, PNG charts, text) to the working directory; they are returned to the user. Print findings to stdout.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', maxLength: MAX_CODE_CHARS, description: 'The Python source to run.' },
        input_files: {
          type: 'array',
          items: { type: 'string', maxLength: 120 },
          maxItems: 5,
          description: 'Names of attached files to copy into the working directory.',
        },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS / 1000 },
      },
      required: ['code'],
      additionalProperties: false,
    },
    source: 'sandbox',
    approval: sandboxRequiresApproval() ? 'always' : 'never',
    // Code can write files and burn time but has no outside effects; still,
    // re-running it is the model's decision, not an automatic retry.
    idempotent: true,
    async execute(args, ctx) {
      const code = String(args.code ?? '');
      const wanted = Array.isArray(args.input_files) ? args.input_files.map(String) : [];
      const files: SandboxFileIn[] = [];
      for (const name of wanted) {
        const att = ctx.attachments.find(a => a.name === name);
        if (!att) return { content: `Attached file not found: ${name}`, isError: true };
        files.push({ name: att.name, dataBase64: att.data.toString('base64') });
      }
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1000, (typeof args.timeout_seconds === 'number' ? args.timeout_seconds * 1000 : DEFAULT_TIMEOUT_MS)),
      );

      let result: SandboxResult;
      try {
        result = await executor.run({ language: 'python', code, files, timeoutMs }, ctx.signal);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        return { content: `Sandbox unavailable: ${error instanceof Error ? error.message : 'error'}`, isError: true };
      }

      const saved: string[] = [];
      for (const f of result.files) {
        try {
          ctx.addArtifact?.({ name: f.name, mimeType: f.mimeType, data: Buffer.from(f.dataBase64, 'base64') });
          saved.push(f.name);
        } catch (error) {
          saved.push(`${f.name} (not saved: ${error instanceof Error ? error.message : 'error'})`);
        }
      }

      const lines = [`status: ${result.status}`, `exit code: ${result.exitCode ?? 'none'}`];
      if (result.stdout) lines.push(`stdout:\n${clip(result.stdout)}`);
      if (result.stderr) lines.push(`stderr:\n${clip(result.stderr)}`);
      if (saved.length) lines.push(`files returned to the user: ${saved.join(', ')}`);
      return { content: lines.join('\n'), isError: result.status !== 'completed' };
    },
  };
}

let registered = false;

/** Register the sandbox tool when a worker is configured. Idempotent. */
export function registerSandboxTool(): boolean {
  if (registered) return true;
  const executor = getSandboxExecutor();
  if (!executor) return false;
  getToolRegistry().register(buildPythonTool(executor));
  registered = true;
  return true;
}
