import { reviewHistory } from '@review-agent/core/db';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDbClient } from '../connection.js';
import { createReviewHistoryWriter, loadRecentReviewHistory } from '../review-history.js';
import { withTenant } from '../tenancy.js';

// v1.2 #110 — migration 0004 forward-compat suite.
//
// Pre-#110 CodeCommit runtime wrote `review_history.repo` as `'/foo'`
// (the adapter sets `PRRef.owner === ''`). Migration 0004 rewrites
// every legacy `'/foo'` row to `'${installation_id}/foo'` so the
// runtime / recovery CLI / reader all agree on a single shape.
//
// Gated on `TEST_DATABASE_APP_URL`; the suite is skipped without it
// (same convention as `migration-compat.integration.test.ts`).

const url = process.env.TEST_DATABASE_URL ?? '';
const appUrl = process.env.TEST_DATABASE_APP_URL ?? '';

describe.skipIf(!url || !appUrl)('migration 0004 codecommit repo normalize (#110)', () => {
  it('legacy /foo rows are rewritten to (installation_id)/foo by the migration', async () => {
    // The migrate runner has already executed at test bootstrap.
    // Insert a row through a path that bypasses normalization (raw
    // INSERT via the superuser pool — the writer would emit the
    // normalized shape) to simulate a pre-0004 row that the
    // migration must rewrite. We then re-run the same UPDATE
    // statement directly so this test is self-contained and does
    // not rely on test ordering.
    const { db: appDb, close: closeApp } = createDbClient({ url: appUrl });
    const { db: rootDb, close: closeRoot } = createDbClient({ url });
    try {
      const tenant = 9991n;
      const legacyText = `[fp:0000000000004001] codecommit-recover thumbs_up at ${new Date().toISOString()}`;
      // Insert a legacy `/foo` row via the superuser to simulate
      // pre-migration data. We bypass `withTenant` here because we
      // explicitly want to verify the migration's effect on a row
      // that the live writer would no longer produce.
      await rootDb.execute(
        sql`INSERT INTO review_history (installation_id, repo, fact_type, fact_text)
            VALUES (${tenant}, '/legacy-repo', 'accepted_pattern', ${legacyText})`,
      );
      // Apply the 0004 transformation (idempotent; the runner has
      // already run it once at startup, this is a self-contained
      // re-application against the row we just inserted).
      await rootDb.execute(sql`UPDATE review_history
                                  SET repo = installation_id::text || repo
                                WHERE repo LIKE '/%'`);

      const rows = (await rootDb.execute(
        sql`SELECT repo FROM review_history
             WHERE installation_id = ${tenant}
               AND fact_text = ${legacyText}`,
      )) as ReadonlyArray<{ repo: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.repo).toBe(`${tenant}/legacy-repo`);

      // And the reader now finds it under the normalized key.
      const found = await withTenant(appDb, tenant, () =>
        loadRecentReviewHistory(appDb, {
          installationId: tenant,
          repo: `${tenant}/legacy-repo`,
          limit: 10,
        }),
      );
      expect(found.some((r) => r.factText === legacyText)).toBe(true);
    } finally {
      await closeApp();
      await closeRoot();
    }
  });

  it('post-migration writes through the writer (already-normalized shape) are untouched', async () => {
    const { db, close } = createDbClient({ url: appUrl });
    try {
      const tenant = 9992n;
      const factText = `[fp:0000000000004002] codecommit-recover thumbs_down at ${new Date().toISOString()}`;
      const repo = `${tenant}/new-shape-repo`;
      const writer = createReviewHistoryWriter(db);
      await withTenant(db, tenant, async () => {
        await writer({
          installationId: tenant,
          repo,
          factType: 'rejected_finding',
          factText,
        });
      });
      // Re-running the 0004 UPDATE is a no-op on rows whose repo
      // does not start with `/`. We assert that explicitly.
      await db.execute(sql`UPDATE review_history
                              SET repo = installation_id::text || repo
                            WHERE repo LIKE '/%'`);
      const rows = await withTenant(db, tenant, () =>
        db
          .select({ repo: reviewHistory.repo, factText: reviewHistory.factText })
          .from(reviewHistory)
          .where(sql`${reviewHistory.installationId} = ${tenant}
                     AND ${reviewHistory.factText} = ${factText}`),
      );
      expect(rows.length).toBe(1);
      expect(rows[0]?.repo).toBe(repo);
    } finally {
      await close();
    }
  });
});
