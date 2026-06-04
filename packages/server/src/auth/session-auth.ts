/**
 * Session authentication middleware for the /api namespace.
 *
 * Supports three AUTH_MODE values:
 *   legacy  — only REVIEW_AGENT_DASHBOARD_TOKEN (shared bearer token) is accepted.
 *             Exact replacement for bearerTokenAuth. When sharedToken is unset and
 *             requireAuth is false, requests pass through (same as before).
 *   session — only JWT (issued by POST /api/auth/login) is accepted.
 *   both    — JWT is tried first; on JWT failure the shared token is tried.
 *
 * JWT vs shared-token detection: a token with exactly two dots (x.y.z shape)
 * is treated as a JWT; anything else is treated as a shared token.
 *
 * When a JWT is verified, the principal identity is stored via c.set('principal',…)
 * so downstream handlers can use it.
 *
 * OPTIONS requests always pass through (CORS preflight).
 */
import { timingSafeEqual } from 'node:crypto';
import type { DbClient } from '@review-agent/db';
import { createMiddleware } from 'hono/factory';
import { verifySessionToken } from './jwt.js';
import { findPrincipalById } from './principal-store.js';
import type { AuthEnv } from './types.js';

/** Allowed auth mode values. */
export const AUTH_MODES = ['legacy', 'session', 'both'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export type SessionAuthOptions = {
  readonly authMode: AuthMode;
  /** Shared bearer token (REVIEW_AGENT_DASHBOARD_TOKEN). Used in legacy / both modes. */
  readonly sharedToken: string | undefined;
  /**
   * When true and sharedToken is absent/empty, return 503 (misconfiguration guard).
   * Only applies to legacy / both modes. Defaults to false.
   */
  readonly requireAuth?: boolean;
  /** HS256 signing secret. Required in session / both modes. */
  readonly sessionSecret: Uint8Array | string | undefined;
  /** DB client for tokenVersion verification. Required in session / both modes. */
  readonly db: DbClient | undefined;
};

/**
 * Returns true when the token string looks like a JWT (exactly two dots).
 */
function looksLikeJwt(token: string): boolean {
  return (token.match(/\./g) ?? []).length === 2;
}

/**
 * Constant-time comparison of two strings using timingSafeEqual.
 * Returns false when lengths differ (still runs a dummy compare).
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    const dummy = Buffer.alloc(aBuf.length);
    timingSafeEqual(aBuf, dummy);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Try to authenticate via JWT. Returns the principal on success or null on failure.
 * Returns null (instead of 401) so `both` mode can fall back to shared token.
 */
async function tryJwtAuth(
  token: string,
  opts: SessionAuthOptions,
): Promise<import('./types.js').ContextPrincipal | null> {
  if (opts.sessionSecret === undefined || opts.db === undefined) {
    return null;
  }
  const claims = await verifySessionToken(token, opts.sessionSecret);
  if (claims === null) {
    return null;
  }
  // Verify the principal still exists and the tokenVersion matches (revocation check).
  const principal = await findPrincipalById(opts.db, claims.principalId);
  if (principal === null || principal.tokenVersion !== claims.tokenVersion) {
    return null;
  }
  return { id: principal.id, username: principal.username };
}

/**
 * Returns true when the shared token is configured (non-empty).
 */
function sharedTokenConfigured(opts: SessionAuthOptions): boolean {
  return opts.sharedToken !== undefined && opts.sharedToken.length > 0;
}

/**
 * Try to authenticate via the shared bearer token.
 * Returns true when the token matches, false otherwise.
 */
function trySharedTokenAuth(token: string, opts: SessionAuthOptions): boolean {
  if (!sharedTokenConfigured(opts)) {
    return false;
  }
  // biome-ignore lint/style/noNonNullAssertion: guarded by sharedTokenConfigured above
  return safeEqual(token, opts.sharedToken!);
}

/**
 * Session authentication middleware factory.
 *
 * Attach to all /api/* routes EXCEPT POST /api/auth/login
 * (login must be outside this middleware).
 */
export function sessionAuth(opts: SessionAuthOptions) {
  return createMiddleware<AuthEnv>(async (c, next) => {
    // Always pass OPTIONS through (CORS preflight).
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    const mode = opts.authMode;

    // -----------------------------------------------------------------------
    // Legacy mode — preserves exact bearerTokenAuth behavior.
    // -----------------------------------------------------------------------
    if (mode === 'legacy') {
      const configured = sharedTokenConfigured(opts);

      if (!configured) {
        if (opts.requireAuth ?? false) {
          return c.json({ error: 'dashboard authentication not configured' }, 503);
        }
        // Pass through (dev mode — caller issued one-time startup warning).
        await next();
        return;
      }

      const authHeader = c.req.header('Authorization');
      if (authHeader === undefined || !authHeader.startsWith('Bearer ')) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const token = authHeader.slice(7);

      if (!trySharedTokenAuth(token, opts)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      // No principal set in legacy mode.
      await next();
      return;
    }

    // -----------------------------------------------------------------------
    // Session or both mode — JWT required (with optional shared-token fallback
    // for 'both').
    // -----------------------------------------------------------------------
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    if (token === undefined || token.length === 0) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    if (mode === 'session') {
      // Session mode: only JWT accepted.
      if (!looksLikeJwt(token)) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      const principal = await tryJwtAuth(token, opts);
      if (principal === null) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      c.set('principal', principal);
      await next();
      return;
    }

    // mode === 'both'
    if (looksLikeJwt(token)) {
      // Try JWT first.
      const principal = await tryJwtAuth(token, opts);
      if (principal !== null) {
        c.set('principal', principal);
        await next();
        return;
      }
      // JWT failed — fall through to shared token.
    }

    // Try shared token.
    if (trySharedTokenAuth(token, opts)) {
      // No principal set for legacy/shared-token path.
      await next();
      return;
    }

    return c.json({ error: 'unauthorized' }, 401);
  });
}
