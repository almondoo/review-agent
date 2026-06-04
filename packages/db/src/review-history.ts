import { type NewReviewHistoryRow, reviewHistory } from '@review-agent/core/db';
import { and, count, desc, eq, gt, lt } from 'drizzle-orm';
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
    readonly factType:
      | 'accepted_pattern'
      | 'rejected_finding'
      | 'arch_decision'
      | 'suppression_rule';
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

// ---------------------------------------------------------------------------
// Suppression rule helpers — #155 false-positive suppression
// ---------------------------------------------------------------------------

/**
 * Count non-expired `rejected_finding` rows whose `factText` starts with
 * `[fp:<fingerprint>]` for the given installation + repo.
 *
 * Used by the runner to decide whether the suppression threshold has been
 * reached: if the count ≥ `suppress_after`, create a suppression rule.
 */
export async function countRejectionsByFingerprint(
  db: DbClient,
  q: {
    readonly installationId: bigint;
    readonly repo: string;
    readonly fingerprint: string;
    readonly now?: Date;
  },
): Promise<number> {
  const now = q.now ?? new Date();
  const prefix = `[fp:${q.fingerprint}]`;
  // Drizzle does not expose a `LIKE` helper in its top-level exports for
  // all versions; use a raw SQL condition via the `sql` tag from drizzle-orm.
  const { sql: sqlTag } = await import('drizzle-orm');
  const rows = await db
    .select({ n: count() })
    .from(reviewHistory)
    .where(
      and(
        eq(reviewHistory.installationId, q.installationId),
        eq(reviewHistory.repo, q.repo),
        eq(reviewHistory.factType, 'rejected_finding'),
        gt(reviewHistory.expiresAt, now),
        // Match rows whose factText starts with the `[fp:<fingerprint>]` prefix.
        sqlTag`${reviewHistory.factText} LIKE ${`${prefix}%`}`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/**
 * Create a single `suppression_rule` row for the given fingerprint. The
 * caller is responsible for deduplication (i.e. check for an existing active
 * rule first via `loadActiveSuppressionRules`). The `factText` format mirrors
 * the existing `rejected_finding` convention: `[fp:<fingerprint>] <reason>`.
 *
 * Returns the auto-generated `id` of the newly-inserted row.
 */
export async function createSuppressionRule(
  db: DbClient,
  input: {
    readonly installationId: bigint;
    readonly repo: string;
    readonly fingerprint: string;
    readonly reason: string;
  },
): Promise<bigint> {
  const factText = `[fp:${input.fingerprint}] ${input.reason}`;
  const rows = await db
    .insert(reviewHistory)
    .values({
      installationId: input.installationId,
      repo: input.repo,
      factType: 'suppression_rule',
      factText,
    } satisfies NewReviewHistoryRow)
    .returning({ id: reviewHistory.id });
  const inserted = rows[0];
  if (inserted === undefined) {
    throw new Error('createSuppressionRule: insert returned no rows');
  }
  return inserted.id as bigint;
}

/**
 * Load all non-expired `suppression_rule` rows for an installation + repo.
 * Returns the `factText` strings (each carries `[fp:<fingerprint>]`) plus
 * the row `id` (needed by the CLI `suppression remove` command).
 */
export async function loadActiveSuppressionRules(
  db: DbClient,
  q: {
    readonly installationId: bigint;
    readonly repo: string;
    readonly now?: Date;
  },
): Promise<
  ReadonlyArray<{
    readonly id: bigint;
    readonly factText: string;
    readonly createdAt: Date;
    readonly expiresAt: Date;
  }>
> {
  const now = q.now ?? new Date();
  const rows = await db
    .select({
      id: reviewHistory.id,
      factText: reviewHistory.factText,
      createdAt: reviewHistory.createdAt,
      expiresAt: reviewHistory.expiresAt,
    })
    .from(reviewHistory)
    .where(
      and(
        eq(reviewHistory.installationId, q.installationId),
        eq(reviewHistory.repo, q.repo),
        eq(reviewHistory.factType, 'suppression_rule'),
        gt(reviewHistory.expiresAt, now),
      ),
    )
    .orderBy(desc(reviewHistory.createdAt));
  return rows.map((r) => ({
    id: r.id as bigint,
    factText: r.factText,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  }));
}

/**
 * Delete a single suppression rule by its `review_history.id`. The caller
 * (CLI `suppression remove`) is responsible for verifying the row belongs
 * to the correct installation + repo before calling this (multi-tenant
 * safety). Returns `true` when a row was deleted, `false` when the id was
 * not found (already expired / already removed — idempotent).
 */
export async function deleteSuppressionRule(
  db: DbClient,
  q: {
    readonly id: bigint;
    readonly installationId: bigint;
    readonly repo: string;
  },
): Promise<boolean> {
  const result = await db
    .delete(reviewHistory)
    .where(
      and(
        eq(reviewHistory.id, q.id),
        eq(reviewHistory.installationId, q.installationId),
        eq(reviewHistory.repo, q.repo),
        eq(reviewHistory.factType, 'suppression_rule'),
      ),
    );
  const r = result as unknown as { rowCount?: number; length?: number };
  return (r.rowCount ?? r.length ?? 0) > 0;
}
