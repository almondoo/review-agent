/**
 * Tests for POST /auth/login, POST /auth/logout, GET /auth/me.
 *
 * Uses createApi with appropriate deps.
 * Since login is registered outside sessionAuth in createApi, we test it
 * through the full createApi stack.
 */
import { hashPassword } from '@review-agent/core';
import { installationMemberships, operatorPrincipals } from '@review-agent/core/db';
import { describe, expect, it } from 'vitest';
import { issueSessionToken } from '../../auth/jwt.js';
import { createApi } from '../index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_SECRET = 'a-test-secret-that-is-at-least-32-chars!!';
const PRINCIPAL_ID = 'p-test-1';
const USERNAME = 'alice';
const PASSWORD = 'hunter2';
const TOKEN_VERSION = 1;

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

type PrincipalRow = {
  id: string;
  username: string;
  passwordHash: string;
  tokenVersion: number;
};

type MembershipRow = {
  principalId: string;
  installationId: bigint;
  role: string;
};

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeDb(principals: PrincipalRow[], memberships: MembershipRow[] = []): any {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          // Some callers await .where() directly (getMembershipsByPrincipal).
          // Others chain .limit(n) after .where() (findPrincipalBy*).
          // Return an object that is both a Promise and has .limit().
          const rows =
            table === operatorPrincipals
              ? principals
              : table === installationMemberships
                ? memberships
                : [];
          const p: Promise<unknown[]> & { limit: (n: number) => Promise<unknown[]> } =
            Object.assign(Promise.resolve(rows), {
              limit: (n: number) => Promise.resolve(rows.slice(0, n)),
            });
          return p;
        },
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  };
}

const PRINCIPAL_HASH = hashPassword(PASSWORD);

// ---------------------------------------------------------------------------
// createApi helpers
// ---------------------------------------------------------------------------

function makeSessionApi(opts: { principals?: PrincipalRow[]; memberships?: MembershipRow[] } = {}) {
  const db = makeDb(opts.principals ?? [], opts.memberships ?? []);
  return createApi({
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    db: db as any,
    env: {},
    authMode: 'session',
    sessionSecret: SESSION_SECRET,
    sessionTtlSeconds: 3600,
  });
}

function makeLegacyApi() {
  const db = makeDb([]);
  return createApi({
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    db: db as any,
    env: {},
    authMode: 'legacy',
    dashboardToken: 'shared-legacy-token',
  });
}

// ---------------------------------------------------------------------------
// POST /auth/login
// ---------------------------------------------------------------------------

describe('POST /auth/login — legacy mode → 404', () => {
  it('returns 404 in legacy mode', async () => {
    const api = makeLegacyApi();
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'hunter2' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /auth/login — session mode', () => {
  it('returns 401 for wrong password', async () => {
    const api = makeSessionApi({
      principals: [
        {
          id: PRINCIPAL_ID,
          username: USERNAME,
          passwordHash: PRINCIPAL_HASH,
          tokenVersion: TOKEN_VERSION,
        },
      ],
    });
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: 'wrongpassword' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid credentials');
  });

  it('returns 401 for unknown username', async () => {
    const api = makeSessionApi({ principals: [] });
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nonexistent', password: 'password' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid credentials');
  });

  it('returns 200 with token for correct credentials', async () => {
    const api = makeSessionApi({
      principals: [
        {
          id: PRINCIPAL_ID,
          username: USERNAME,
          passwordHash: PRINCIPAL_HASH,
          tokenVersion: TOKEN_VERSION,
        },
      ],
    });
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.').length).toBe(3); // valid JWT shape
    expect(body.expiresIn).toBe(3600);
  });

  it('returns 400 for invalid JSON body', async () => {
    const api = makeSessionApi();
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 422 for missing fields', async () => {
    const api = makeSessionApi();
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }), // missing password
    });
    expect(res.status).toBe(422);
  });

  it('login is accessible without Authentication header (unauthenticated)', async () => {
    const api = makeSessionApi({ principals: [] });
    // No Authorization header — should not get 401 from sessionAuth
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'password' }),
    });
    // Should be 401 from login logic (invalid credentials), NOT from sessionAuth
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid credentials');
  });

  it('returns 401 for OIDC principal (null passwordHash) — password login refused', async () => {
    // An OIDC-provisioned principal has passwordHash = null.
    // The login endpoint must refuse and return 'invalid credentials',
    // not 500 or a different error code.
    const api = makeSessionApi({
      principals: [
        {
          id: 'oidc-p-1',
          username: 'oidcuser',
          passwordHash: null as unknown as string, // OIDC: no password stored
          tokenVersion: 1,
        },
      ],
    });
    const res = await api.request('http://host/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'oidcuser', password: 'anypassword' }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('invalid credentials');
  });
});

// ---------------------------------------------------------------------------
// POST /auth/logout
// ---------------------------------------------------------------------------

describe('POST /auth/logout', () => {
  it('returns 204 with a valid JWT', async () => {
    const db = makeDb([
      {
        id: PRINCIPAL_ID,
        username: USERNAME,
        passwordHash: PRINCIPAL_HASH,
        tokenVersion: TOKEN_VERSION,
      },
    ]);
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      authMode: 'session',
      sessionSecret: SESSION_SECRET,
      sessionTtlSeconds: 3600,
    });
    const jwt = await issueSessionToken(
      { principalId: PRINCIPAL_ID, username: USERNAME, tokenVersion: TOKEN_VERSION },
      SESSION_SECRET,
      3600,
    );
    const res = await api.request('http://host/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(204);
  });

  it('returns 401 without Authorization header', async () => {
    const api = makeSessionApi();
    const res = await api.request('http://host/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /auth/me
// ---------------------------------------------------------------------------

describe('GET /auth/me', () => {
  it('returns principal info for JWT auth', async () => {
    const memberships = [{ principalId: PRINCIPAL_ID, installationId: BigInt(42), role: 'admin' }];
    const db = makeDb(
      [
        {
          id: PRINCIPAL_ID,
          username: USERNAME,
          passwordHash: PRINCIPAL_HASH,
          tokenVersion: TOKEN_VERSION,
        },
      ],
      memberships,
    );
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      authMode: 'session',
      sessionSecret: SESSION_SECRET,
      sessionTtlSeconds: 3600,
    });
    const jwt = await issueSessionToken(
      { principalId: PRINCIPAL_ID, username: USERNAME, tokenVersion: TOKEN_VERSION },
      SESSION_SECRET,
      3600,
    );
    const res = await api.request('http://host/auth/me', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.legacy).toBe(false);
    expect(body.principal.id).toBe(PRINCIPAL_ID);
    expect(body.principal.username).toBe(USERNAME);
    expect(Array.isArray(body.memberships)).toBe(true);
  });

  it('returns legacy=true for shared-token auth in both mode', async () => {
    const db = makeDb([]);
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      authMode: 'both',
      sessionSecret: SESSION_SECRET,
      sessionTtlSeconds: 3600,
      dashboardToken: 'shared-token-xyz',
    });
    const res = await api.request('http://host/auth/me', {
      headers: { Authorization: 'Bearer shared-token-xyz' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.legacy).toBe(true);
  });

  it('returns 401 without Authorization header', async () => {
    const api = makeSessionApi();
    const res = await api.request('http://host/auth/me');
    expect(res.status).toBe(401);
  });
});
