import type { KmsClient, QueueClient } from '@review-agent/core';
import { type AuditAppender, createAuditAppender, type DbClient } from '@review-agent/db';
import type { AppAuthClient } from '@review-agent/platform-github';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type ApiDeps, createApi } from './api/index.js';
import { createGithubRouter } from './github-setup.js';
import { handleCodecommitWebhook } from './handlers/codecommit-webhook.js';
import {
  type ConversationHandlerInput,
  type ConversationReplyOutcome,
  handleWebhook,
} from './handlers/webhook.js';
import { idempotency } from './middleware/idempotency.js';
import { type VerifyEnv, verifyGithubSignature } from './middleware/verify-signature.js';
import {
  type VerifySnsEnv,
  type VerifySnsSignatureOpts,
  verifySnsSignature,
} from './middleware/verify-sns-signature.js';
import { namespaceDeliveryId } from './utils/namespace-delivery-id.js';

export type AppDeps = {
  readonly db: DbClient;
  readonly queue: QueueClient;
  readonly webhookSecret: string;
  readonly now?: () => Date;
  /**
   * Dependencies forwarded to the `/api` REST namespace. When unset the
   * namespace reads `process.env` directly for integration status checks.
   * Tests and Lambda entrypoints should pass an explicit snapshot to
   * keep the handler hermetic.
   */
  readonly api?: Omit<ApiDeps, 'db' | 'now' | 'env'>;
  /**
   * KMS client for BYOK key wrapping. When provided, the
   * /api/integrations/llm-keys routes are enabled.
   * In production, pass createAwsKmsClient() from @review-agent/kms-aws.
   */
  readonly kmsClient?: KmsClient;
  /**
   * Pre-constructed AuditAppender (for tests).
   */
  readonly auditAppender?: AuditAppender;
  /**
   * SNS signature verification options. Tests inject `verifySignature`
   * + `fetchCert` to keep the receiver offline. Production should
   * leave these unset so the real `node:crypto` path runs.
   */
  readonly sns?: VerifySnsSignatureOpts;
  /**
   * SEC-1: allowlist of SNS Topic ARNs accepted by the CodeCommit
   * endpoint. Empty / unset = reject every delivery (fail-closed). In
   * production this is sourced from the `REVIEW_AGENT_SNS_TOPIC_ARNS`
   * environment variable; tests inject the array directly.
   */
  readonly allowedSnsTopicArns?: ReadonlyArray<string>;
  /**
   * v1.2 #95: `/feedback` GitHub permission check. Operators inject
   * the installation-scoped Octokit-bound checker (typically built
   * via `checkGithubFeedbackAuthz` from this package). When unset
   * every `/feedback` from the GitHub path is denied (fail-closed).
   */
  readonly checkGithubFeedbackAuthz?: (input: {
    readonly owner: string;
    readonly repo: string;
    readonly username: string;
  }) => Promise<{ readonly allowed: boolean; readonly reason?: string }>;
  /**
   * v1.2 #95: `/feedback` CodeCommit allowlist override. Tests inject
   * the CSV directly; production reads `REVIEW_AGENT_FEEDBACK_ALLOWLIST`
   * env (fail-closed when unset).
   */
  readonly codecommitFeedbackAllowlistEnv?: string;
  /**
   * URL-safe GitHub App slug (e.g. "my-review-agent"). Used by
   * GET /github/install-redirect to build the GitHub App install URL.
   * Falls back to GITHUB_APP_SLUG env when absent.
   */
  readonly githubAppSlug?: string;
  /**
   * Origin of the web dashboard (e.g. "https://dashboard.example.com").
   * Used by GET /github/setup for post-install redirects.
   * Falls back to REVIEW_AGENT_DASHBOARD_ORIGIN env when absent.
   */
  readonly dashboardOrigin?: string;
  /**
   * App-level auth client (from platform-github). Required for
   * GET /github/setup to call apps.getInstallation via an App JWT.
   */
  readonly github?: {
    readonly appAuthClient: AppAuthClient;
  };
  /**
   * #149 inline conversation: optional handler for `@review-agent` mentions
   * in PR review-comment threads. When provided, `pull_request_review_comment`
   * events that are replies containing `@review-agent` are routed here instead
   * of (or before) the legacy command parser.
   *
   * Operators compose this from `handleConversationReply` (runner package) and
   * the relevant DB / provider deps. When absent, thread-reply mentions fall
   * through to the legacy command parser (fail-open).
   */
  readonly handleConversation?: (
    input: ConversationHandlerInput,
  ) => Promise<ConversationReplyOutcome>;
  /**
   * #149 self-reply guard: returns the bot's own GitHub login
   * (e.g. `review-agent[bot]`). When provided, the webhook handler checks the
   * sender against this value and silently drops the event if they match
   * (prevents reply loops).
   *
   * Resolution order:
   *   1. `GITHUB_BOT_LOGIN` environment variable (override; useful in tests
   *      and non-App-authenticated deployments).
   *   2. Derived from `deps.github.appAuthClient` via a cached one-shot call
   *      to `GET /app` using the App JWT (slug + "[bot]" suffix).
   *   3. When neither is available, the guard is disabled (fail-open).
   *
   * Operators who wire `deps.github.appAuthClient` get the guard for free;
   * tests inject an explicit value via `GITHUB_BOT_LOGIN` env.
   */
  readonly getBotLogin?: () => Promise<string>;
};

/**
 * #149: Resolve the `getBotLogin` closure for the self-reply guard.
 *
 * Resolution order (first truthy wins):
 *   1. `deps.getBotLogin` — caller-supplied override (tests / custom deployments).
 *   2. `GITHUB_BOT_LOGIN` environment variable — simple string override.
 *   3. Derived from `deps.github.appAuthClient` — calls `GET /app` via the App
 *      JWT and appends `[bot]` to the slug (e.g. `review-agent[bot]`). The slug
 *      is cached across requests because it is stable for the lifetime of a
 *      GitHub App installation.
 *   4. `undefined` — guard is disabled (fail-open per spec).
 *
 * The returned closure is memoized so the App API is called at most once
 * per `createApp` lifetime (not per request).
 */
function resolveGetBotLogin(deps: AppDeps): (() => Promise<string>) | undefined {
  // 1. Explicit override from caller.
  if (deps.getBotLogin) return deps.getBotLogin;

  // 2. Environment variable override.
  const envLogin = typeof process !== 'undefined' ? process.env.GITHUB_BOT_LOGIN : undefined;
  if (envLogin) return async () => envLogin;

  // 3. Derive from App JWT via GET /app (slug + "[bot]").
  if (deps.github?.appAuthClient) {
    const authClient = deps.github.appAuthClient;
    let cached: string | undefined;
    return async () => {
      if (cached) return cached;
      // createAppJwt() returns a short-lived App JWT; we use it to call
      // the GitHub API's GET /app endpoint which returns the App's slug.
      // This is the canonical way to derive the bot login without
      // hard-coding it in operator config.
      const jwt = await authClient.createAppJwt();
      const { Octokit } = await import('@octokit/rest');
      const octokit = new Octokit({ auth: jwt });
      const response = await octokit.rest.apps.getAuthenticated();
      // `response.data.slug` is the URL-safe App slug (e.g. "review-agent").
      // The Apps API guarantees it is set for authenticated requests;
      // `null` / `undefined` only occurs on older Octokit type stubs.
      const appData = response.data;
      const slug = (appData as { slug?: string | null } | null)?.slug ?? 'review-agent';
      cached = `${slug}[bot]`;
      return cached;
    };
  }

  // 4. Guard disabled (fail-open).
  return undefined;
}

/**
 * Bridges the SNS `MessageId` (the dedup key for the CodeCommit
 * pipeline) into the `x-github-delivery` header that the shared
 * `idempotency` middleware reads. This avoids forking the idempotency
 * middleware just for a different header name.
 *
 * SEC-3: prefix the value with `sns:` so an SNS MessageId UUID cannot
 * probabilistically collide with a GitHub `X-GitHub-Delivery` UUID in
 * the shared `webhook_deliveries.delivery_id` column. GitHub deliveries
 * continue to write the bare value for back-compat with existing rows
 * — the namespacing is one-sided by design, documented in
 * `docs/deployment/aws.md` and `utils/namespace-delivery-id.ts`.
 */
const snsMessageIdAsDeliveryId = createMiddleware<VerifySnsEnv>(async (c, next) => {
  const msg = c.get('snsMessage');
  c.req.raw.headers.set('x-github-delivery', namespaceDeliveryId('codecommit', msg.MessageId));
  await next();
});

/**
 * SEC-8 (sub) / FUNC M-2: SNS may re-deliver `SubscriptionConfirmation`
 * envelopes on retry. Without this short-circuit the second delivery
 * is silently deduped by the idempotency middleware and the operator
 * never sees the confirmation succeed. Subscription-control envelopes
 * bypass `idempotency` entirely so every retry confirms (idempotent on
 * the AWS side anyway — confirming an already-confirmed subscription
 * is a no-op).
 */
function isSubscriptionControl(snsMessageType: string): boolean {
  return (
    snsMessageType === 'SubscriptionConfirmation' || snsMessageType === 'UnsubscribeConfirmation'
  );
}

function resolveAllowedSnsTopicArns(opts: AppDeps): ReadonlyArray<string> {
  if (opts.allowedSnsTopicArns !== undefined) return opts.allowedSnsTopicArns;
  const env = typeof process !== 'undefined' ? process.env.REVIEW_AGENT_SNS_TOPIC_ARNS : undefined;
  if (!env) return [];
  return env
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function createApp(deps: AppDeps): Hono<VerifyEnv & VerifySnsEnv> {
  const app = new Hono<VerifyEnv & VerifySnsEnv>();

  const allowedSnsTopicArns = resolveAllowedSnsTopicArns(deps);
  if (allowedSnsTopicArns.length === 0) {
    // One-shot warning at boot. The handler still rejects every
    // delivery; this log line is the operator's hint about *why*.
    process.stderr.write(
      'review-agent: REVIEW_AGENT_SNS_TOPIC_ARNS is unset — /webhook/codecommit will reject every delivery (SEC-1 fail-closed)\n',
    );
  }

  app.get('/healthz', (c) => c.json({ ok: true }));

  // REST API namespace — dashboard, repos CRUD, integrations, reviews
  // Env is always read from process.env at app-creation time so the
  // snapshot stays consistent for the lifetime of the server process.
  // exactOptionalPropertyTypes: omit keys whose values are undefined so
  // the object literal is assignable to the optional-property interface.
  const apiEnv: ApiDeps['env'] = Object.fromEntries(
    Object.entries({
      GITHUB_APP_ID: process.env.GITHUB_APP_ID,
      AWS_REGION: process.env.AWS_REGION,
      REVIEW_AGENT_SNS_TOPIC_ARNS: process.env.REVIEW_AGENT_SNS_TOPIC_ARNS,
      REVIEW_AGENT_FEEDBACK_ALLOWLIST: process.env.REVIEW_AGENT_FEEDBACK_ALLOWLIST,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      REVIEW_AGENT_PROVIDER: process.env.REVIEW_AGENT_PROVIDER,
      REVIEW_AGENT_MODEL: process.env.REVIEW_AGENT_MODEL,
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      REVIEW_AGENT_DASHBOARD_CORS: process.env.REVIEW_AGENT_DASHBOARD_CORS,
      GITHUB_APP_SLUG: process.env.GITHUB_APP_SLUG,
      // REVIEW_AGENT_DASHBOARD_TOKEN is intentionally excluded from apiEnv
      // (the integrations response must never leak the token value).
    }).filter(([, v]) => v !== undefined),
  ) as ApiDeps['env'];
  // BYOK KMS key ID: caller may supply via deps.api.kmsKeyId, otherwise fall back to env.
  const kmsKeyId = deps.api?.kmsKeyId ?? process.env.REVIEW_AGENT_BYOK_KMS_KEY_ID;

  // -------------------------------------------------------------------------
  // AUTH_MODE / SESSION_SECRET / SESSION_TTL_SECONDS resolution (issue #161).
  //
  // Caller (deps.api.*) wins; env fallback applies when absent.
  //
  // Fail-closed: when AUTH_MODE is 'session' or 'both', SESSION_SECRET is
  // required and must be at least 32 characters. Startup throws with a clear
  // message if this is violated so the operator cannot accidentally ship an
  // insecure deployment.
  // -------------------------------------------------------------------------
  const resolvedAuthMode = (() => {
    const raw = deps.api?.authMode ?? process.env.REVIEW_AGENT_AUTH_MODE;
    if (raw === undefined) return 'legacy' as const;
    if (raw === 'legacy' || raw === 'session' || raw === 'both') return raw;
    throw new Error(
      `[review-agent] Invalid REVIEW_AGENT_AUTH_MODE value: "${raw}". ` +
        'Allowed values: legacy | session | both',
    );
  })();

  const resolvedSessionSecret = deps.api?.sessionSecret ?? process.env.REVIEW_AGENT_SESSION_SECRET;

  if (resolvedAuthMode === 'session' || resolvedAuthMode === 'both') {
    if (resolvedSessionSecret === undefined || resolvedSessionSecret.length < 32) {
      throw new Error(
        '[review-agent] REVIEW_AGENT_SESSION_SECRET must be set and at least 32 characters ' +
          `when REVIEW_AGENT_AUTH_MODE is "${resolvedAuthMode}". ` +
          'Set a strong random secret (e.g. openssl rand -hex 32).',
      );
    }
  }

  const resolvedSessionTtlSeconds = (() => {
    const raw =
      deps.api?.sessionTtlSeconds !== undefined
        ? String(deps.api.sessionTtlSeconds)
        : process.env.REVIEW_AGENT_SESSION_TTL_SECONDS;
    if (raw === undefined) return 43200; // 12h default
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(
        `[review-agent] REVIEW_AGENT_SESSION_TTL_SECONDS must be a positive integer (got "${raw}").`,
      );
    }
    return n;
  })();

  // Resolve the audit appender once at app-creation time so the same instance
  // is shared across /api routes and /github/setup. The appender now sets the
  // tenant GUC internally so no outer withTenant wrapper is required.
  const resolvedAppAuditAppender: AuditAppender =
    deps.auditAppender ??
    (deps.now !== undefined
      ? createAuditAppender(deps.db, deps.now)
      : createAuditAppender(deps.db));

  // GitHub App onboarding — mounted BEFORE /api and OUTSIDE the bearer-token guard.
  // spec §8.2.2: /github/* uses CSRF state cookie as the sole auth mechanism.
  const githubAppSlug = deps.githubAppSlug ?? process.env.GITHUB_APP_SLUG;
  const dashboardOrigin = deps.dashboardOrigin ?? process.env.REVIEW_AGENT_DASHBOARD_ORIGIN;
  app.route(
    '/github',
    createGithubRouter({
      db: deps.db,
      ...(githubAppSlug !== undefined ? { githubAppSlug } : {}),
      ...(dashboardOrigin !== undefined ? { dashboardOrigin } : {}),
      ...(deps.github !== undefined ? { github: deps.github } : {}),
      auditAppender: resolvedAppAuditAppender,
    }),
  );

  app.route(
    '/api',
    createApi({
      db: deps.db,
      env: apiEnv,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.api?.generateId ? { generateId: deps.api.generateId } : {}),
      ...(deps.api?.awsRegion ? { awsRegion: deps.api.awsRegion } : {}),
      // Auth: caller may override via deps.api; otherwise fall back to env.
      // exactOptionalPropertyTypes: use conditional spread so undefined is
      // never assigned to a required-when-present optional property.
      ...(() => {
        const t = deps.api?.dashboardToken ?? process.env.REVIEW_AGENT_DASHBOARD_TOKEN;
        return t !== undefined ? { dashboardToken: t } : {};
      })(),
      requireDashboardAuth: deps.api?.requireDashboardAuth ?? process.env.NODE_ENV === 'production',
      // REVIEW_AGENT_MULTI_TENANT: caller wins; env fallback handled inside createApi.
      ...(deps.api?.multiTenant !== undefined ? { multiTenant: deps.api.multiTenant } : {}),
      // BYOK / KMS: thread kmsClient from AppDeps into ApiDeps so the
      // /integrations/llm-keys routes can wrap/unwrap data keys per request.
      ...(deps.kmsClient !== undefined ? { kmsClient: deps.kmsClient } : {}),
      auditAppender: resolvedAppAuditAppender,
      ...(kmsKeyId !== undefined && kmsKeyId.length > 0 ? { kmsKeyId } : {}),
      // Auth mode and session config (issue #161).
      authMode: resolvedAuthMode,
      ...(resolvedSessionSecret !== undefined ? { sessionSecret: resolvedSessionSecret } : {}),
      sessionTtlSeconds: resolvedSessionTtlSeconds,
    }),
  );

  app.post(
    '/webhook',
    verifyGithubSignature(deps.webhookSecret),
    idempotency({ db: deps.db }),
    async (c) => {
      const event = c.req.header('x-github-event') ?? '';
      const body = c.get('parsedBody');
      // Resolve getBotLogin: deps override wins; fall back to env; then App JWT.
      const resolvedGetBotLogin = resolveGetBotLogin(deps);
      const result = await handleWebhook(c, event as Parameters<typeof handleWebhook>[1], body, {
        queue: deps.queue,
        db: deps.db,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.checkGithubFeedbackAuthz ? { checkAuthz: deps.checkGithubFeedbackAuthz } : {}),
        ...(deps.handleConversation ? { handleConversation: deps.handleConversation } : {}),
        ...(resolvedGetBotLogin ? { getBotLogin: resolvedGetBotLogin } : {}),
      });
      return c.json(result, 200);
    },
  );

  // SEC-8 short-circuit middleware: skip idempotency for
  // SubscriptionConfirmation / UnsubscribeConfirmation deliveries so
  // SNS retries are not silently deduped.
  const skipIdempotencyForControl = createMiddleware<VerifySnsEnv>(async (c, next) => {
    const msg = c.get('snsMessage');
    if (isSubscriptionControl(msg.Type)) {
      // Bypass idempotency entirely; jump straight to the handler.
      const result = await handleCodecommitWebhook(c, msg, {
        queue: deps.queue,
        allowedTopicArns: allowedSnsTopicArns,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.codecommitFeedbackAllowlistEnv !== undefined
          ? { feedbackAllowlistEnv: deps.codecommitFeedbackAllowlistEnv }
          : {}),
      });
      if (result.kind === 'forbidden') {
        return c.json({ error: 'forbidden', reason: result.reason }, 403);
      }
      return c.json(result, 200);
    }
    await next();
  });

  app.post(
    '/webhook/codecommit',
    verifySnsSignature(deps.sns ?? {}),
    skipIdempotencyForControl,
    snsMessageIdAsDeliveryId,
    idempotency({ db: deps.db }),
    async (c) => {
      const envelope = c.get('snsMessage');
      const result = await handleCodecommitWebhook(c, envelope, {
        queue: deps.queue,
        allowedTopicArns: allowedSnsTopicArns,
        ...(deps.now ? { now: deps.now } : {}),
      });
      if (result.kind === 'forbidden') {
        return c.json({ error: 'forbidden', reason: result.reason }, 403);
      }
      return c.json(result, 200);
    },
  );

  return app;
}
