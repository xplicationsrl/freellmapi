// Harmless built-in tools. They exist so the run loop (execute, show result,
// continue, survive reload, cancel) can be exercised without any external
// server, and double as the reference for writing a ToolDefinition.

import { getToolRegistry, type ToolDefinition } from './registry.js';

const currentTime: ToolDefinition = {
  name: 'builtin__current_time',
  description: 'Return the current date and time (ISO 8601, UTC).',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  source: 'builtin',
  approval: 'never',
  idempotent: true,
  async execute() {
    return { content: new Date().toISOString() };
  },
};

const echo: ToolDefinition = {
  name: 'builtin__echo',
  description: 'Return the given text unchanged. Useful to test tool calling.',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string', maxLength: 2000 } },
    required: ['text'],
    additionalProperties: false,
  },
  source: 'builtin',
  approval: 'never',
  idempotent: true,
  async execute(args) {
    return { content: String(args.text ?? '') };
  },
};

let registered = false;

export function registerBuiltinTools(): void {
  if (registered) return;
  registered = true;
  const registry = getToolRegistry();
  registry.register(currentTime);
  registry.register(echo);
}
