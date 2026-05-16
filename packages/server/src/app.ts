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
};

/**
 * Bridges the SNS `MessageId` (the dedup key for the CodeCommit
 * pipeline) into the `x-github-delivery` header that the shared
 * `idempotency` middleware reads. This avoids forking the idempotency
 * middleware just for a different header name.
 */
const snsMessageIdAsDeliveryId = createMiddleware<VerifySnsEnv>(async (c, next) => {
  const msg = c.get('snsMessage');
  c.req.raw.headers.set('x-github-delivery', msg.MessageId);
  await next();
});

export function createApp(deps: AppDeps): Hono<VerifyEnv & VerifySnsEnv> {
  const app = new Hono<VerifyEnv & VerifySnsEnv>();

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

  app.post(
    '/webhook/codecommit',
    verifySnsSignature(deps.sns ?? {}),
    snsMessageIdAsDeliveryId,
    idempotency({ db: deps.db }),
    async (c) => {
      const envelope = c.get('snsMessage');
      const result = await handleCodecommitWebhook(c, envelope, {
        queue: deps.queue,
        ...(deps.now ? { now: deps.now } : {}),
      });
      return c.json(result, 200);
    },
  );

  return app;
}
