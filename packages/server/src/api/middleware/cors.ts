import type { Context, Next } from 'hono';
import { cors } from 'hono/cors';

/**
 * Dev-only CORS middleware for the `/api` namespace.
 *
 * Enabled when `REVIEW_AGENT_DASHBOARD_CORS=1` is set in the environment.
 * In production this env flag must be absent or set to any value other
 * than `"1"`.
 *
 * Allows `http://localhost:5173` (Vite dev server) with standard HTTP
 * methods and the `Content-Type` / `Authorization` headers the dashboard
 * client sends.
 */
export function devCors(env: { readonly REVIEW_AGENT_DASHBOARD_CORS?: string }) {
  const enabled = env.REVIEW_AGENT_DASHBOARD_CORS === '1';
  if (!enabled) {
    // Return a true no-op middleware when CORS is disabled.
    // `cors({ origin: [] })` would intercept OPTIONS preflight requests
    // and return 204 without calling next(), swallowing them entirely.
    // A plain passthrough avoids that side-effect.
    return async (_c: Context, next: Next) => {
      await next();
    };
  }
  return cors({
    origin: 'http://localhost:5173',
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: [],
    maxAge: 600,
    credentials: false,
  });
}
