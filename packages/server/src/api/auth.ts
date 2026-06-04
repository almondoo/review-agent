/**
 * /api/auth/* — session authentication endpoints (logout and me only).
 *
 * POST /api/auth/login is handled directly in createApi (index.ts) so
 * it is registered BEFORE the sessionAuth middleware and thus accessible
 * without authentication.
 *
 * Routes in this router (all protected by sessionAuth):
 *   POST /auth/logout — stateless; client is responsible for discarding token
 *   GET  /auth/me     — returns info about the authenticated caller
 *
 * Rate limiting is out of scope for this implementation and must be handled
 * at the reverse proxy / API gateway layer. TODO: add rate limiting in a
 * follow-up (e.g. via a Redis-backed token bucket).
 */
import type { DbClient } from '@review-agent/db';
import { Hono } from 'hono';
import { getMembershipsByPrincipal } from '../auth/principal-store.js';
import type { AuthEnv } from '../auth/types.js';

export type AuthRouterDeps = {
  readonly db: DbClient;
};

export function createAuthRouter(deps: AuthRouterDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // -------------------------------------------------------------------------
  // POST /auth/logout
  //
  // JWTs are stateless: the server has no token store to clear. The client is
  // responsible for discarding the token. This endpoint exists for API
  // completeness and future expansion (e.g., token blocklist). Returns 204.
  //
  // To force-invalidate all sessions for a user, increment their tokenVersion
  // in the DB (via the CLI admin command — future work).
  // -------------------------------------------------------------------------
  app.post('/logout', (_c) => {
    return new Response(null, { status: 204 });
  });

  // -------------------------------------------------------------------------
  // GET /auth/me
  //
  // Returns info about the authenticated caller:
  //   JWT auth:      { authenticated: true, legacy: false, principal, memberships }
  //   Shared token:  { authenticated: true, legacy: true }
  // -------------------------------------------------------------------------
  app.get('/me', async (c) => {
    const principal = c.get('principal');

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      return c.json(
        {
          authenticated: true as const,
          legacy: false as const,
          principal: { id: principal.id, username: principal.username },
          memberships,
        },
        200,
      );
    }

    // Shared token / legacy path: no principal identity available.
    return c.json({ authenticated: true as const, legacy: true as const }, 200);
  });

  return app;
}
