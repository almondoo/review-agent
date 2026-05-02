import {
  costLedger,
  installationTokens,
  reviewState,
  webhookDeliveries,
} from '@review-agent/core/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDbClient } from '../connection.js';
import { readCurrentTenant, withTenant } from '../tenancy.js';

const url = process.env.TEST_DATABASE_URL ?? '';
// Same DB but logged in as `review_agent_app` so RLS applies. Tests
// that need to seed cross-tenant rows still use the superuser via
// `url`. Provide both env vars on a real Postgres test target.
const appUrl = process.env.TEST_DATABASE_APP_URL ?? '';

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

describe.skipIf(!appUrl)('postgres RLS (tenant_isolation policy)', () => {
  it('readCurrentTenant returns null outside withTenant', async () => {
    const { db, close } = createDbClient({ url: appUrl });
    try {
      // Outside any explicit transaction the GUC is unset.
      const result = await db.transaction((tx) => readCurrentTenant(tx));
      expect(result).toBeNull();
    } finally {
      await close();
    }
  });

  it('withTenant scopes selects to the matching installation_id', async () => {
    const { db, close } = createDbClient({ url: appUrl });
    try {
      const tenantA = 9001n;
      const tenantB = 9002n;
      // Seed both tenants under their own scopes — RLS enforces the
      // installation_id matches the GUC, so we must use withTenant.
      await withTenant(db, tenantA, async (tx) => {
        await tx
          .insert(installationTokens)
          .values({ installationId: tenantA, token: 'a', expiresAt: new Date(Date.now() + 60_000) })
          .onConflictDoUpdate({
            target: installationTokens.installationId,
            set: { token: 'a' },
          });
      });
      await withTenant(db, tenantB, async (tx) => {
        await tx
          .insert(installationTokens)
          .values({ installationId: tenantB, token: 'b', expiresAt: new Date(Date.now() + 60_000) })
          .onConflictDoUpdate({
            target: installationTokens.installationId,
            set: { token: 'b' },
          });
      });

      // From tenant A: only A's row is visible.
      const visible = await withTenant(db, tenantA, (tx) => tx.select().from(installationTokens));
      expect(visible.map((r) => r.installationId)).toEqual([tenantA]);
    } finally {
      await close();
    }
  });

  it('withTenant rejects writes for a different tenant via WITH CHECK (RLS policy violation)', async () => {
    const { db, close } = createDbClient({ url: appUrl });
    try {
      // Pin the actual Postgres RLS error rather than any throw — without
      // this regex, a wrong-credential failure would also pass and we'd
      // lose visibility into whether RLS is the line of defense.
      await expect(
        withTenant(db, 9001n, async (tx) => {
          await tx.insert(installationTokens).values({
            installationId: 9999n,
            token: 'cross-tenant',
            expiresAt: new Date(Date.now() + 60_000),
          });
        }),
      ).rejects.toThrow(/row-level security|row level security|policy/i);
    } finally {
      await close();
    }
  });
});
