/**
 * Quality metrics aggregation helpers for issue #142 Phase A.
 *
 * Each helper operates within a `withTenant` scope so RLS on
 * `review_eval_event` and `review_history` is satisfied for the
 * `review_agent_app` role. Every exported function receives an
 * `installationId` and sets `app.current_tenant` before executing
 * any query.
 *
 * Metrics defined here:
 *   - latency:        P50 / P95 of `review_eval_event.latency_ms`
 *   - coverage:       sum(files_reviewed) / sum(files_total), rows where
 *                     files_total IS NOT NULL AND files_total > 0 only
 *   - acceptanceRate: accepted_pattern / (accepted_pattern + rejected_finding)
 *                     from review_history
 *   - falsePositiveRate: (rejected_finding + suppression_rule) / sum(comment_count)
 *                     from review_eval_event + review_history
 *   - reviewCount:    count of review_eval_event rows
 *
 * All metrics return `null` when the denominator is zero or no data is
 * available (graceful N/A — never crash on empty data).
 */
import { reviewEvalEvent, reviewHistory } from '@review-agent/core/db';
import { and, count, eq, gte, isNull, not, sql, sum } from 'drizzle-orm';
import type { DbClient } from './connection.js';
import { withTenant } from './tenancy.js';

// ---------------------------------------------------------------------------
// Period resolution
// ---------------------------------------------------------------------------

/** Convert the `since` alias to a millisecond offset from `now`. */
function sinceMs(since: '24h' | '7d' | '30d'): number {
  if (since === '24h') return 24 * 60 * 60 * 1000;
  if (since === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

// ---------------------------------------------------------------------------
// Per-repo metric row
// ---------------------------------------------------------------------------

export type RepoQualityMetrics = {
  readonly repo: string;
  readonly reviewCount: number;
  readonly acceptanceRate: number | null;
  readonly falsePositiveRate: number | null;
  readonly coverageRate: number | null;
  readonly latencyP50Ms: number | null;
  readonly latencyP95Ms: number | null;
};

export type QualityMetricsResult = {
  readonly overall: Omit<RepoQualityMetrics, 'repo'>;
  readonly perRepo: ReadonlyArray<RepoQualityMetrics>;
};

// ---------------------------------------------------------------------------
// Helper: coerce SQL numeric strings to number | null
// ---------------------------------------------------------------------------

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Main aggregation
// ---------------------------------------------------------------------------

/**
 * Compute quality metrics for a single installation, optionally filtered
 * to a time window (`since`).
 *
 * Internally opens a transaction and sets `app.current_tenant` via
 * `withTenant` so RLS policies on `review_eval_event` and `review_history`
 * are satisfied. Without this GUC the `review_agent_app` role receives zero
 * rows on both tables (fail-closed RLS), making all metrics appear as 0 /
 * null.
 */
export async function loadQualityMetrics(
  db: DbClient,
  q: {
    readonly installationId: bigint;
    readonly since: '24h' | '7d' | '30d';
    readonly now?: Date;
  },
): Promise<QualityMetricsResult> {
  const now = q.now ?? new Date();
  const cutoff = new Date(now.getTime() - sinceMs(q.since));

  return withTenant(db, q.installationId, async (tx) => {
    // ------------------------------------------------------------------
    // 1. Per-repo latency + review count + comment count from eval events
    // ------------------------------------------------------------------
    const evalRows = await tx
      .select({
        repo: reviewEvalEvent.repo,
        reviewCount: count(),
        totalCommentCount: sum(reviewEvalEvent.commentCount),
        filesTotal: sum(reviewEvalEvent.filesTotal),
        filesReviewed: sum(reviewEvalEvent.filesReviewed),
        p50: sql<
          string | null
        >`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${reviewEvalEvent.latencyMs})`,
        p95: sql<
          string | null
        >`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${reviewEvalEvent.latencyMs})`,
      })
      .from(reviewEvalEvent)
      .where(
        and(
          eq(reviewEvalEvent.installationId, q.installationId),
          gte(reviewEvalEvent.createdAt, cutoff),
        ),
      )
      .groupBy(reviewEvalEvent.repo);

    // ------------------------------------------------------------------
    // 2. Per-repo feedback counts from review_history (non-expired)
    // ------------------------------------------------------------------
    // accepted_pattern count per repo
    const acceptedRows = await tx
      .select({
        repo: reviewHistory.repo,
        n: count(),
      })
      .from(reviewHistory)
      .where(
        and(
          eq(reviewHistory.installationId, q.installationId),
          eq(reviewHistory.factType, 'accepted_pattern'),
          gte(reviewHistory.createdAt, cutoff),
          not(isNull(reviewHistory.expiresAt)),
          sql`${reviewHistory.expiresAt} > now()`,
        ),
      )
      .groupBy(reviewHistory.repo);

    // rejected_finding count per repo
    const rejectedRows = await tx
      .select({
        repo: reviewHistory.repo,
        n: count(),
      })
      .from(reviewHistory)
      .where(
        and(
          eq(reviewHistory.installationId, q.installationId),
          eq(reviewHistory.factType, 'rejected_finding'),
          gte(reviewHistory.createdAt, cutoff),
          not(isNull(reviewHistory.expiresAt)),
          sql`${reviewHistory.expiresAt} > now()`,
        ),
      )
      .groupBy(reviewHistory.repo);

    // suppression_rule count per repo
    const suppressionRows = await tx
      .select({
        repo: reviewHistory.repo,
        n: count(),
      })
      .from(reviewHistory)
      .where(
        and(
          eq(reviewHistory.installationId, q.installationId),
          eq(reviewHistory.factType, 'suppression_rule'),
          gte(reviewHistory.createdAt, cutoff),
          not(isNull(reviewHistory.expiresAt)),
          sql`${reviewHistory.expiresAt} > now()`,
        ),
      )
      .groupBy(reviewHistory.repo);

    // ------------------------------------------------------------------
    // 3. Assemble per-repo metrics
    // ------------------------------------------------------------------
    const acceptedMap = new Map(acceptedRows.map((r) => [r.repo, Number(r.n)]));
    const rejectedMap = new Map(rejectedRows.map((r) => [r.repo, Number(r.n)]));
    const suppressionMap = new Map(suppressionRows.map((r) => [r.repo, Number(r.n)]));

    const perRepo: RepoQualityMetrics[] = evalRows.map((row) => {
      const accepted = acceptedMap.get(row.repo) ?? 0;
      const rejected = rejectedMap.get(row.repo) ?? 0;
      const suppressed = suppressionMap.get(row.repo) ?? 0;
      const totalComments = toNumberOrNull(row.totalCommentCount) ?? 0;

      const acceptanceDenom = accepted + rejected;
      const acceptanceRate = acceptanceDenom > 0 ? accepted / acceptanceDenom : null;

      const fpNumerator = rejected + suppressed;
      const falsePositiveRate =
        totalComments > 0 && fpNumerator > 0 ? fpNumerator / totalComments : null;

      const fTotal = toNumberOrNull(row.filesTotal);
      const fReviewed = toNumberOrNull(row.filesReviewed);
      const coverageRate =
        fTotal !== null && fTotal > 0 && fReviewed !== null ? fReviewed / fTotal : null;

      return {
        repo: row.repo,
        reviewCount: Number(row.reviewCount),
        acceptanceRate,
        falsePositiveRate,
        coverageRate,
        latencyP50Ms: toNumberOrNull(row.p50),
        latencyP95Ms: toNumberOrNull(row.p95),
      };
    });

    // ------------------------------------------------------------------
    // 4. Overall (cross-repo aggregates)
    // ------------------------------------------------------------------
    const overallReviewCount = perRepo.reduce((s, r) => s + r.reviewCount, 0);

    // Overall latency: re-query across all repos for correct percentile_cont
    const overallEvalRow = await tx
      .select({
        p50: sql<
          string | null
        >`percentile_cont(0.5) WITHIN GROUP (ORDER BY ${reviewEvalEvent.latencyMs})`,
        p95: sql<
          string | null
        >`percentile_cont(0.95) WITHIN GROUP (ORDER BY ${reviewEvalEvent.latencyMs})`,
        filesTotal: sum(reviewEvalEvent.filesTotal),
        filesReviewed: sum(reviewEvalEvent.filesReviewed),
        totalCommentCount: sum(reviewEvalEvent.commentCount),
      })
      .from(reviewEvalEvent)
      .where(
        and(
          eq(reviewEvalEvent.installationId, q.installationId),
          gte(reviewEvalEvent.createdAt, cutoff),
        ),
      );

    const overallRow = overallEvalRow[0];

    const totalAccepted = acceptedRows.reduce((s, r) => s + Number(r.n), 0);
    const totalRejected = rejectedRows.reduce((s, r) => s + Number(r.n), 0);
    const totalSuppressed = suppressionRows.reduce((s, r) => s + Number(r.n), 0);
    const totalComments = toNumberOrNull(overallRow?.totalCommentCount) ?? 0;

    const overallAcceptDenom = totalAccepted + totalRejected;
    const overallAcceptanceRate =
      overallAcceptDenom > 0 ? totalAccepted / overallAcceptDenom : null;

    const overallFpNumerator = totalRejected + totalSuppressed;
    const overallFalsePositiveRate =
      totalComments > 0 && overallFpNumerator > 0 ? overallFpNumerator / totalComments : null;

    const overallFilesTotal = toNumberOrNull(overallRow?.filesTotal);
    const overallFilesReviewed = toNumberOrNull(overallRow?.filesReviewed);
    const overallCoverageRate =
      overallFilesTotal !== null && overallFilesTotal > 0 && overallFilesReviewed !== null
        ? overallFilesReviewed / overallFilesTotal
        : null;

    const overall: Omit<RepoQualityMetrics, 'repo'> = {
      reviewCount: overallReviewCount,
      acceptanceRate: overallAcceptanceRate,
      falsePositiveRate: overallFalsePositiveRate,
      coverageRate: overallCoverageRate,
      latencyP50Ms: toNumberOrNull(overallRow?.p50),
      latencyP95Ms: toNumberOrNull(overallRow?.p95),
    };

    return { overall, perRepo };
  });
}
