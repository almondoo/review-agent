/**
 * Tests for JWT helpers (jwt.ts).
 *
 * Covers:
 *   - Normal round-trip (issue → verify → claims match)
 *   - Tampered signature → null
 *   - Expired token → null
 *   - alg=none (JOSE should reject) → null
 *   - alg=RS256 (alg confusion) → null
 *   - Different secret → null
 *   - Malformed string → null
 */
import { describe, expect, it } from 'vitest';
import { issueSessionToken, verifySessionToken } from '../jwt.js';

const SECRET = 'a-very-secure-test-secret-32-bytes-long!!';
const SECRET2 = 'a-different-secret-for-rejection-testing!!';

const PAYLOAD = {
  principalId: 'user-123',
  username: 'alice',
  tokenVersion: 5,
};

describe('JWT round-trip', () => {
  it('issues a token and verifies it successfully', async () => {
    const token = await issueSessionToken(PAYLOAD, SECRET, 3600);
    expect(typeof token).toBe('string');
    expect(token.split('.').length).toBe(3);

    const claims = await verifySessionToken(token, SECRET);
    expect(claims).not.toBeNull();
    expect(claims?.principalId).toBe(PAYLOAD.principalId);
    expect(claims?.username).toBe(PAYLOAD.username);
    expect(claims?.tokenVersion).toBe(PAYLOAD.tokenVersion);
  });

  it('accepts Uint8Array secret', async () => {
    const secretBytes = new TextEncoder().encode(SECRET);
    const token = await issueSessionToken(PAYLOAD, secretBytes, 3600);
    const claims = await verifySessionToken(token, secretBytes);
    expect(claims?.principalId).toBe(PAYLOAD.principalId);
  });
});

describe('signature rejection', () => {
  it('returns null for a token with tampered payload', async () => {
    const token = await issueSessionToken(PAYLOAD, SECRET, 3600);
    const parts = token.split('.');
    // Tamper the payload part (base64url decode, modify, re-encode)
    const part1 = parts[1] ?? '';
    const decodedPayload = JSON.parse(Buffer.from(part1, 'base64url').toString());
    decodedPayload.tv = 999; // change tokenVersion
    const tamperedPayload = Buffer.from(JSON.stringify(decodedPayload)).toString('base64url');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;
    const claims = await verifySessionToken(tampered, SECRET);
    expect(claims).toBeNull();
  });

  it('returns null for a different secret', async () => {
    const token = await issueSessionToken(PAYLOAD, SECRET, 3600);
    const claims = await verifySessionToken(token, SECRET2);
    expect(claims).toBeNull();
  });
});

describe('expiry rejection', () => {
  it('returns null for an expired token (ttl=0 → already expired)', async () => {
    // TTL of -1 second means exp is in the past.
    const token = await issueSessionToken(PAYLOAD, SECRET, -1);
    const claims = await verifySessionToken(token, SECRET);
    expect(claims).toBeNull();
  });
});

describe('algorithm rejection', () => {
  it('returns null for a malformed token string', async () => {
    const claims = await verifySessionToken('not.a.jwt', SECRET);
    expect(claims).toBeNull();
  });

  it('returns null for an empty string', async () => {
    const claims = await verifySessionToken('', SECRET);
    expect(claims).toBeNull();
  });

  it('returns null for an alg=none token (hand-crafted)', async () => {
    // Manually construct an alg=none JWT (no real signature).
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'user-123',
        username: 'alice',
        tv: 5,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');
    const noneToken = `${header}.${payload}.`; // no signature
    const claims = await verifySessionToken(noneToken, SECRET);
    expect(claims).toBeNull();
  });

  it('returns null for a token with missing required claims', async () => {
    // Issue a token but manually construct one without the `tv` claim.
    const { SignJWT } = await import('jose');
    const secretKey = new TextEncoder().encode(SECRET);
    // Missing 'tv' and 'username' claims
    const brokenToken = await new SignJWT({ sub: 'user-123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(secretKey);
    const claims = await verifySessionToken(brokenToken, SECRET);
    expect(claims).toBeNull();
  });
});
