/**
 * Overview totals aggregation helper for issue #166.
 *
 * `GET /api/dashboard/overview` reports `reviewsMonth` and `costMtd` across
 * all installations visible to the caller. Both `review_eval_event` and
 * `cost_ledger` have RLS enabled — queries against them without
 * `app.current_tenant` set return zero rows under the `review_agent_app` role
 * (fail-closed policy). This module aggregates across a caller-supplied set of
 * installation IDs by running each inside `withTenant` and summing the results.
 *
 * Repos with a null `installation_id` (manually-registered repos) cannot be
 * scoped to a tenant. Their review / cost data is not accessible under
 * per-installation RLS and is therefore excluded from the totals. This is an
 * inherent limitation of the per-installation RLS model; it is documented here
 * and in the API handler comment rather than silently returning zeros.
 */
import { costLedger, reviewEvalEvent } from '@review-agent/core/db';
import { and, count, gte, sql } from 'drizzle-orm';
import type { DbClient } from './connection.js';
import { withTenant } from './tenancy.js';

export type OverviewTotals = {
  /** Count of review_eval_event rows created on or after `startOfMonth`. */
  readonly reviewsMonth: number;
  /** Sum of cost_ledger.cost_usd rows created on or after `startOfMonth`. */
  readonly costMtd: number;
};

/**
 * Aggregate `reviewsMonth` and `costMtd` across the given installation IDs.
 *
 * Each installation is queried inside its own `withTenant` transaction so RLS
 * policies on `review_eval_event` and `cost_ledger` are satisfied. The results
 * are summed client-side.
 *
 * When `installationIds` is empty, returns `{ reviewsMonth: 0, costMtd: 0 }`
 * immediately without touching the database.
 *
 * Note: data belonging to repos whose `installation_id` is NULL is not
 * included in the totals because per-installation RLS has no tenant to match
 * against for those rows.
 */
export async function loadOverviewTotals(
  db: DbClient,
  installationIds: ReadonlyArray<bigint>,
  startOfMonth: Date,
): Promise<OverviewTotals> {
  if (installationIds.length === 0) {
    return { reviewsMonth: 0, costMtd: 0 };
  }

  let totalReviewsMonth = 0;
  let totalCostMtd = 0;

  for (const installationId of installationIds) {
    const result = await withTenant(db, installationId, async (tx) => {
      const reviewRows = await tx
        .select({ value: count() })
        .from(reviewEvalEvent)
        .where(gte(reviewEvalEvent.createdAt, startOfMonth));

      const costRows = await tx
        .select({ total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
        .from(costLedger)
        .where(and(gte(costLedger.createdAt, startOfMonth)));

      return {
        reviewsMonth: Number(reviewRows[0]?.value ?? 0),
        costMtd: Number(costRows[0]?.total ?? 0),
      };
    });

    totalReviewsMonth += result.reviewsMonth;
    totalCostMtd += result.costMtd;
  }

  return { reviewsMonth: totalReviewsMonth, costMtd: totalCostMtd };
}
