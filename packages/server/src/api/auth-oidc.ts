/**
 * OIDC Authorization Code + PKCE endpoints (issue #137, Phase B).
 *
 * Routes (all OUTSIDE sessionAuth — registered before api.use('*')):
 *   GET /api/auth/config             — { oidcEnabled: boolean } for web SSO button
 *   GET /api/auth/oidc/authorize     — redirect to IdP; set state/nonce/verifier cookies
 *   GET /api/auth/oidc/callback      — validate state, exchange code, issue session JWT
 *
 * Security invariants:
 *   - state cookie validated with timingSafeEqual (constant-time, anti-CSRF).
 *   - nonce validated inside id_token (replay protection).
 *   - PKCE S256 code_verifier validated by IdP (code-injection protection).
 *   - client_secret never logged.
 *   - id_token issuer / audience / nonce / exp validated by jose jwtVerify.
 *   - Session JWT issued via issueSessionToken (same as password login path).
 *   - Callback fragment-delivers the token (#token=…) for SPA compatibility.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { DbClient } from '@review-agent/db';
import { upsertOidcPrincipal } from '@review-agent/db';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { issueSessionToken } from '../auth/jwt.js';
import {
  createPkce,
  createRemoteJWKSet,
  discoverOidc,
  exchangeCode,
  type OidcConfig,
  verifyOidcIdToken,
} from '../auth/oidc.js';

// ---------------------------------------------------------------------------
// Cookie names and max-ages
// ---------------------------------------------------------------------------

const OIDC_STATE_COOKIE = 'oidc_state';
const OIDC_NONCE_COOKIE = 'oidc_nonce';
const OIDC_VERIFIER_COOKIE = 'oidc_pkce_verifier';
/** 10 minutes — matches github-setup.ts STATE_MAX_AGE */
const OIDC_STATE_MAX_AGE = 600;

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

export type OidcRouterDeps = {
  /** Resolved OidcConfig — null means OIDC is disabled. */
  readonly oidcConfig: OidcConfig | null;
  /** DB client for JIT principal upsert. */
  readonly db: DbClient;
  /** HS256 secret for session JWT issuance. Required when oidcConfig is non-null. */
  readonly sessionSecret: string | undefined;
  /** Session JWT TTL seconds. Default: 43200. */
  readonly sessionTtlSeconds?: number;
  /**
   * Dashboard origin URL for post-callback redirect (e.g. "https://app.example.com").
   * The callback delivers the token via fragment: `${dashboardOrigin}/#token=…`
   * When unset, redirects to `/#token=…` (relative, same origin).
   */
  readonly dashboardOrigin?: string;
  /**
   * DI: custom fetch for discovery + token exchange. Defaults to global fetch.
   * Tests inject a stub here to stay offline.
   */
  readonly fetchFn?: typeof fetch;
  /**
   * DI: override the JWKS resolver for tests.
   * In production this is created from the discovery jwks_uri.
   * Tests inject createLocalJWKSet(keySet).
   */
  // biome-ignore lint/suspicious/noExplicitAny: jose JWKS resolver
  readonly jwks?: any;
  /**
   * DI: override ID generation for JIT principal creation. Defaults to randomUUID().
   */
  readonly generateId?: () => string;
};

// ---------------------------------------------------------------------------
// Constant-time state comparison (mirrors github-setup.ts)
// ---------------------------------------------------------------------------

function compareState(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) {
    const dummy = Buffer.alloc(providedBuf.length);
    timingSafeEqual(providedBuf, dummy);
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

// ---------------------------------------------------------------------------
// Cookie helper — clear all OIDC flow cookies
// ---------------------------------------------------------------------------

function clearOidcCookies(c: Parameters<typeof setCookie>[0]): void {
  // Mirror the attributes the cookies were set with (HttpOnly/Secure/SameSite),
  // otherwise some browsers (notably Safari) won't match the deletion directive
  // to the original Secure cookie and leave a stale cookie in place.
  const opts = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' as const };
  deleteCookie(c, OIDC_STATE_COOKIE, opts);
  deleteCookie(c, OIDC_NONCE_COOKIE, opts);
  deleteCookie(c, OIDC_VERIFIER_COOKIE, opts);
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createOidcRouter(deps: OidcRouterDeps): Hono {
  const app = new Hono();
  const sessionTtlSeconds = deps.sessionTtlSeconds ?? 43200;

  // -------------------------------------------------------------------------
  // GET /config
  //
  // Unauthenticated. Returns whether OIDC SSO is available so the web can
  // conditionally render the "Sign in with SSO" button.
  // -------------------------------------------------------------------------
  app.get('/config', (c) => {
    return c.json({ oidcEnabled: deps.oidcConfig !== null }, 200);
  });

  // -------------------------------------------------------------------------
  // GET /oidc/authorize
  //
  // Initiates the OIDC Authorization Code + PKCE flow:
  //   1. Generate state (CSRF token), nonce, PKCE pair.
  //   2. Store all three in HttpOnly SameSite=Lax cookies (Max-Age 600).
  //   3. Redirect to the IdP authorization_endpoint.
  //
  // Returns 404 when OIDC is not configured.
  // -------------------------------------------------------------------------
  app.get('/oidc/authorize', async (c) => {
    const oidcConfig = deps.oidcConfig;
    if (oidcConfig === null) {
      return c.json({ error: 'oidc_not_configured' }, 404);
    }

    let discovery: Awaited<ReturnType<typeof discoverOidc>>;
    try {
      /* v8 ignore next 3 */
      discovery = await discoverOidc(oidcConfig.issuer, {
        ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
      });
    } catch (err) {
      process.stderr.write(`[review-agent] ERROR: OIDC discovery failed: ${String(err)}\n`);
      return c.json({ error: 'oidc_discovery_failed' }, 502);
    }

    const state = randomUUID();
    const nonce = randomUUID();
    const pkce = createPkce();

    const cookieOpts = {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax' as const,
      maxAge: OIDC_STATE_MAX_AGE,
      path: '/',
    };

    setCookie(c, OIDC_STATE_COOKIE, state, cookieOpts);
    setCookie(c, OIDC_NONCE_COOKIE, nonce, cookieOpts);
    setCookie(c, OIDC_VERIFIER_COOKIE, pkce.verifier, cookieOpts);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: oidcConfig.clientId,
      redirect_uri: oidcConfig.redirectUri,
      scope: 'openid profile email',
      state,
      nonce,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
    });

    return c.redirect(`${discovery.authorizationEndpoint}?${params.toString()}`, 302);
  });

  // -------------------------------------------------------------------------
  // GET /oidc/callback
  //
  // IdP redirect target. Validates CSRF state, exchanges code for id_token,
  // verifies the id_token, JIT-provisions the principal, issues a session JWT,
  // then redirects to the dashboard with the token in the URL fragment.
  //
  // Fragment (#token=…) is used so the token is never sent to the server in
  // a Referer header and is not stored in the browser's history as a query
  // parameter. The SPA reads it from location.hash.
  //
  // Error paths always clear OIDC cookies before returning.
  // -------------------------------------------------------------------------
  app.get('/oidc/callback', async (c) => {
    const oidcConfig = deps.oidcConfig;
    if (oidcConfig === null) {
      return c.json({ error: 'oidc_not_configured' }, 404);
    }

    const dashboardOrigin = deps.dashboardOrigin ?? '';

    // Retrieve cookies.
    const cookieState = getCookie(c, OIDC_STATE_COOKIE);
    const cookieNonce = getCookie(c, OIDC_NONCE_COOKIE);
    const cookieVerifier = getCookie(c, OIDC_VERIFIER_COOKIE);

    // Validate state (CSRF).
    const queryState = c.req.query('state') ?? '';
    if (!cookieState || !compareState(queryState, cookieState)) {
      clearOidcCookies(c);
      return c.json({ error: 'state_mismatch' }, 400);
    }

    // code is required.
    const code = c.req.query('code') ?? '';
    if (!code) {
      clearOidcCookies(c);
      return c.json({ error: 'missing_code' }, 400);
    }

    if (!cookieNonce || !cookieVerifier) {
      clearOidcCookies(c);
      return c.json({ error: 'missing_oidc_cookies' }, 400);
    }

    // Discover token endpoint.
    let discovery: Awaited<ReturnType<typeof discoverOidc>>;
    try {
      /* v8 ignore next 3 */
      discovery = await discoverOidc(oidcConfig.issuer, {
        ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
      });
    } catch (err) {
      process.stderr.write(
        `[review-agent] ERROR: OIDC discovery (callback) failed: ${String(err)}\n`,
      );
      clearOidcCookies(c);
      return c.json({ error: 'oidc_discovery_failed' }, 502);
    }

    // Exchange code for id_token.
    let idToken: string;
    try {
      idToken = await exchangeCode({
        tokenEndpoint: discovery.tokenEndpoint,
        code,
        clientId: oidcConfig.clientId,
        clientSecret: oidcConfig.clientSecret,
        redirectUri: oidcConfig.redirectUri,
        codeVerifier: cookieVerifier,
        /* v8 ignore next */
        ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
      });
    } catch (err) {
      // Log only the error type — never log code or client_secret.
      process.stderr.write(`[review-agent] ERROR: OIDC token exchange failed: ${String(err)}\n`);
      clearOidcCookies(c);
      return c.json({ error: 'token_exchange_failed' }, 502);
    }

    // Resolve the JWKS resolver — DI override for tests; otherwise fetch remotely.
    // In production createRemoteJWKSet fetches the JWKS from the IdP on first use.
    /* v8 ignore next 3 */
    // biome-ignore lint/suspicious/noExplicitAny: jose JWKS resolver
    const jwks: any =
      deps.jwks !== undefined ? deps.jwks : createRemoteJWKSet(new URL(discovery.jwksUri));

    // Verify id_token.
    const claims = await verifyOidcIdToken(idToken, {
      issuer: oidcConfig.issuer,
      clientId: oidcConfig.clientId,
      jwks,
      expectedNonce: cookieNonce,
    });

    if (claims === null) {
      process.stderr.write('[review-agent] WARN: OIDC id_token verification failed\n');
      clearOidcCookies(c);
      return c.json({ error: 'id_token_invalid' }, 401);
    }

    // JIT-provision the principal.
    const preferredUsername = claims.preferredUsername ?? claims.email?.split('@')[0] ?? claims.sub;

    let principal: Awaited<ReturnType<typeof upsertOidcPrincipal>>;
    try {
      principal = await upsertOidcPrincipal(deps.db, {
        provider: 'oidc',
        externalId: claims.sub,
        username: preferredUsername,
        id: (deps.generateId ?? randomUUID)(),
      });
    } catch (err) {
      process.stderr.write(`[review-agent] ERROR: OIDC principal upsert failed: ${String(err)}\n`);
      clearOidcCookies(c);
      return c.json({ error: 'principal_upsert_failed' }, 500);
    }

    // Issue session JWT.
    if (deps.sessionSecret === undefined) {
      clearOidcCookies(c);
      return c.json({ error: 'session_secret_not_configured' }, 503);
    }

    const token = await issueSessionToken(
      {
        principalId: principal.id,
        username: principal.username,
        // Use the principal's actual tokenVersion (returned by upsertOidcPrincipal:
        // the existing row's value, or the schema default for a freshly created
        // one). sessionAuth re-checks the JWT tokenVersion against the DB on every
        // request, so a hardcoded mismatch here would 401 the session immediately.
        tokenVersion: principal.tokenVersion,
      },
      deps.sessionSecret,
      sessionTtlSeconds,
    );

    // Clear OIDC flow cookies — they are single-use.
    clearOidcCookies(c);

    // Redirect to dashboard with token in fragment (#token=…).
    // Fragment is never sent to the server (Referer safe) and is not stored
    // in browser history as a query parameter. The SPA reads location.hash.
    return c.redirect(`${dashboardOrigin}/#token=${encodeURIComponent(token)}`, 302);
  });

  return app;
}
