import { describe, expect, it } from 'vitest';
import {
  decryptWithDataKey,
  ENVELOPE_PARAMS,
  encryptWithDataKey,
  generateDataKey,
} from './envelope.js';

describe('generateDataKey', () => {
  it('returns a 256-bit Buffer', () => {
    const key = generateDataKey();
    expect(key.length).toBe(ENVELOPE_PARAMS.keyBytes);
  });

  it('produces unique keys on each call', () => {
    const a = generateDataKey();
    const b = generateDataKey();
    expect(a.equals(b)).toBe(false);
  });
});

describe('encryptWithDataKey + decryptWithDataKey', () => {
  it('round-trips a UTF-8 plaintext through GCM', () => {
    const dataKey = generateDataKey();
    const plaintext = 'sk-ant-api03-abcdef0123456789';
    const envelope = encryptWithDataKey(plaintext, dataKey);
    expect(envelope.ciphertext.length).toBeGreaterThan(0);
    expect(envelope.iv.length).toBe(ENVELOPE_PARAMS.ivBytes);
    expect(envelope.authTag.length).toBe(ENVELOPE_PARAMS.tagBytes);
    expect(decryptWithDataKey(envelope, dataKey)).toBe(plaintext);
  });

  it('produces a fresh IV on each encrypt (no nonce reuse)', () => {
    const dataKey = generateDataKey();
    const a = encryptWithDataKey('payload', dataKey);
    const b = encryptWithDataKey('payload', dataKey);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('throws when decrypting with the wrong data key', () => {
    const goodKey = generateDataKey();
    const evilKey = generateDataKey();
    const env = encryptWithDataKey('top-secret', goodKey);
    expect(() => decryptWithDataKey(env, evilKey)).toThrow();
  });

  it('throws when the auth tag is tampered with', () => {
    const dataKey = generateDataKey();
    const env = encryptWithDataKey('top-secret', dataKey);
    const tampered = { ...env, authTag: Buffer.alloc(env.authTag.length, 0) };
    expect(() => decryptWithDataKey(tampered, dataKey)).toThrow();
  });

  it('throws when the ciphertext is tampered with', () => {
    const dataKey = generateDataKey();
    const env = encryptWithDataKey('top-secret', dataKey);
    const tampered = {
      ...env,
      ciphertext: Buffer.from(env.ciphertext.map((b, i) => (i === 0 ? b ^ 1 : b))),
    };
    expect(() => decryptWithDataKey(tampered, dataKey)).toThrow();
  });

  it('rejects encrypt with a wrong-length data key', () => {
    expect(() => encryptWithDataKey('x', Buffer.alloc(16))).toThrow(/dataKey must be/);
  });

  it('rejects decrypt with a wrong-length data key', () => {
    const dataKey = generateDataKey();
    const env = encryptWithDataKey('x', dataKey);
    expect(() => decryptWithDataKey(env, Buffer.alloc(16))).toThrow(/dataKey must be/);
  });

  it('rejects decrypt with a wrong-length IV', () => {
    const dataKey = generateDataKey();
    const env = encryptWithDataKey('x', dataKey);
    expect(() => decryptWithDataKey({ ...env, iv: Buffer.alloc(8) }, dataKey)).toThrow(
      /iv must be/,
    );
  });

  it('rejects decrypt with a wrong-length auth tag', () => {
    const dataKey = generateDataKey();
    const env = encryptWithDataKey('x', dataKey);
    expect(() => decryptWithDataKey({ ...env, authTag: Buffer.alloc(8) }, dataKey)).toThrow(
      /authTag must be/,
    );
  });
});
