import { describe, expect, it } from 'vitest';
import { errorMessage, errorProps } from '../../lib/error-props.js';

describe('errorMessage', () => {
  it('reads the message of an Error or any object that has one', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage({ message: 'plain object' })).toBe('plain object');
    expect(errorMessage(new Error(''))).toBe('');
  });

  it('uses the fallback when there is no message string, else describes the value', () => {
    expect(errorMessage({ code: 1 }, 'unknown')).toBe('unknown');
    expect(errorMessage(null, 'unknown')).toBe('unknown');
    expect(errorMessage({ message: 42 }, 'unknown')).toBe('unknown');
    expect(errorMessage('just a string')).toBe('just a string');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(7)).toBe('7');
  });

  it('prefers a real message over the fallback', () => {
    expect(errorMessage(new Error('real'), 'fallback')).toBe('real');
  });
});

describe('errorProps', () => {
  it('returns status, code, name and retryAfterMs only when they have the right type', () => {
    const err = Object.assign(new Error('rate limited'), { status: 429, code: 'quota_exceeded', retryAfterMs: 1500 });
    expect(errorProps(err)).toEqual({
      message: 'rate limited', name: 'Error', status: 429, code: 'quota_exceeded', retryAfterMs: 1500,
    });
    expect(errorProps({ status: '429', code: 7, retryAfterMs: '1' })).toEqual({
      message: undefined, name: undefined, status: undefined, code: undefined, retryAfterMs: undefined,
    });
  });

  it('never throws on values that are not objects', () => {
    for (const value of [null, undefined, 0, 'x', true, Symbol('s')]) {
      expect(() => errorProps(value)).not.toThrow();
      expect(errorProps(value).status).toBeUndefined();
    }
  });
});
