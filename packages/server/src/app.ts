import type { QueueClient } from '@review-agent/core';
import type { DbClient } from '@review-agent/db';
import { Hono } from 'hono';
import { handleWebhook } from './handlers/webhook.js';
import { idempotency } from './middleware/idempotency.js';
import { type VerifyEnv, verifyGithubSignature } from './middleware/verify-signature.js';

export type AppDeps = {
  readonly db: DbClient;
  readonly queue: QueueClient;
  readonly webhookSecret: string;
  readonly now?: () => Date;
};

export function createApp(deps: AppDeps): Hono<VerifyEnv> {
  const app = new Hono<VerifyEnv>();

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

  return app;
}
