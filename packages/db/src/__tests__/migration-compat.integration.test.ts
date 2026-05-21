import { costLedger, reviewEvalEvent } from '@review-agent/core/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDbClient } from '../connection.js';
import { createReviewEvalEventRecorder } from '../review-eval-event.js';
import { createReviewHistoryWriter, loadRecentReviewHistory } from '../review-history.js';
import { withTenant } from '../tenancy.js';

// v1.2 #107. The migration is forward-compatible: v1.1 code keeps
// working against the v1.2-migrated schema. These tests run against
// a real Postgres so the default expressions (`expires_at DEFAULT
// now() + interval '180 days'`) and column-add idempotency are
// observed by an actual planner, not just the Drizzle types.
//
// Gated on `TEST_DATABASE_APP_URL` (the appRole connection used by
// every RLS-aware integration test in this package). Without it the
// `describe` block is skipped and the file passes — the same shape as
// `audit-retention.integration.test.ts` and `integration.test.ts`.

const url = process.env.TEST_DATABASE_URL ?? '';
const appUrl = process.env.TEST_DATABASE_APP_URL ?? '';

describe.skipIf(!url || !appUrl)('migration 0003 forward-compat (#107)', () => {
  it('cost_ledger inserts that omit latency_ms still succeed; column defaults to 0 (v1.1 → v1.2 forward-compat)', async () => {
    // v1.1 callers do not know the column exists. The migration adds
    // it with `DEFAULT 0`, so v1.1 inserts must continue to work
    // unchanged. We assert both directions: insert succeeds AND the
    // column reads back as 0 (NOT NULL). A future migration that
    // drops the default would break this test.
    const { db, close } = createDbClient({ url: appUrl });
    try {
      const tenant = 4242n;
      const jobId = `v107-cost-${Date.now()}`;
      await withTenant(db, tenant, async () => {
        await db.insert(costLedger).values({
          installationId: tenant,
          jobId,
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          callPhase: 'review_main',
          inputTokens: 100,
          outputTokens: 50,
          costUsd: 0.001,
        });
      });
      const rows = (await db.execute(
        sql`SELECT latency_ms FROM cost_ledger WHERE job_id = ${jobId}`,
      )) as ReadonlyArray<{ latency_ms: number | null }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.latency_ms ?? null).toBe(0);
    } finally {
      await close();
    }
  });

  it('review_eval_event recorder uses the documented input shape and round-trips latency_ms (Phase 2 contract)', async () => {
    // Narrow promise: a missing `review_eval_event` table (the only
    // "migration not applied" state we can simulate cleanly) would
    // surface as a recorder throw. The runner catches that via
    // `onEvalRecordError` (verified separately in agent.test.ts) and
    // the review still posts. We pin the column shape here so a
    // future schema change to the recorder requires updating both
    // tests in lockstep.
    const { db, close } = createDbClient({ url: appUrl });
    try {
      const tenant = 4243n;
      const recorder = createReviewEvalEventRecorder(db);
      await withTenant(db, tenant, async () => {
        await recorder({
          installationId: tenant,
          jobId: `v107-eval-${Date.now()}`,
          repo: 'almondoo/review-agent',
          prNumber: 1,
          headSha: 'h',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          commentCount: 1,
          severityDist: { critical: 0, major: 0, minor: 1, info: 0 },
          confidenceDist: { high: 1, medium: 0, low: 0 },
          droppedDuplicates: 0,
          droppedByFeedback: 0,
          toolCalls: 0,
          latencyMs: 1234,
          costUsd: 0.002,
          tokensInput: 200,
          tokensOutput: 50,
          abortReason: null,
        });
      });
      const rows = await withTenant(db, tenant, () =>
        db
          .select({
            latencyMs: reviewEvalEvent.latencyMs,
          })
          .from(reviewEvalEvent)
          .where(sql`${reviewEvalEvent.installationId} = ${tenant}`),
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0]?.latencyMs).toBe(1234);
    } finally {
      await close();
    }
  });

  it('review_history.expires_at defaults to ~now + 180 days (boundary 179.95 < delta < 180.05)', async () => {
    // Pin the default expression so a future migration that drops
    // the `DEFAULT now() + interval '180 days'` (or bumps it to 365)
    // is caught immediately. The migration target is to keep this
    // window stable; spec §7.6 sets the TTL.
    const { db, close } = createDbClient({ url: appUrl });
    try {
      const tenant = 4244n;
      const writer = createReviewHistoryWriter(db);
      await withTenant(db, tenant, async () => {
        await writer({
          installationId: tenant,
          repo: 'almondoo/review-agent',
          factType: 'rejected_finding',
          factText: '[fp:0000000000000001] expiry boundary test',
        });
      });
      const rows = (await db.execute(
        sql`SELECT EXTRACT(EPOCH FROM (expires_at - now()))::float / 86400.0 AS delta_days
            FROM review_history
            WHERE installation_id = ${Number(tenant)}
            ORDER BY id DESC
            LIMIT 1`,
      )) as ReadonlyArray<{ delta_days: number | string }>;
      const deltaDays = Number(rows[0]?.delta_days ?? 0);
      // Tight band around 180 days so accidental migration changes
      // (now+0d, now+365d) fail immediately.
      expect(deltaDays).toBeGreaterThan(179.95);
      expect(deltaDays).toBeLessThan(180.05);
    } finally {
      await close();
    }
  });

  it('writing review_eval_event rows does NOT side-effect review_history reads (table isolation regression guard)', async () => {
    // Cheap guard against an accidental view / trigger / shared
    // sequence introduced in a future migration. We snapshot
    // review_history before + after a recorder write and assert the
    // reader returns the same rows.
    const { db, close } = createDbClient({ url: appUrl });
    try {
      const tenant = 4245n;
      const writer = createReviewHistoryWriter(db);
      const recorder = createReviewEvalEventRecorder(db);

      await withTenant(db, tenant, async () => {
        await writer({
          installationId: tenant,
          repo: 'almondoo/review-agent',
          factType: 'accepted_pattern',
          factText: '[fp:0000000000000002] before eval traffic',
        });
      });
      const before = await withTenant(db, tenant, () =>
        loadRecentReviewHistory(db, {
          installationId: tenant,
          repo: 'almondoo/review-agent',
          limit: 50,
        }),
      );

      await withTenant(db, tenant, async () => {
        await recorder({
          installationId: tenant,
          jobId: `v107-iso-${Date.now()}`,
          repo: 'almondoo/review-agent',
          prNumber: 9,
          headSha: 'h',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          commentCount: 0,
          severityDist: { critical: 0, major: 0, minor: 0, info: 0 },
          confidenceDist: { high: 0, medium: 0, low: 0 },
          droppedDuplicates: 0,
          droppedByFeedback: 0,
          toolCalls: 0,
          latencyMs: 0,
          costUsd: 0,
          tokensInput: 0,
          tokensOutput: 0,
          abortReason: null,
        });
      });

      const after = await withTenant(db, tenant, () =>
        loadRecentReviewHistory(db, {
          installationId: tenant,
          repo: 'almondoo/review-agent',
          limit: 50,
        }),
      );
      expect(after.length).toBe(before.length);
      expect(after.map((r) => r.factText)).toEqual(before.map((r) => r.factText));
    } finally {
      await close();
    }
  });
});
