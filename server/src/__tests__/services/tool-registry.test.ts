import { describe, it, expect } from 'vitest';
import {
  namespacedToolName, ToolArgumentError, ToolRegistry, type ToolDefinition,
} from '../../services/tools/registry.js';

function tool(name: string, extra: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name,
    description: `does ${name}`,
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    source: 'builtin',
    approval: 'never',
    idempotent: true,
    execute: async () => ({ content: 'ok' }),
    ...extra,
  };
}

describe('ToolRegistry', () => {
  it('rejects duplicate and illegal names', () => {
    const r = new ToolRegistry();
    r.register(tool('a__b'));
    expect(() => r.register(tool('a__b'))).toThrow(/already registered/);
    expect(() => r.register(tool('has space'))).toThrow(/Invalid tool name/);
  });

  it('validates arguments before execution', () => {
    const r = new ToolRegistry();
    r.register(tool('echo'));
    expect(r.validateArguments('echo', { text: 'hi' })).toEqual({ text: 'hi' });
    expect(() => r.validateArguments('echo', {})).toThrow(ToolArgumentError);
    expect(() => r.validateArguments('echo', { text: 1 })).toThrow(ToolArgumentError);
    expect(() => r.validateArguments('echo', [])).toThrow(ToolArgumentError);
    expect(() => r.validateArguments('missing', {})).toThrow(/Unknown tool/);
  });

  it('keeps same-named tools from two servers apart via the prefix', () => {
    const r = new ToolRegistry();
    r.register(tool('m1__search'));
    r.register(tool('m10__search'));
    r.unregisterPrefix('m1__');
    expect(r.get('m1__search')).toBeUndefined();
    expect(r.get('m10__search')).toBeDefined();
  });

  it('shows account-owned tools only to their owner', () => {
    const r = new ToolRegistry();
    r.register(tool('shared'));
    r.register(tool('mine', { ownerUserId: 1 }));
    expect(r.listForUser(1).map(t => t.name).sort()).toEqual(['mine', 'shared']);
    expect(r.listForUser(2).map(t => t.name)).toEqual(['shared']);
  });

  it('caps offered tools and prefers ones matching the hint', () => {
    const r = new ToolRegistry();
    for (let i = 0; i < 6; i += 1) r.register(tool(`t${i}`));
    r.register(tool('weather', { description: 'forecast for a city' }));
    const picked = r.select({ max: 3, hint: 'what is the forecast today' });
    expect(picked).toHaveLength(3);
    expect(picked[0].name).toBe('weather');
  });

  it('builds legal namespaced names within 64 characters', () => {
    const name = namespacedToolName('my server!', 'a'.repeat(100));
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });
});
