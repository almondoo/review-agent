import type { KmsClient } from '@review-agent/core';
import type { AuditAppender, DbClient } from '@review-agent/db';
import { createAuditAppender } from '@review-agent/db';
import type { AppAuthClient } from '@review-agent/platform-github';
import { Hono } from 'hono';
import { createDashboardRouter } from './dashboard.js';
import { createGithubReposRouter } from './github-repos.js';
import { createIntegrationsRouter, type IntegrationsEnv } from './integrations.js';
import { createLlmKeysRouter } from './llm-keys.js';
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
  /**
   * KMS client used to wrap/unwrap BYOK data keys per request.
   * When provided, the /integrations/llm-keys routes are enabled.
   * When omitted the routes return 503.
   */
  readonly kmsClient?: KmsClient;
  /**
   * AWS KMS CMK key ID / ARN used to wrap BYOK data keys.
   * Sourced from REVIEW_AGENT_BYOK_KMS_KEY_ID env var in production.
   * Required when kmsClient is provided — routes return 503 if missing.
   */
  readonly kmsKeyId?: string;
  /**
   * Pre-constructed AuditAppender. When provided, a new one is not built
   * from deps.db (allows test injection).
   */
  readonly auditAppender?: AuditAppender;
  /**
   * App-level GitHub auth client. When provided, enables:
   *   - GET /api/github/installations/:installationId/repos
   * When absent those routes return 503.
   *
   * Spec §8.2.4.
   */
  readonly appAuthClient?: AppAuthClient;
  /**
   * When true the six installationId-input /api endpoints are disabled (501)
   * before any token mint or DB write. Sourced from env
   * `REVIEW_AGENT_MULTI_TENANT` (only the string 'true', case-insensitive,
   * trimmed, resolves to true; anything else including unset → false).
   *
   * Default: false (single-operator, unchanged behaviour).
   *
   * See docs/security/multi-tenant-authz.md and issue #132.
   */
  readonly multiTenant?: boolean;
};

/**
 * Parse the REVIEW_AGENT_MULTI_TENANT env var strictly.
 * Only the string 'true' (case-insensitive, trimmed) resolves to true.
 * Anything else, including unset / empty, resolves to false.
 */
function parseMultiTenantEnv(): boolean {
  const raw = typeof process !== 'undefined' ? process.env.REVIEW_AGENT_MULTI_TENANT : undefined;
  return raw !== undefined && raw.trim().toLowerCase() === 'true';
}

/**
 * Assemble the `/api` Hono sub-application.
 *
 * Mount via `app.route('/api', createApi(deps))` in `createApp`.
 * The sub-app handles its own CORS, so the parent app does not need
 * to add global CORS middleware.
 */
export function createApi(deps: ApiDeps): Hono {
  const api = new Hono();

  // Resolve multiTenant flag: caller wins; fall back to env.
  const multiTenant = deps.multiTenant ?? parseMultiTenantEnv();

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

  api.route('/integrations', createIntegrationsRouter({ env: deps.env, db: deps.db }));

  // Wire BYOK LLM key management routes when KMS is configured.
  const resolvedAuditAppender =
    deps.auditAppender ??
    (deps.now !== undefined
      ? createAuditAppender(deps.db, deps.now)
      : createAuditAppender(deps.db));

  const kmsKeyId =
    deps.kmsKeyId !== undefined && deps.kmsKeyId.length > 0 ? deps.kmsKeyId : undefined;

  if (deps.kmsClient !== undefined && kmsKeyId !== undefined) {
    // Capture in local consts so TypeScript narrows the types for the closure.
    const kms = deps.kmsClient;
    api.route(
      '/integrations/llm-keys',
      createLlmKeysRouter({
        db: deps.db,
        kms,
        auditAppender: resolvedAuditAppender,
        kmsKeyId,
        multiTenant,
      }),
    );
  } else {
    // Emit a startup warning when kmsClient is present but kmsKeyId is missing/empty
    // so operators know exactly which field to configure.
    if (deps.kmsClient !== undefined) {
      process.stderr.write(
        '[review-agent] WARN: kmsClient is set but kmsKeyId (REVIEW_AGENT_BYOK_KMS_KEY_ID) is missing or empty — /api/integrations/llm-keys routes disabled (503). Set REVIEW_AGENT_BYOK_KMS_KEY_ID to enable BYOK.\n',
      );
    }
    // Routes not configured — return 503 so the frontend can detect misconfiguration.
    api.all('/integrations/llm-keys/*', (c) => c.json({ error: 'llm_keys_not_configured' }, 503));
    api.all('/integrations/llm-keys', (c) => c.json({ error: 'llm_keys_not_configured' }, 503));
  }

  api.route(
    '/reviews',
    createReviewsRouter({
      db: deps.db,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.awsRegion ? { awsRegion: deps.awsRegion } : {}),
    }),
  );

  // GitHub App accessible repos + bulk registration (spec §8.2.4, §8.2.5).
  // The sub-router mounts:
  //   GET  /github/installations/:installationId/repos
  //   POST /repos/bulk
  // Both are covered by the bearer-token middleware applied above.
  api.route(
    '/',
    createGithubReposRouter({
      db: deps.db,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.generateId ? { generateId: deps.generateId } : {}),
      ...(deps.appAuthClient !== undefined
        ? { appAuth: { appAuthClient: deps.appAuthClient } }
        : {}),
      multiTenant,
    }),
  );

  return api;
}
