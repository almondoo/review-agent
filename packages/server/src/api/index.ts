import type { DbClient } from '@review-agent/db';
import { Hono } from 'hono';
import { createDashboardRouter } from './dashboard.js';
import { createIntegrationsRouter, type IntegrationsEnv } from './integrations.js';
import { bearerTokenAuth } from './middleware/auth.js';
import { devCors } from './middleware/cors.js';
import { createReposRouter } from './repos.js';
import { createReviewsRouter } from './reviews.js';

export type ApiDeps = {
  readonly db: DbClient;
  readonly env: IntegrationsEnv & { readonly REVIEW_AGENT_DASHBOARD_CORS?: string };
  readonly now?: () => Date;
  readonly generateId?: () => string;
  /** AWS region for CodeCommit external URL generation. Defaults to `process.env.AWS_REGION`. */
  readonly awsRegion?: string;
  /**
   * Bearer token for `/api` authentication. When unset and `requireDashboardAuth`
   * is false the namespace is open (a warning is logged). When `requireDashboardAuth`
   * is true every request receives 503 until the token is configured.
   */
  readonly dashboardToken?: string;
  /**
   * When true a missing token causes 503 responses (production misconfiguration
   * guard). Defaults to false so development environments without a token still
   * work while receiving a startup warning.
   */
  readonly requireDashboardAuth?: boolean;
};

/**
 * Assemble the `/api` Hono sub-application.
 *
 * Mount via `app.route('/api', createApi(deps))` in `createApp`.
 * The sub-app handles its own CORS, so the parent app does not need
 * to add global CORS middleware.
 */
export function createApi(deps: ApiDeps): Hono {
  const api = new Hono();

  // Dev-only CORS — no-op in production
  api.use('/*', devCors(deps.env));

  // One-shot startup warning when auth is disabled.
  const tokenConfigured = deps.dashboardToken !== undefined && deps.dashboardToken.length > 0;
  if (!tokenConfigured && !(deps.requireDashboardAuth ?? false)) {
    process.stderr.write(
      '[review-agent] WARN: /api authentication disabled (REVIEW_AGENT_DASHBOARD_TOKEN not set). Block /api/* at your reverse proxy if exposed publicly.\n',
    );
  }

  api.use(
    '*',
    bearerTokenAuth({
      token: deps.dashboardToken,
      requireAuth: deps.requireDashboardAuth ?? false,
    }),
  );

  api.route(
    '/dashboard',
    createDashboardRouter({ db: deps.db, ...(deps.now ? { now: deps.now } : {}) }),
  );

  api.route(
    '/repos',
    createReposRouter({
      db: deps.db,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.generateId ? { generateId: deps.generateId } : {}),
    }),
  );

  api.route('/integrations', createIntegrationsRouter({ env: deps.env }));

  api.route(
    '/reviews',
    createReviewsRouter({
      db: deps.db,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.awsRegion ? { awsRegion: deps.awsRegion } : {}),
    }),
  );

  return api;
}
