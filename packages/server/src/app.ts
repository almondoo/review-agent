import type { QueueClient } from '@review-agent/core';
import type { DbClient } from '@review-agent/db';
import { Hono } from 'hono';
import { createMiddleware } from 'hono/factory';
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
