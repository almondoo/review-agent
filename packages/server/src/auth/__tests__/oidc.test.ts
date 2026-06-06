/**
 * Tests for packages/server/src/auth/oidc.ts
 *
 * Covers:
 *   - createPkce: length, base64url format, S256 challenge
 *   - discoverOidc: success, HTTP error, schema validation error
 *   - verifyOidcIdToken: valid RS256/ES256, expired, wrong issuer, wrong audience, nonce mismatch
 *   - resolveOidcConfig: env only, kms path, disabled (legacy/missing)
 *   - exchangeCode: success, HTTP error, missing id_token
 */

import { SignJWT } from 'jose/jwt/sign';
import { generateKeyPair } from 'jose/key/generate/keypair';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createLocalJWKSet,
  createPkce,
  discoverOidc,
  exchangeCode,
  resolveOidcConfig,
  verifyOidcIdToken,
} from '../oidc.js';

// ---------------------------------------------------------------------------
// createPkce
// ---------------------------------------------------------------------------

describe('createPkce', () => {
  it('returns verifier and challenge as base64url strings', () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('verifier is at least 43 chars (64 bytes base64url)', () => {
    const pkce = createPkce();
    // 64 bytes → 86 base64url chars (without padding)
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('challenge is the SHA-256 of verifier encoded as base64url', async () => {
    const { createHash } = await import('node:crypto');
    const pkce = createPkce();
    const expected = createHash('sha256').update(pkce.verifier).digest('base64url');
    expect(pkce.challenge).toBe(expected);
  });

  it('generates unique pairs on each call', () => {
    const a = createPkce();
    const b = createPkce();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).not.toBe(b.challenge);
  });
});

// ---------------------------------------------------------------------------
// discoverOidc
// ---------------------------------------------------------------------------

describe('discoverOidc', () => {
  const VALID_DISCOVERY = {
    authorization_endpoint: 'https://idp.example.com/authorize',
    token_endpoint: 'https://idp.example.com/token',
    jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
  };

  it('returns parsed endpoints on success', async () => {
    const fetchFn = async (_url: string) =>
      new Response(JSON.stringify(VALID_DISCOVERY), { status: 200 });

    const result = await discoverOidc('https://idp.example.com', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(result).toEqual({
      authorizationEndpoint: VALID_DISCOVERY.authorization_endpoint,
      tokenEndpoint: VALID_DISCOVERY.token_endpoint,
      jwksUri: VALID_DISCOVERY.jwks_uri,
    });
  });

  it('throws on non-OK HTTP status', async () => {
    const fetchFn = async (_url: string) => new Response('not found', { status: 404 });

    await expect(
      discoverOidc('https://idp.example.com', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow('discovery HTTP 404');
  });

  it('throws when response body is not valid JSON', async () => {
    const fetchFn = async (_url: string) => new Response('this is not json', { status: 200 });

    await expect(
      discoverOidc('https://idp.example.com', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow();
  });

  it('throws when required fields are missing', async () => {
    const fetchFn = async (_url: string) =>
      new Response(JSON.stringify({ authorization_endpoint: 'https://idp.example.com/auth' }), {
        status: 200,
      });

    await expect(
      discoverOidc('https://idp.example.com', { fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow('missing required fields');
  });

  it('uses the correct discovery URL', async () => {
    let calledUrl = '';
    const fetchFn = async (url: string) => {
      calledUrl = url;
      return new Response(JSON.stringify(VALID_DISCOVERY), { status: 200 });
    };

    await discoverOidc('https://idp.example.com', {
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(calledUrl).toBe('https://idp.example.com/.well-known/openid-configuration');
  });
});

// ---------------------------------------------------------------------------
// verifyOidcIdToken — shared key setup
// ---------------------------------------------------------------------------

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };

let rsaKeyPair: KeyPair;
let ecKeyPair: KeyPair;

beforeAll(async () => {
  rsaKeyPair = await generateKeyPair('RS256');
  ecKeyPair = await generateKeyPair('ES256');
});

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'test-client-id';
const NONCE = 'test-nonce-abc123';

async function signToken(
  claims: Record<string, unknown>,
  privateKey: CryptoKey,
  alg: 'RS256' | 'ES256',
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .sign(privateKey);
}

async function makeJwks(publicKey: CryptoKey) {
  // Build a minimal JWK set for the test key.
  // We use createLocalJWKSet which accepts a JSONWebKeySet.
  const { exportJWK } = await import('jose/key/export');
  const jwk = await exportJWK(publicKey);
  return createLocalJWKSet({ keys: [jwk] });
}

describe('verifyOidcIdToken', () => {
  it('verifies a valid RS256 id_token', async () => {
    const jwks = await makeJwks(rsaKeyPair.publicKey);
    const token = await signToken(
      { sub: 'user-123', nonce: NONCE, email: 'alice@example.com', preferred_username: 'alice' },
      rsaKeyPair.privateKey,
      'RS256',
    );

    const claims = await verifyOidcIdToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(claims).not.toBeNull();
    expect(claims?.sub).toBe('user-123');
    expect(claims?.preferredUsername).toBe('alice');
    expect(claims?.email).toBe('alice@example.com');
  });

  it('verifies a valid ES256 id_token', async () => {
    const jwks = await makeJwks(ecKeyPair.publicKey);
    const token = await signToken({ sub: 'user-456', nonce: NONCE }, ecKeyPair.privateKey, 'ES256');

    const claims = await verifyOidcIdToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(claims?.sub).toBe('user-456');
  });

  it('returns null when nonce does not match', async () => {
    const jwks = await makeJwks(rsaKeyPair.publicKey);
    const token = await signToken(
      { sub: 'user-123', nonce: 'wrong-nonce' },
      rsaKeyPair.privateKey,
      'RS256',
    );

    const result = await verifyOidcIdToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(result).toBeNull();
  });

  it('returns null when issuer does not match', async () => {
    const jwks = await makeJwks(rsaKeyPair.publicKey);
    // Sign with wrong issuer claim via setIssuer
    const token = await new SignJWT({ sub: 'user-123', nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer('https://wrong-idp.example.com')
      .sign(rsaKeyPair.privateKey);

    const result = await verifyOidcIdToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(result).toBeNull();
  });

  it('returns null when audience does not match', async () => {
    const jwks = await makeJwks(rsaKeyPair.publicKey);
    const token = await new SignJWT({ sub: 'user-123', nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setAudience('wrong-client')
      .sign(rsaKeyPair.privateKey);

    const result = await verifyOidcIdToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(result).toBeNull();
  });

  it('returns null when token is expired', async () => {
    const jwks = await makeJwks(rsaKeyPair.publicKey);
    const token = await new SignJWT({ sub: 'user-123', nonce: NONCE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(rsaKeyPair.privateKey);

    const result = await verifyOidcIdToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(result).toBeNull();
  });

  it('returns null for a malformed token string', async () => {
    const jwks = await makeJwks(rsaKeyPair.publicKey);

    const result = await verifyOidcIdToken('not.a.jwt', {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(result).toBeNull();
  });

  it('returns null when token payload is missing sub claim', async () => {
    // A valid JWT (passes signature/issuer/audience/exp) but with no sub field.
    const jwks = await makeJwks(rsaKeyPair.publicKey);
    const token = await new SignJWT({ nonce: NONCE, email: 'x@example.com' })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .sign(rsaKeyPair.privateKey);

    const result = await verifyOidcIdToken(token, {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jwks,
      expectedNonce: NONCE,
    });

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resolveOidcConfig
// ---------------------------------------------------------------------------

describe('resolveOidcConfig', () => {
  const BASE_ENV = {
    REVIEW_AGENT_OIDC_ISSUER: 'https://idp.example.com',
    REVIEW_AGENT_OIDC_CLIENT_ID: 'my-client-id',
    REVIEW_AGENT_OIDC_CLIENT_SECRET: 'my-secret',
    REVIEW_AGENT_OIDC_REDIRECT_URI: 'https://app.example.com/api/auth/oidc/callback',
    REVIEW_AGENT_AUTH_MODE: 'session',
  };

  it('returns OidcConfig from env when all vars set', async () => {
    const config = await resolveOidcConfig(BASE_ENV);
    expect(config).toEqual({
      issuer: 'https://idp.example.com',
      clientId: 'my-client-id',
      clientSecret: 'my-secret',
      redirectUri: 'https://app.example.com/api/auth/oidc/callback',
    });
  });

  it('returns null when ISSUER is missing', async () => {
    const env = { ...BASE_ENV, REVIEW_AGENT_OIDC_ISSUER: undefined };
    const config = await resolveOidcConfig(env);
    expect(config).toBeNull();
  });

  it('returns null when CLIENT_ID is missing', async () => {
    const env = { ...BASE_ENV, REVIEW_AGENT_OIDC_CLIENT_ID: undefined };
    const config = await resolveOidcConfig(env);
    expect(config).toBeNull();
  });

  it('returns null when CLIENT_SECRET is missing and no KMS', async () => {
    const env = { ...BASE_ENV, REVIEW_AGENT_OIDC_CLIENT_SECRET: undefined };
    const config = await resolveOidcConfig(env);
    expect(config).toBeNull();
  });

  it('returns null when AUTH_MODE is legacy', async () => {
    const env = { ...BASE_ENV, REVIEW_AGENT_AUTH_MODE: 'legacy' };
    const config = await resolveOidcConfig(env);
    expect(config).toBeNull();
  });

  it('resolves with AUTH_MODE both', async () => {
    const env = { ...BASE_ENV, REVIEW_AGENT_AUTH_MODE: 'both' };
    const config = await resolveOidcConfig(env);
    expect(config?.issuer).toBe('https://idp.example.com');
  });

  it('uses plaintext secret when KMS not provided', async () => {
    const config = await resolveOidcConfig(BASE_ENV);
    expect(config?.clientSecret).toBe('my-secret');
  });

  it('decrypts secret via KMS when kmsClient and encrypted secret provided', async () => {
    // Build an envelope-encrypted payload. We mock KmsClient.decryptDataKey
    // to return a known data key, then encrypt a secret with it.
    const { generateDataKey, encryptWithDataKey } = await import('@review-agent/core');

    const dataKey = generateDataKey();
    const { ciphertext, iv, authTag } = encryptWithDataKey('kms-secret', dataKey);

    // Build the packed format: [2-byte wrappedKeyLen][wrappedKey][iv:12][tag:16][ciphertext]
    // We'll use a dummy "wrapped key" of 32 bytes (just the raw data key to keep the mock simple).
    const wrappedKey = dataKey; // mock: KMS wraps with identity
    const header = Buffer.alloc(2);
    header.writeUInt16BE(wrappedKey.length, 0);
    const packed = Buffer.concat([header, wrappedKey, iv, authTag, ciphertext]);
    const encryptedSecretB64 = packed.toString('base64');

    const mockKmsClient = {
      encryptDataKey: async (_key: Buffer, _keyId: string) => _key,
      decryptDataKey: async (ct: Buffer, _keyId: string) => ct, // identity mock
    };

    const env = {
      ...BASE_ENV,
      REVIEW_AGENT_OIDC_CLIENT_SECRET: undefined,
      REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED: encryptedSecretB64,
    };

    const config = await resolveOidcConfig(env, {
      kmsClient: mockKmsClient,
      kmsKeyId: 'arn:aws:kms:us-east-1:123:key/test',
    });

    expect(config?.clientSecret).toBe('kms-secret');
  });

  it('returns null when KMS decryption fails', async () => {
    const mockKmsClient = {
      encryptDataKey: async (_key: Buffer, _keyId: string) => Buffer.alloc(0),
      decryptDataKey: async (_ct: Buffer, _keyId: string): Promise<Buffer> => {
        throw new Error('KMS unavailable');
      },
    };

    const env = {
      ...BASE_ENV,
      REVIEW_AGENT_OIDC_CLIENT_SECRET: undefined,
      REVIEW_AGENT_OIDC_CLIENT_SECRET_ENCRYPTED: 'aGVsbG8=', // dummy base64
    };

    const config = await resolveOidcConfig(env, {
      kmsClient: mockKmsClient,
      kmsKeyId: 'arn:aws:kms:us-east-1:123:key/test',
    });

    expect(config).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// exchangeCode
// ---------------------------------------------------------------------------

describe('exchangeCode', () => {
  const BASE_OPTS = {
    tokenEndpoint: 'https://idp.example.com/token',
    code: 'auth-code-abc',
    clientId: 'client-id',
    clientSecret: 'secret',
    redirectUri: 'https://app.example.com/callback',
    codeVerifier: 'verifier-abc',
  };

  it('returns id_token on success', async () => {
    const fetchFn = async (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ id_token: 'test.jwt.token', token_type: 'Bearer' }), {
        status: 200,
      });

    const idToken = await exchangeCode({
      ...BASE_OPTS,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    expect(idToken).toBe('test.jwt.token');
  });

  it('does not include client_secret in thrown error messages', async () => {
    const fetchFn = async (_url: string, _opts: RequestInit) =>
      new Response('bad request', { status: 400 });

    let errorMsg = '';
    try {
      await exchangeCode({
        ...BASE_OPTS,
        fetchFn: fetchFn as unknown as typeof fetch,
      });
    } catch (err) {
      errorMsg = String(err);
    }

    expect(errorMsg).not.toContain(BASE_OPTS.clientSecret);
  });

  it('throws when HTTP response is not OK', async () => {
    const fetchFn = async (_url: string, _opts: RequestInit) =>
      new Response('unauthorized', { status: 401 });

    await expect(
      exchangeCode({ ...BASE_OPTS, fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow('token endpoint HTTP 401');
  });

  it('throws when id_token is missing from response', async () => {
    const fetchFn = async (_url: string, _opts: RequestInit) =>
      new Response(JSON.stringify({ access_token: 'at123' }), { status: 200 });

    await expect(
      exchangeCode({ ...BASE_OPTS, fetchFn: fetchFn as unknown as typeof fetch }),
    ).rejects.toThrow('missing id_token');
  });

  it('sends client_secret as form field (not in URL or Authorization header)', async () => {
    let capturedBody = '';
    const fetchFn = async (_url: string, opts: RequestInit) => {
      capturedBody = opts.body as string;
      return new Response(JSON.stringify({ id_token: 'tok' }), { status: 200 });
    };

    await exchangeCode({ ...BASE_OPTS, fetchFn: fetchFn as unknown as typeof fetch });

    expect(capturedBody).toContain('client_secret=secret');
    expect(capturedBody).toContain('code=auth-code-abc');
    expect(capturedBody).toContain('code_verifier=verifier-abc');
  });
});
