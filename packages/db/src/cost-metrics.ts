/**
 * Cost metrics aggregation helpers for issue #140.
 *
 * Each helper operates within a `withTenant` scope so RLS on
 * `cost_ledger` and `review_eval_event` is satisfied for the
 * `review_agent_app` role. Every exported function receives an
 * `installationId` and sets `app.current_tenant` before executing
 * any query.
 *
 * Metrics defined here:
 *   - overall:    total cost_usd, total tokens (input/output/cache),
 *                 and call count in the period.
 *   - perModel:   GROUP BY provider+model cost/call breakdown.
 *   - perRepo:    cost_ledger JOIN review_eval_event ON job_id, then
 *                 GROUP BY repo. Rows with no matching eval event are
 *                 excluded (unattributable). Paginated by `limit`/`cursor`
 *                 in descending cost order (AC#4).
 *   - perPeriod:  time-series buckets — 24h→hourly, 7d/30d→daily,
 *                 returned as `[{ bucket: ISO, costUsd }]`.
 *
 * All numeric aggregates return 0 (not null) when no data exists.
 * Empty arrays are returned for list fields.
 *
 * NOTE: notification delivery of budget_alert_usd crossings is
 * intentionally NOT implemented here — emit is in cost-guard.ts;
 * the channel consumer (Slack/email) is deferred to issue #144.
 */
import { costLedger, reviewEvalEvent } from '@review-agent/core/db';
import { and, asc, count, eq, gt, gte, sql, sum } from 'drizzle-orm';
import type { DbClient } from './connection.js';
import { withTenant } from './tenancy.js';

// ---------------------------------------------------------------------------
// Period resolution (shared with quality-metrics)
// ---------------------------------------------------------------------------

function sinceMs(since: '24h' | '7d' | '30d'): number {
  if (since === '24h') return 24 * 60 * 60 * 1000;
  if (since === '7d') return 7 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

/** date_trunc unit for the per-period buckets. */
function dateTruncUnit(since: '24h' | '7d' | '30d'): string {
  return since === '24h' ? 'hour' : 'day';
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export type ModelCostSnapshot = {
  readonly provider: string;
  readonly model: string;
  readonly costUsd: number;
  readonly callCount: number;
};

export type RepoCostSnapshot = {
  readonly repo: string;
  readonly costUsd: number;
};

export type PeriodCostBucket = {
  /** UTC ISO-8601 string for the bucket start (hour or day). */
  readonly bucket: string;
  readonly costUsd: number;
};

export type CostMetricsOverall = {
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheCreationTokens: number;
  readonly callCount: number;
  /**
   * When `budget_alert_usd` is configured on the installation's config and
   * the period cost exceeds it, this field carries the threshold so the
   * dashboard can highlight overspend. Null when no threshold is configured
   * or the threshold is not exceeded.
   */
  readonly budgetAlertUsd: number | null;
};

export type CostMetricsResult = {
  readonly overall: CostMetricsOverall;
  readonly perModel: ReadonlyArray<ModelCostSnapshot>;
  readonly perRepo: ReadonlyArray<RepoCostSnapshot>;
  readonly nextCursor: string | null;
  readonly perPeriod: ReadonlyArray<PeriodCostBucket>;
};

// ---------------------------------------------------------------------------
// Helper: coerce SQL numeric strings to number
// ---------------------------------------------------------------------------

function toNumber(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Helper: convert a date_trunc result to ISO string
// Drizzle annotates date_trunc results as sql<string> but at runtime
// postgres-js may return a Date object depending on type coercion settings.
// We use a runtime typeof/truthy check instead of instanceof to avoid the
// TypeScript error "left side of instanceof must be an object type".
// ---------------------------------------------------------------------------

function bucketToIso(v: unknown): string {
  if (v !== null && v !== undefined && typeof v === 'object' && 'toISOString' in v) {
    return (v as { toISOString(): string }).toISOString();
  }
  return String(v ?? '');
}

// ---------------------------------------------------------------------------
// Main aggregation
// ---------------------------------------------------------------------------

/**
 * Compute cost analytics for a single installation, optionally filtered
 * to a time window (`since`).
 *
 * Internally opens a transaction and sets `app.current_tenant` via
 * `withTenant` so RLS policies on `cost_ledger` and `review_eval_event`
 * are satisfied. Without this GUC the `review_agent_app` role receives zero
 * rows (fail-closed RLS), making all cost totals appear as 0.
 *
 * Per-repo pagination uses cursor-based ordering by `repo` name after
 * sorting by descending `costUsd`. The cursor is an opaque string encoding
 * the last returned repo name; callers pass it back as `cursor` to fetch
 * the next page.
 */
export async function loadCostMetrics(
  db: DbClient,
  q: {
    readonly installationId: bigint;
    readonly since: '24h' | '7d' | '30d';
    readonly limit?: number;
    readonly cursor?: string;
    readonly budgetAlertUsd?: number;
    readonly now?: Date;
  },
): Promise<CostMetricsResult> {
  const now = q.now ?? new Date();
  const cutoff = new Date(now.getTime() - sinceMs(q.since));
  const pageLimit = q.limit ?? 20;
  const truncUnit = dateTruncUnit(q.since);

  return withTenant(db, q.installationId, async (tx) => {
    // ------------------------------------------------------------------
    // 1. Overall aggregates from cost_ledger
    // ------------------------------------------------------------------
    const overallRows = await tx
      .select({
        totalCostUsd: sum(costLedger.costUsd),
        totalInputTokens: sum(costLedger.inputTokens),
        totalOutputTokens: sum(costLedger.outputTokens),
        totalCacheReadTokens: sum(costLedger.cacheReadTokens),
        totalCacheCreationTokens: sum(costLedger.cacheCreationTokens),
        callCount: count(),
      })
      .from(costLedger)
      .where(
        and(eq(costLedger.installationId, q.installationId), gte(costLedger.createdAt, cutoff)),
      );

    const overallRow = overallRows[0];
    const totalCostUsd = toNumber(overallRow?.totalCostUsd);

    // Determine budget alert: emit null unless config threshold is set AND exceeded.
    const budgetAlertUsd =
      q.budgetAlertUsd !== undefined && totalCostUsd > q.budgetAlertUsd ? q.budgetAlertUsd : null;

    const overall: CostMetricsOverall = {
      totalCostUsd,
      totalInputTokens: toNumber(overallRow?.totalInputTokens),
      totalOutputTokens: toNumber(overallRow?.totalOutputTokens),
      totalCacheReadTokens: toNumber(overallRow?.totalCacheReadTokens),
      totalCacheCreationTokens: toNumber(overallRow?.totalCacheCreationTokens),
      callCount: toNumber(overallRow?.callCount),
      budgetAlertUsd,
    };

    // ------------------------------------------------------------------
    // 2. Per-model breakdown (provider + model)
    // ------------------------------------------------------------------
    const perModelRows = await tx
      .select({
        provider: costLedger.provider,
        model: costLedger.model,
        costUsd: sum(costLedger.costUsd),
        callCount: count(),
      })
      .from(costLedger)
      .where(
        and(eq(costLedger.installationId, q.installationId), gte(costLedger.createdAt, cutoff)),
      )
      .groupBy(costLedger.provider, costLedger.model)
      .orderBy(sql`sum(${costLedger.costUsd}) DESC`);

    const perModel: ModelCostSnapshot[] = perModelRows.map((r) => ({
      provider: r.provider,
      model: r.model,
      costUsd: toNumber(r.costUsd),
      callCount: toNumber(r.callCount),
    }));

    // ------------------------------------------------------------------
    // 3. Per-repo: JOIN cost_ledger ⟶ review_eval_event on job_id,
    //    group by repo, paginated by descending cost then repo name cursor.
    //
    //    cost_ledger has no `repo` column — the link is:
    //      cost_ledger.job_id = review_eval_event.job_id
    //    review_eval_event carries `repo`.
    //    Rows in cost_ledger without a matching eval event are excluded
    //    (inner join semantics → unattributable).
    // ------------------------------------------------------------------
    const repoBaseConditions = and(
      eq(costLedger.installationId, q.installationId),
      gte(costLedger.createdAt, cutoff),
      eq(reviewEvalEvent.installationId, q.installationId),
    );

    // Cursor pagination: after getting per-repo rows ordered by (cost DESC,
    // repo ASC) we use the last repo name as cursor. On subsequent pages we
    // filter rows by the sub-query that returns their rank, implemented here
    // as a simple offset-after-cursor pattern using a stable sort key.
    // For simplicity we use keyset on (costUsd ASC, repo ASC) — callers
    // advance by passing the last repo name as cursor.

    // Build the per-repo aggregation query (with optional cursor filter).
    // We aggregate first, then filter the cursor after aggregation via a subquery.
    // Drizzle ORM does not support HAVING on aggregate aliases directly, so we
    // use a raw-SQL approach: wrap in a subquery with a WHERE.
    //
    // Implementation approach: run the grouped query, slice in JS for the page.
    // This avoids complex nested SQL and is correct for the page sizes in use
    // (cost analytics pages are typically top-20 repos).
    const perRepoAllRows = await tx
      .select({
        repo: reviewEvalEvent.repo,
        costUsd: sum(costLedger.costUsd),
      })
      .from(costLedger)
      .innerJoin(
        reviewEvalEvent,
        and(
          eq(costLedger.jobId, reviewEvalEvent.jobId),
          eq(reviewEvalEvent.installationId, q.installationId),
        ),
      )
      .where(repoBaseConditions)
      .groupBy(reviewEvalEvent.repo)
      .orderBy(sql`sum(${costLedger.costUsd}) DESC`, asc(reviewEvalEvent.repo));

    // Apply cursor-based pagination in JS (stable sort already applied above).
    let startIdx = 0;
    if (q.cursor !== undefined) {
      const found = perRepoAllRows.findIndex((r) => r.repo === q.cursor);
      startIdx = found !== -1 ? found + 1 : 0;
    }

    const pageRows = perRepoAllRows.slice(startIdx, startIdx + pageLimit);
    const hasMore = startIdx + pageLimit < perRepoAllRows.length;
    const nextCursor = hasMore ? (pageRows[pageRows.length - 1]?.repo ?? null) : null;

    const perRepo: RepoCostSnapshot[] = pageRows.map((r) => ({
      repo: r.repo,
      costUsd: toNumber(r.costUsd),
    }));

    // ------------------------------------------------------------------
    // 4. Per-period buckets: date_trunc by hour (24h) or day (7d/30d)
    // ------------------------------------------------------------------
    const perPeriodRows = await tx
      .select({
        bucket: sql<string>`date_trunc(${truncUnit}, ${costLedger.createdAt})`,
        costUsd: sum(costLedger.costUsd),
      })
      .from(costLedger)
      .where(
        and(
          eq(costLedger.installationId, q.installationId),
          gte(costLedger.createdAt, cutoff),
          gt(costLedger.costUsd, 0),
        ),
      )
      .groupBy(sql`date_trunc(${truncUnit}, ${costLedger.createdAt})`)
      .orderBy(sql`date_trunc(${truncUnit}, ${costLedger.createdAt}) ASC`);

    const perPeriod: PeriodCostBucket[] = perPeriodRows.map((r) => ({
      bucket: bucketToIso(r.bucket),
      costUsd: toNumber(r.costUsd),
    }));

    return { overall, perModel, perRepo, nextCursor, perPeriod };
  });
}
