/**
 * Tests for sessionAuth middleware.
 *
 * Covers the full behaviour matrix from the issue #161 spec:
 *   MODE    | HEADER          | EXPECTED
 *   --------|-----------------|------------------------------------------
 *   legacy  | Bearer <shared> | 200, no principal set
 *   legacy  | missing/bad     | 401
 *   session | Bearer <JWT>    | 200, principal set
 *   session | shared/bad      | 401
 *   both    | Bearer <JWT>    | 200, principal set
 *   both    | Bearer <shared> | 200, no principal set
 *   both    | missing/bad     | 401
 *   any     | OPTIONS         | 200 (CORS preflight)
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { issueSessionToken } from '../jwt.js';
import { sessionAuth } from '../session-auth.js';
import type { ContextPrincipal } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SHARED_TOKEN = 'shared-dashboard-token-abc123';
const SESSION_SECRET = 'a-very-long-session-secret-for-tests!!';

const PRINCIPAL = {
  principalId: 'user-1',
  username: 'alice',
  tokenVersion: 1,
};

// ---------------------------------------------------------------------------
// DB mock factory
//
// Simulates findPrincipalById — the only DB call sessionAuth makes.
// Returns the principal when id matches; null otherwise.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeFakeDb(opts: { exists?: boolean; tokenVersion?: number } = {}): any {
  const { exists = true, tokenVersion = PRINCIPAL.tokenVersion } = opts;
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve(
              exists
                ? [
                    {
                      id: PRINCIPAL.principalId,
                      username: PRINCIPAL.username,
                      passwordHash: 'hash',
                      tokenVersion,
                    },
                  ]
                : [],
            ),
        }),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

function makeApp(opts: Parameters<typeof sessionAuth>[0]) {
  const app = new Hono();
  app.use('*', sessionAuth(opts));
  app.get('/test', (c) => {
    const principal: ContextPrincipal | undefined = c.get('principal' as never);
    return c.json({ ok: true, principal: principal ?? null }, 200);
  });
  app.on('OPTIONS', '/test', (c) => c.json({ ok: true }, 200));
  return app;
}

// ---------------------------------------------------------------------------
// Helper: issue a valid JWT
// ---------------------------------------------------------------------------

async function makeJwt(ttlSeconds = 3600) {
  return issueSessionToken(PRINCIPAL, SESSION_SECRET, ttlSeconds);
}

// ---------------------------------------------------------------------------
// OPTIONS preflight — all modes
// ---------------------------------------------------------------------------

describe('OPTIONS preflight', () => {
  for (const authMode of ['legacy', 'session', 'both'] as const) {
    it(`passes OPTIONS through in ${authMode} mode`, async () => {
      const db = makeFakeDb();
      const app = makeApp({
        authMode,
        sharedToken: SHARED_TOKEN,
        sessionSecret: SESSION_SECRET,
        db,
      });
      const res = await app.request('http://host/test', { method: 'OPTIONS' });
      expect(res.status).toBe(200);
    });
  }
});

// ---------------------------------------------------------------------------
// Legacy mode
// ---------------------------------------------------------------------------

describe('legacy mode', () => {
  it('passes with correct shared bearer token', async () => {
    const app = makeApp({
      authMode: 'legacy',
      sharedToken: SHARED_TOKEN,
      db: undefined,
      sessionSecret: undefined,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${SHARED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principal).toBeNull(); // no principal in legacy mode
  });

  it('returns 401 for missing Authorization header', async () => {
    const app = makeApp({
      authMode: 'legacy',
      sharedToken: SHARED_TOKEN,
      db: undefined,
      sessionSecret: undefined,
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(401);
  });

  it('returns 401 for wrong shared token', async () => {
    const app = makeApp({
      authMode: 'legacy',
      sharedToken: SHARED_TOKEN,
      db: undefined,
      sessionSecret: undefined,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('passes through when sharedToken is unset and requireAuth=false', async () => {
    const app = makeApp({
      authMode: 'legacy',
      sharedToken: undefined,
      requireAuth: false,
      db: undefined,
      sessionSecret: undefined,
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(200);
  });

  it('returns 503 when sharedToken is unset and requireAuth=true', async () => {
    const app = makeApp({
      authMode: 'legacy',
      sharedToken: undefined,
      requireAuth: true,
      db: undefined,
      sessionSecret: undefined,
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(503);
  });

  it('returns 401 when JWT is presented (JWT not accepted in legacy)', async () => {
    const db = makeFakeDb();
    const jwt = await makeJwt();
    const app = makeApp({
      authMode: 'legacy',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // JWT looks like a string, not SHARED_TOKEN → timingSafeEqual fails → 401
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Session mode
// ---------------------------------------------------------------------------

describe('session mode', () => {
  it('returns 200 and sets principal with valid JWT', async () => {
    const db = makeFakeDb();
    const jwt = await makeJwt();
    const app = makeApp({
      authMode: 'session',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principal).not.toBeNull();
    expect(body.principal.id).toBe(PRINCIPAL.principalId);
  });

  it('returns 401 for shared token in session mode', async () => {
    const db = makeFakeDb();
    const app = makeApp({
      authMode: 'session',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${SHARED_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for missing Authorization header', async () => {
    const db = makeFakeDb();
    const app = makeApp({
      authMode: 'session',
      sharedToken: undefined,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(401);
  });

  it('returns 401 for expired JWT', async () => {
    const db = makeFakeDb();
    const expiredJwt = await makeJwt(-1);
    const app = makeApp({
      authMode: 'session',
      sharedToken: undefined,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${expiredJwt}` },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when principal does not exist in DB', async () => {
    const db = makeFakeDb({ exists: false });
    const jwt = await makeJwt();
    const app = makeApp({
      authMode: 'session',
      sharedToken: undefined,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when tokenVersion is stale (revocation)', async () => {
    // JWT has tokenVersion=1, DB has tokenVersion=2 (password changed)
    const db = makeFakeDb({ exists: true, tokenVersion: 2 });
    const jwt = await makeJwt(); // tokenVersion=1
    const app = makeApp({
      authMode: 'session',
      sharedToken: undefined,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Both mode
// ---------------------------------------------------------------------------

describe('both mode', () => {
  it('accepts valid JWT and sets principal', async () => {
    const db = makeFakeDb();
    const jwt = await makeJwt();
    const app = makeApp({
      authMode: 'both',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principal?.id).toBe(PRINCIPAL.principalId);
  });

  it('falls back to shared token when JWT verification fails', async () => {
    const db = makeFakeDb();
    const jwt = await issueSessionToken(PRINCIPAL, 'wrong-secret-that-is-long-enough', 3600);
    const app = makeApp({
      authMode: 'both',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    // JWT fails with wrong secret, but token has dots → tried as JWT, fails,
    // then also tried as shared token → fails (jwt !== SHARED_TOKEN)
    expect(res.status).toBe(401);
  });

  it('accepts shared token (non-JWT format) as fallback', async () => {
    const db = makeFakeDb();
    const app = makeApp({
      authMode: 'both',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: `Bearer ${SHARED_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.principal).toBeNull(); // shared token path — no principal
  });

  it('returns 401 for missing Authorization header', async () => {
    const db = makeFakeDb();
    const app = makeApp({
      authMode: 'both',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(401);
  });

  it('returns 401 when both JWT and shared token fail', async () => {
    const db = makeFakeDb();
    const app = makeApp({
      authMode: 'both',
      sharedToken: SHARED_TOKEN,
      db,
      sessionSecret: SESSION_SECRET,
    });
    const res = await app.request('http://host/test', {
      headers: { Authorization: 'Bearer completely-wrong-value' },
    });
    expect(res.status).toBe(401);
  });
});
