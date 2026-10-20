import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getUnifiedApiKey, initDb, regenerateUnifiedKey } from '../../db/index.js';

function storedValue(): string {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string };
  return row.value;
}

describe('unified API key encryption at rest', () => {
  beforeEach(() => {
    vi.stubEnv('ENCRYPTION_KEY', '0'.repeat(64));
    initDb(':memory:');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('upgrades the plaintext row written by the baseline migration on first read', () => {
    const legacy = storedValue();
    expect(legacy.startsWith('enc:v1:')).toBe(false);

    expect(getUnifiedApiKey()).toBe(legacy);

    const sealed = storedValue();
    expect(sealed.startsWith('enc:v1:')).toBe(true);
    expect(sealed).not.toContain(legacy);
    expect(getUnifiedApiKey()).toBe(legacy);
  });

  it('stores a regenerated key encrypted and returns the plaintext to the caller', () => {
    const fresh = regenerateUnifiedKey();

    expect(fresh).toMatch(/^freellmapi-[0-9a-f]{48}$/);
    expect(storedValue()).not.toContain(fresh);
    expect(getUnifiedApiKey()).toBe(fresh);
  });

  it('mints a new key instead of failing when the stored one cannot be decrypted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getUnifiedApiKey();
    const sealed = storedValue();
    const [iv, , ciphertext] = sealed.slice('enc:v1:'.length).split(':');
    // Corrupt the auth tag so GCM verification fails.
    getDb().prepare("UPDATE settings SET value = ? WHERE key = 'unified_api_key'")
      .run(`enc:v1:${iv}:${'0'.repeat(32)}:${ciphertext}`);

    const recovered = getUnifiedApiKey();

    expect(recovered).toMatch(/^freellmapi-[0-9a-f]{48}$/);
    expect(getUnifiedApiKey()).toBe(recovered);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
