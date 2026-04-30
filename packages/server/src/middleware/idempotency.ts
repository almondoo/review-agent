import { webhookDeliveries } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { createMiddleware } from 'hono/factory';

export type IdempotencyDeps = {
  readonly db: DbClient;
};

export function idempotency(deps: IdempotencyDeps) {
  return createMiddleware(async (c, next) => {
    const deliveryId = c.req.header('x-github-delivery');
    if (!deliveryId) return c.json({ error: 'missing delivery id' }, 400);

    const inserted = await deps.db
      .insert(webhookDeliveries)
      .values({ deliveryId, status: 'received' })
      .onConflictDoNothing({ target: webhookDeliveries.deliveryId })
      .returning({ deliveryId: webhookDeliveries.deliveryId });

    if (inserted.length === 0) {
      return c.json({ deduped: true }, 200);
    }
    await next();
  });
}
