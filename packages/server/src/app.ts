import type { KmsClient, QueueClient } from '@review-agent/core';
import type { AuditAppender, DbClient } from '@review-agent/db';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type ApiDeps, createApi } from './api/index.js';
import { handleCodecommitWebhook } from './handlers/codecommit-webhook.js';
import { handleWebhook } from './handlers/webhook.js';
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
};

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
      // REVIEW_AGENT_DASHBOARD_TOKEN is intentionally excluded from apiEnv
      // (the integrations response must never leak the token value).
    }).filter(([, v]) => v !== undefined),
  ) as ApiDeps['env'];
  // BYOK KMS key ID: caller may supply via deps.api.kmsKeyId, otherwise fall back to env.
  const kmsKeyId = deps.api?.kmsKeyId ?? process.env.REVIEW_AGENT_BYOK_KMS_KEY_ID;

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
      // BYOK / KMS: thread kmsClient from AppDeps into ApiDeps so the
      // /integrations/llm-keys routes can wrap/unwrap data keys per request.
      ...(deps.kmsClient !== undefined ? { kmsClient: deps.kmsClient } : {}),
      ...(deps.auditAppender !== undefined ? { auditAppender: deps.auditAppender } : {}),
      ...(kmsKeyId !== undefined && kmsKeyId.length > 0 ? { kmsKeyId } : {}),
    }),
  );

  app.post(
    '/webhook',
    verifyGithubSignature(deps.webhookSecret),
    idempotency({ db: deps.db }),
    async (c) => {
      const event = c.req.header('x-github-event') ?? '';
      const body = c.get('parsedBody');
      const result = await handleWebhook(c, event as Parameters<typeof handleWebhook>[1], body, {
        queue: deps.queue,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.checkGithubFeedbackAuthz ? { checkAuthz: deps.checkGithubFeedbackAuthz } : {}),
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
