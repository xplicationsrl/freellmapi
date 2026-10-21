// Shared tool registry for server-side conversation runs. MCP tools, the code
// sandbox, knowledge search and built-ins all register here; the orchestrator
// only ever talks to this interface.
//
// Model-facing names are namespaced `<source>__<name>` style and restricted to
// the character set every provider accepts for function names, so two MCP
// servers exposing the same tool name cannot collide.

import Ajv2020 from 'ajv/dist/2020.js';
import type { ToolSource } from '@freellmapi/shared/conversation-events.js';

export type ApprovalPolicy = 'never' | 'always';

export interface RunAttachment {
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface ToolContext {
  /** Files the user attached to this run; tools read them by name. */
  attachments: readonly RunAttachment[];
  /** Knowledge bases the conversation enabled (ids owned by the account). */
  knowledgeBaseIds: readonly number[];
  runId: string;
  conversationId: number;
  userId: number;
  /** Aborted on cancellation or timeout; tools must stop downstream work. */
  signal: AbortSignal;
  /** Publish a file produced by the tool (sandbox output, chart). */
  addArtifact?: (artifact: ToolArtifactInput) => void;
  /** Publish a citation for knowledge-grounded answers. */
  addCitation?: (citation: { id: string; title: string; location?: string; url?: string }) => void;
}

export interface ToolArtifactInput {
  name: string;
  mimeType: string;
  data: Buffer;
}

export interface ToolResult {
  /** Text handed back to the model (bounded by the orchestrator). */
  content: string;
  /** True when the tool ran but reports a failure the model should see. */
  isError?: boolean;
}

export interface ToolDefinition {
  /** Stable model-facing name. */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>;
  source: ToolSource;
  approval: ApprovalPolicy;
  /** Set for per-account tools (MCP servers); other accounts must not see or call them. */
  ownerUserId?: number;
  /**
   * True when running the tool twice is harmless. Idempotent tools may be
   * retried after a lost result; others become `uncertain` instead.
   */
  idempotent: boolean;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

/**
 * Thrown by a tool that may have taken effect but cannot confirm it (a request
 * sent, the response lost). The run records the outcome as `uncertain` and the
 * action is never repeated automatically.
 */
export class ToolOutcomeUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolOutcomeUncertainError';
  }
}

const NAME_RE =/^[A-Za-z0-9_-]{1,64}$/;

/** Turn arbitrary text into a legal function-name segment. */
export function sanitizeToolSegment(text: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'tool';
}

/** Build `<prefix>__<name>` and clip to the 64 characters providers accept. */
export function namespacedToolName(prefix: string, name: string): string {
  const full = `${sanitizeToolSegment(prefix)}__${sanitizeToolSegment(name)}`;
  return full.length <= 64 ? full : full.slice(0, 64);
}

const ajv = new Ajv2020({ allErrors: true, strict: false });

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();
  private readonly validators = new Map<string, ReturnType<typeof ajv.compile>>();

  register(tool: ToolDefinition): void {
    if (!NAME_RE.test(tool.name)) {
      throw new Error(`Invalid tool name: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.validators.set(tool.name, ajv.compile(tool.parameters));
    this.tools.set(tool.name, tool);
  }

  /** Remove every tool whose name starts with `prefix` (an MCP server going away). */
  unregisterPrefix(prefix: string): void {
    for (const name of [...this.tools.keys()]) {
      if (name.startsWith(prefix)) {
        this.tools.delete(name);
        this.validators.delete(name);
      }
    }
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  /** Tools an account may see: shared tools plus its own. */
  listForUser(userId: number): ToolDefinition[] {
    return this.list().filter(t => t.ownerUserId === undefined || t.ownerUserId === userId);
  }

  /** Validate arguments before execution; throws ToolArgumentError. */
  validateArguments(name: string, args: unknown): Record<string, unknown> {
    const validate = this.validators.get(name);
    if (!validate) throw new ToolArgumentError(`Unknown tool: ${name}`);
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new ToolArgumentError('Tool arguments must be a JSON object');
    }
    if (!validate(args)) {
      const detail = (validate.errors ?? [])
        .slice(0, 5)
        .map(e => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`)
        .join('; ');
      throw new ToolArgumentError(`Invalid arguments: ${detail}`);
    }
    return args as Record<string, unknown>;
  }

  /**
   * Pick the tools to offer on a turn. `allow` limits to a set of names (the
   * conversation's enabled tools); `max` bounds the definitions sent so a long
   * list of MCP tools does not eat the context of a small model. When over the
   * cap, tools whose name or description share words with `hint` come first.
   */
  select(options: { allow?: ReadonlySet<string>; max?: number; hint?: string } = {}): ToolDefinition[] {
    let pool = this.list();
    if (options.allow) pool = pool.filter(t => options.allow!.has(t.name));
    const max = options.max ?? 24;
    if (pool.length <= max) return pool;
    const words = new Set(
      (options.hint ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2),
    );
    const score = (t: ToolDefinition): number => {
      const hay = `${t.name} ${t.description}`.toLowerCase();
      let n = 0;
      for (const w of words) if (hay.includes(w)) n += 1;
      return n;
    };
    return pool
      .map((t, i) => ({ t, s: score(t), i }))
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, max)
      .map(x => x.t);
  }
}

let shared: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!shared) shared = new ToolRegistry();
  return shared;
}

/** Shape sent to the model in the OpenAI `tools` array. */
export function toOpenAiTool(tool: ToolDefinition): {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
} {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}
