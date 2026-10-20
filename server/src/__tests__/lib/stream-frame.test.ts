import { describe, expect, it } from 'vitest';
import { asStreamFrame, frameErrorMessage } from '../../lib/stream-frame.js';

describe('frameErrorMessage', () => {
  it('uses the message of an error object, and the JSON of anything else', () => {
    expect(frameErrorMessage({ error: { message: 'tool_use_failed', code: 400 } })).toBe('tool_use_failed');
    expect(frameErrorMessage({ error: { code: 'x' } })).toBe('{"code":"x"}');
    expect(frameErrorMessage({ error: 'plain' })).toBe('"plain"');
  });

  it('cuts a long error body to 200 characters', () => {
    expect(frameErrorMessage({ error: { detail: 'x'.repeat(500) } })).toHaveLength(200);
  });
});

describe('asStreamFrame', () => {
  it('returns the same object, so mutation helpers still act on the frame itself', () => {
    const raw = { id: 'a', choices: [{ delta: { content: 'hi' } }] };
    expect(asStreamFrame(raw)).toBe(raw);
  });
});
