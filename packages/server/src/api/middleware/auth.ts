import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler, Next } from 'hono';

export type AuthMiddlewareOptions = {
  /** Configured token sourced from env (passed via deps, never read directly). */
  token: string | undefined;
  /**
   * Strict mode: when true a missing/empty token causes every request to receive
   * 503 instead of passing through. Use in production to catch misconfiguration.
   */
  requireAuth: boolean;
};

/**
 * Bearer-token authentication middleware for the `/api` namespace.
 *
 * Behaviour matrix:
 *  token unset + requireAuth=false → pass-through (warn is handled by createApi)
 *  token unset + requireAuth=true  → 503 (misconfiguration guard)
 *  token set   + valid Bearer      → next()
 *  token set   + missing/bad header → 401
 *
 * OPTIONS requests always pass through to support CORS preflight.
 * Token comparison uses timingSafeEqual even when lengths differ (dummy buffer)
 * so no timing information leaks about configured token length.
 */
export function bearerTokenAuth(opts: AuthMiddlewareOptions): MiddlewareHandler {
  const configured = opts.token !== undefined && opts.token.length > 0;

  return async (c: Context, next: Next) => {
    // Always pass OPTIONS through for CORS preflight.
    if (c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    if (!configured) {
      if (opts.requireAuth) {
        return c.json({ error: 'dashboard authentication not configured' }, 503);
      }
      // requireAuth=false: pass through (caller issued one-time warning)
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const provided = authHeader.slice(7); // strip "Bearer "
    // biome-ignore lint/style/noNonNullAssertion: opts.token is confirmed non-empty (configured===true)
    const expected = opts.token!;

    const providedBuf = Buffer.from(provided);
    const expectedBuf = Buffer.from(expected);

    // Always run timingSafeEqual — use a dummy buffer of the same length as
    // provided when lengths differ so no early return leaks information.
    let match: boolean;
    if (providedBuf.length !== expectedBuf.length) {
      // Run comparison against a same-length dummy to avoid timing differences.
      const dummy = Buffer.alloc(providedBuf.length);
      timingSafeEqual(providedBuf, dummy);
      match = false;
    } else {
      match = timingSafeEqual(providedBuf, expectedBuf);
    }

    if (!match) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    await next();
  };
}
