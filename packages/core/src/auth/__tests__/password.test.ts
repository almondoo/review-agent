import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../password.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password', () => {
    const stored = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('correct-horse-battery-staple', stored)).toBe(true);
  });

  it('rejects a wrong password', () => {
    const stored = hashPassword('correct-horse-battery-staple');
    expect(verifyPassword('wrong-password', stored)).toBe(false);
  });

  it('produces different hashes for the same plaintext (different salts)', () => {
    const h1 = hashPassword('same-plain');
    const h2 = hashPassword('same-plain');
    expect(h1).not.toBe(h2);
    // But both verify correctly.
    expect(verifyPassword('same-plain', h1)).toBe(true);
    expect(verifyPassword('same-plain', h2)).toBe(true);
  });

  it('returns false for a stored string with a tampered hash segment', () => {
    const stored = hashPassword('my-password');
    const parts = stored.split('$');
    // Corrupt the hash portion (last segment).
    parts[5] = parts[5]?.split('').reverse().join('');
    const tampered = parts.join('$');
    expect(verifyPassword('my-password', tampered)).toBe(false);
  });

  it('returns false for an empty string as stored', () => {
    expect(verifyPassword('anything', '')).toBe(false);
  });

  it('returns false for a malformed stored string (wrong prefix)', () => {
    expect(verifyPassword('anything', 'bcrypt$cost$salt$hash')).toBe(false);
  });

  it('returns false for a stored string with wrong field count', () => {
    expect(verifyPassword('pw', 'scrypt$32768$8$1$onlyfourparts')).toBe(false);
  });

  it('returns false when hashing an empty plaintext with a valid stored hash', () => {
    const stored = hashPassword('not-empty');
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('returns false for a stored string where N is zero', () => {
    const stored = hashPassword('pw');
    const parts = stored.split('$');
    parts[1] = '0'; // Set N=0 — invalid scrypt parameter.
    expect(verifyPassword('pw', parts.join('$'))).toBe(false);
  });

  it('rejects a stored hash whose N exceeds the upper bound (no memory blow-up)', () => {
    const stored = hashPassword('pw');
    const parts = stored.split('$');
    parts[1] = String(2 ** 30); // Absurd N that would exhaust memory if accepted.
    // Must short-circuit to false without attempting scryptSync.
    expect(verifyPassword('pw', parts.join('$'))).toBe(false);
  });

  it('rejects a stored hash whose r or p exceeds the upper bound', () => {
    const stored = hashPassword('pw');
    const rTampered = stored.split('$');
    rTampered[2] = '1000'; // r way over cap
    expect(verifyPassword('pw', rTampered.join('$'))).toBe(false);

    const pTampered = stored.split('$');
    pTampered[3] = '1000'; // p way over cap
    expect(verifyPassword('pw', pTampered.join('$'))).toBe(false);
  });
});
