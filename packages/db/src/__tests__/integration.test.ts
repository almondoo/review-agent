import {
  costLedger,
  installationTokens,
  reviewState,
  webhookDeliveries,
} from '@review-agent/core/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDbClient } from '../connection.js';

const url = process.env.TEST_DATABASE_URL ?? '';

describe.skipIf(!url)('postgres integration', () => {
  it('round-trips webhook_deliveries, installation_tokens, review_state, cost_ledger', async () => {
    const { db, close } = createDbClient({ url });
    try {
      const deliveryId = `test-${Date.now()}`;

      await db
        .insert(webhookDeliveries)
        .values({ deliveryId, status: 'received' })
        .onConflictDoNothing();
      const found = await db.execute(
        sql`SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ${deliveryId}`,
      );
      expect(found.length).toBe(1);

      await db
        .insert(installationTokens)
        .values({ installationId: 1n, token: 'tk', expiresAt: new Date(Date.now() + 60_000) })
        .onConflictDoUpdate({
          target: installationTokens.installationId,
          set: { token: 'tk2' },
        });

      await db
        .insert(reviewState)
        .values({
          id: `rs-${deliveryId}`,
          installationId: 1n,
          prId: 'owner/repo#1',
          headSha: 'abcdef',
          state: {
            schemaVersion: 1,
            owner: 'review-agent',
            comments: [],
            metadata: {
              modelUsed: 'test',
              tokensUsed: 0,
              costUsd: 0,
              durationMs: 0,
              headSha: 'abcdef',
              baseSha: 'abcdee',
              updatedAt: new Date().toISOString(),
            },
          },
        })
        .onConflictDoNothing();

      await db.insert(costLedger).values({
        installationId: 1n,
        jobId: deliveryId,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        callPhase: 'review_main',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.0123,
        status: 'success',
      });
    } finally {
      await close();
    }
  });
});
