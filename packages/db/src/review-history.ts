import { type NewReviewHistoryRow, reviewHistory } from '@review-agent/core/db';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import type { DbClient } from './connection.js';

/**
 * Persistence side of the v1.2 epic #83 Phase 3 / #92 feedback
 * writer. The runner-side `createFeedbackWriter` calls this
 * function to commit a `review_history` row after redaction and
 * rate-limit checks have passed. Spec §7.6 sets the 180-day TTL
 * on the `expires_at` column (default value in the schema), so
 * this writer only fills in `installation_id`, `repo`,
 * `fact_type`, and `fact_text`.
 */
export function createReviewHistoryWriter(db: DbClient) {
  return async (input: {
    readonly installationId: bigint;
    readonly repo: string;
    readonly factType: 'accepted_pattern' | 'rejected_finding' | 'arch_decision';
    readonly factText: string;
  }): Promise<void> => {
    const row: NewReviewHistoryRow = {
      installationId: input.installationId,
      repo: input.repo,
      factType: input.factType,
      factText: input.factText,
    };
    await db.insert(reviewHistory).values(row);
  };
}

/**
 * Reader used by Phase 4's prompt composer (#93). Returns the
 * `factText` for the most-recent N rows scoped to a single repo.
 * Drizzle defaults `expires_at` to `now() + 180 days` so the
 * caller does NOT need to filter on expiry — Postgres preserves
 * the rows but the operator's retention job (or the upcoming
 * Phase 4 reader) can prune them. This helper applies an explicit
 * `expires_at > now()` filter as defense in depth in case the
 * retention sweep has not run yet.
 */
export async function loadRecentReviewHistory(
  db: DbClient,
  q: {
    installationId: bigint;
    repo: string;
    limit?: number;
    now?: Date;
  },
): Promise<ReadonlyArray<{ factType: string; factText: string; createdAt: Date }>> {
  const limit = q.limit ?? 50;
  const now = q.now ?? new Date();
  const rows = await db
    .select({
      factType: reviewHistory.factType,
      factText: reviewHistory.factText,
      createdAt: reviewHistory.createdAt,
    })
    .from(reviewHistory)
    .where(
      and(
        eq(reviewHistory.installationId, q.installationId),
        eq(reviewHistory.repo, q.repo),
        gt(reviewHistory.expiresAt, now),
      ),
    )
    .orderBy(desc(reviewHistory.createdAt))
    .limit(limit);
  return rows;
}

/**
 * Optional cleanup helper for the 180-day TTL (spec §7.6). The
 * server's existing idempotency-cleanup elector can run this on a
 * fixed cadence to keep the table bounded; the writer itself does
 * not delete rows on insert.
 */
export async function pruneExpiredReviewHistory(
  db: DbClient,
  opts: { now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const result = await db.delete(reviewHistory).where(lt(reviewHistory.expiresAt, now));
  // drizzle-orm/postgres-js returns the rowcount on the implementation;
  // some adapters surface it as `rowCount`, others as the array length.
  const r = result as unknown as { rowCount?: number; length?: number };
  return r.rowCount ?? r.length ?? 0;
}
