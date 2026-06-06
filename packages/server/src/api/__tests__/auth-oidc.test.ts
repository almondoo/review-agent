/**
 * Tests for OIDC endpoints: GET /api/auth/config, /api/auth/oidc/authorize, /api/auth/oidc/callback
 *
 * Covers:
 *   - /config: oidcEnabled true/false
 *   - /authorize: 404 when disabled, cookie + redirect when enabled
 *   - /callback: state mismatch 400, code exchange → id_token verify → JIT upsert → JWT → redirect
 *     (new user and existing user), missing code 400, id_token invalid 401
 *
 * Uses createOidcRouter directly to avoid the full createApi graph.
 */

import { SignJWT } from 'jose/jwt/sign';
import { exportJWK } from 'jose/key/export';
import { generateKeyPair } from 'jose/key/generate/keypair';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet } from '../../auth/oidc.js';
import { createOidcRouter } from '../auth-oidc.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'test-client-id';
const REDIRECT_URI = 'https://app.example.com/api/auth/oidc/callback';
const SESSION_SECRET = 'a-strong-session-secret-for-oidc-tests!';

const OIDC_CONFIG = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  clientSecret: 'test-client-secret',
  redirectUri: REDIRECT_URI,
};

const VALID_DISCOVERY = {
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
};

type KeyPair = { privateKey: CryptoKey; publicKey: CryptoKey };
let rsaKeyPair: KeyPair;
// biome-ignore lint/suspicious/noExplicitAny: jose JWKS resolver
let localJwks: any;

beforeAll(async () => {
  rsaKeyPair = await generateKeyPair('RS256');
  const jwk = await exportJWK(rsaKeyPair.publicKey);
  localJwks = createLocalJWKSet({ keys: [jwk] });
});

/**
 * A minimal DB mock that simulates the upsertOidcPrincipal flow:
 * - findPrincipalByExternalId: returns empty (new user) or existing row
 * - insert: succeeds (no conflict)
 */
function makeUpsertDb(opts: { existingId?: string; existingUsername?: string } = {}) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              opts.existingId !== undefined
                ? [
                    {
                      id: opts.existingId,
                      username: opts.existingUsername ?? 'existing-user',
                      tokenVersion: 0,
                    },
                  ]
                : [],
            ),
        }),
      }),
    }),
    insert: () => ({
      values: (_v: unknown) => Promise.resolve(),
    }),
  };
}

// ---------------------------------------------------------------------------
// Mock fetch — returns discovery + token endpoint responses
// ---------------------------------------------------------------------------

function makeDiscoveryFetch(tokenResponse: Record<string, unknown> = {}) {
  return async (url: string, _opts?: RequestInit) => {
    if (url.includes('openid-configuration')) {
      return new Response(JSON.stringify(VALID_DISCOVERY), { status: 200 });
    }
    if (url.includes('/token')) {
      return new Response(JSON.stringify(tokenResponse), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
}

// ---------------------------------------------------------------------------
// Helper: sign an id_token for tests
// ---------------------------------------------------------------------------

async function signIdToken(claims: Record<string, unknown>, nonce: string): Promise<string> {
  return new SignJWT({ ...claims, nonce })
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer(ISSUER)
    .setAudience(CLIENT_ID)
    .sign(rsaKeyPair.privateKey);
}

// ---------------------------------------------------------------------------
// Helper: make a Hono Request with cookies set
// ---------------------------------------------------------------------------

function makeRequestWithCookies(url: string, cookies: Record<string, string>): Request {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('; ');
  return new Request(url, { headers: { Cookie: cookieHeader } });
}

// ---------------------------------------------------------------------------
// GET /config
// ---------------------------------------------------------------------------

describe('GET /config', () => {
  it('returns oidcEnabled: true when oidcConfig is provided', async () => {
    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
    });

    const res = await router.request('http://host/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ oidcEnabled: true });
  });

  it('returns oidcEnabled: false when oidcConfig is null', async () => {
    const router = createOidcRouter({
      oidcConfig: null,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
    });

    const res = await router.request('http://host/config');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ oidcEnabled: false });
  });
});

// ---------------------------------------------------------------------------
// GET /oidc/authorize
// ---------------------------------------------------------------------------

describe('GET /oidc/authorize', () => {
  it('returns 404 when OIDC is disabled', async () => {
    const router = createOidcRouter({
      oidcConfig: null,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
    });

    const res = await router.request('http://host/oidc/authorize');
    expect(res.status).toBe(404);
  });

  it('redirects to IdP authorization_endpoint when enabled', async () => {
    const fetchFn = makeDiscoveryFetch();

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const res = await router.request('http://host/oidc/authorize');
    expect(res.status).toBe(302);

    const location = res.headers.get('Location') ?? '';
    expect(location).toContain(`${ISSUER}/authorize`);
    expect(location).toContain(`client_id=${CLIENT_ID}`);
    expect(location).toContain('response_type=code');
    expect(location).toContain('code_challenge_method=S256');
    expect(location).toContain('scope=openid+profile+email');
    expect(location).toContain('nonce=');
    expect(location).toContain('state=');
  });

  it('sets HttpOnly SameSite=Lax cookies for state, nonce, and verifier', async () => {
    const fetchFn = makeDiscoveryFetch();

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const res = await router.request('http://host/oidc/authorize');
    const cookies = res.headers.getSetCookie?.() ?? [];
    const cookieStr = cookies.join('; ');

    expect(cookieStr).toContain('oidc_state=');
    expect(cookieStr).toContain('oidc_nonce=');
    expect(cookieStr).toContain('oidc_pkce_verifier=');
    expect(cookieStr.toLowerCase()).toContain('httponly');
    expect(cookieStr.toLowerCase()).toContain('samesite=lax');
  });

  it('returns 502 when discovery fails', async () => {
    const fetchFn = async (_url: string) => new Response('server error', { status: 500 });

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const res = await router.request('http://host/oidc/authorize');
    expect(res.status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// GET /oidc/callback
// ---------------------------------------------------------------------------

describe('GET /oidc/callback', () => {
  it('returns 404 when OIDC is disabled', async () => {
    const router = createOidcRouter({
      oidcConfig: null,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
    });

    const res = await router.request('http://host/oidc/callback?code=abc&state=xyz');
    expect(res.status).toBe(404);
  });

  it('returns 400 on state mismatch', async () => {
    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: makeDiscoveryFetch() as unknown as typeof fetch,
    });

    const req = makeRequestWithCookies('http://host/oidc/callback?code=abc&state=wrong-state', {
      oidc_state: 'correct-state',
      oidc_nonce: 'test-nonce',
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'state_mismatch' });
  });

  it('returns 400 when code is missing', async () => {
    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: makeDiscoveryFetch() as unknown as typeof fetch,
    });

    const req = makeRequestWithCookies('http://host/oidc/callback?state=my-state', {
      oidc_state: 'my-state',
      oidc_nonce: 'test-nonce',
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'missing_code' });
  });

  it('returns 401 when id_token verification fails', async () => {
    // Return a garbage id_token.
    const fetchFn = makeDiscoveryFetch({ id_token: 'invalid.token.payload' });

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const state = 'valid-state-value';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=abc&state=${state}`, {
      oidc_state: state,
      oidc_nonce: 'test-nonce',
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'id_token_invalid' });
  });

  it('issues JWT and redirects on valid callback (new user)', async () => {
    const nonce = 'unique-nonce-for-callback-test';
    const idToken = await signIdToken(
      { sub: 'user-sub-123', email: 'alice@example.com', preferred_username: 'alice' },
      nonce,
    );

    const fetchFn = makeDiscoveryFetch({ id_token: idToken });

    // New user — findPrincipalByExternalId returns empty, insert succeeds.
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = makeUpsertDb() as any;

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      db,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
      dashboardOrigin: 'https://app.example.com',
      generateId: () => 'generated-id-001',
    });

    const state = 'callback-state-value';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=auth-code&state=${state}`, {
      oidc_state: state,
      oidc_nonce: nonce,
      oidc_pkce_verifier: 'pkce-verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(302);

    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('https://app.example.com/');
    expect(location).toContain('#token=');

    // Token in fragment — extract and verify it's a JWT (3 parts).
    const fragmentMatch = location.match(/#token=([^&]+)/);
    expect(fragmentMatch).not.toBeNull();
    const rawToken = decodeURIComponent(fragmentMatch?.[1] ?? '');
    expect(rawToken.split('.').length).toBe(3);
  });

  it('issues JWT and redirects on valid callback (existing user)', async () => {
    const nonce = 'nonce-existing-user';
    const idToken = await signIdToken({ sub: 'existing-sub-456' }, nonce);
    const fetchFn = makeDiscoveryFetch({ id_token: idToken });

    // Existing user — findPrincipalByExternalId returns a row.
    const rawDb = makeUpsertDb({ existingId: 'existing-principal-id', existingUsername: 'bob' });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = rawDb as any;

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      db,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
      dashboardOrigin: 'https://app.example.com',
    });

    const state = 'state-existing-user';
    const req = makeRequestWithCookies(
      `http://host/oidc/callback?code=code-existing&state=${state}`,
      {
        oidc_state: state,
        oidc_nonce: nonce,
        oidc_pkce_verifier: 'verifier-existing',
      },
    );

    const res = await router.request(req);
    expect(res.status).toBe(302);

    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('#token=');
  });

  it('returns 400 when state cookie is missing', async () => {
    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: makeDiscoveryFetch() as unknown as typeof fetch,
    });

    // No cookies at all.
    const res = await router.request('http://host/oidc/callback?code=abc&state=xyz');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'state_mismatch' });
  });

  it('returns 503 when session secret is not configured', async () => {
    const nonce = 'nonce-no-secret';
    const idToken = await signIdToken({ sub: 'user-abc' }, nonce);
    const fetchFn = makeDiscoveryFetch({ id_token: idToken });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = makeUpsertDb() as any;

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      db,
      sessionSecret: undefined,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const state = 'state-no-secret';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=code&state=${state}`, {
      oidc_state: state,
      oidc_nonce: nonce,
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'session_secret_not_configured' });
  });

  it('does not log id_token or client_secret in error paths', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write');
    const fetchFn = makeDiscoveryFetch({ id_token: 'bad.token.here' });

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const state = 'log-test-state';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=abc&state=${state}`, {
      oidc_state: state,
      oidc_nonce: 'nonce',
      oidc_pkce_verifier: 'verifier',
    });

    await router.request(req);

    // No log entry should contain the client secret or id_token value.
    const calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    for (const msg of calls) {
      expect(msg).not.toContain('test-client-secret');
      expect(msg).not.toContain('bad.token.here');
    }

    stderrSpy.mockRestore();
  });

  it('returns 502 when token exchange fails (HTTP error from IdP)', async () => {
    // Discovery succeeds but token endpoint returns error.
    const fetchFn = async (url: string, _opts?: RequestInit) => {
      if (url.includes('openid-configuration')) {
        return new Response(JSON.stringify(VALID_DISCOVERY), { status: 200 });
      }
      return new Response('unauthorized', { status: 401 });
    };

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const state = 'exchange-fail-state';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=bad-code&state=${state}`, {
      oidc_state: state,
      oidc_nonce: 'nonce',
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'token_exchange_failed' });
  });

  it('returns 500 when principal upsert fails', async () => {
    const nonce = 'nonce-upsert-fail';
    const idToken = await signIdToken({ sub: 'user-upsert-err' }, nonce);
    const fetchFn = makeDiscoveryFetch({ id_token: idToken });

    // DB mock that throws on insert.
    const failDb = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]), // no existing principal
          }),
        }),
      }),
      insert: () => ({
        values: () => {
          throw new Error('DB connection lost');
        },
      }),
    };

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: failDb as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const state = 'upsert-fail-state';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=code&state=${state}`, {
      oidc_state: state,
      oidc_nonce: nonce,
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'principal_upsert_failed' });
  });

  it('uses email local-part as username when preferred_username is absent', async () => {
    const nonce = 'nonce-email-fallback';
    // No preferred_username — email local-part should be used.
    const idToken = await signIdToken({ sub: 'user-email-only', email: 'bob@example.com' }, nonce);
    const fetchFn = makeDiscoveryFetch({ id_token: idToken });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = makeUpsertDb() as any;

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      db,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
      dashboardOrigin: 'https://app.example.com',
      generateId: () => 'email-id-001',
    });

    const state = 'state-email-fallback';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=code&state=${state}`, {
      oidc_state: state,
      oidc_nonce: nonce,
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    // Should succeed and redirect with a token.
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('#token=');
  });

  it('uses sub as username when both preferred_username and email are absent', async () => {
    const nonce = 'nonce-sub-fallback';
    // No preferred_username, no email — sub is used as username.
    const idToken = await signIdToken({ sub: 'bare-sub-user' }, nonce);
    const fetchFn = makeDiscoveryFetch({ id_token: idToken });
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = makeUpsertDb() as any;

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      db,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
      dashboardOrigin: 'https://app.example.com',
      generateId: () => 'sub-id-001',
    });

    const state = 'state-sub-fallback';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=code&state=${state}`, {
      oidc_state: state,
      oidc_nonce: nonce,
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('#token=');
  });

  it('returns 502 when discovery fails in callback', async () => {
    const fetchFn = async (_url: string) => new Response('server error', { status: 500 });

    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: fetchFn as unknown as typeof fetch,
    });

    const state = 'discovery-fail-state';
    const req = makeRequestWithCookies(`http://host/oidc/callback?code=abc&state=${state}`, {
      oidc_state: state,
      oidc_nonce: 'nonce',
      oidc_pkce_verifier: 'verifier',
    });

    const res = await router.request(req);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'oidc_discovery_failed' });
  });

  it('returns 400 when nonce cookie is missing', async () => {
    const router = createOidcRouter({
      oidcConfig: OIDC_CONFIG,
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeUpsertDb() as any,
      sessionSecret: SESSION_SECRET,
      jwks: localJwks,
      fetchFn: makeDiscoveryFetch() as unknown as typeof fetch,
    });

    // state matches but nonce cookie is absent.
    const req = makeRequestWithCookies('http://host/oidc/callback?code=abc&state=mystate', {
      oidc_state: 'mystate',
      oidc_pkce_verifier: 'verifier',
      // oidc_nonce deliberately omitted
    });

    const res = await router.request(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'missing_oidc_cookies' });
  });
});
