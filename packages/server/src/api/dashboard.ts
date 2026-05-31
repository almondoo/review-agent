import { costLedger, repos, reviewEvalEvent } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { and, count, gte, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { DashboardOverview } from './schemas.js';

export type DashboardDeps = {
  readonly db: DbClient;
  readonly now?: () => Date;
};

export function createDashboardRouter(deps: DashboardDeps): Hono {
  const app = new Hono();

  app.get('/overview', async (c) => {
    const now = (deps.now ?? (() => new Date()))();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // Total active repos (not soft-deleted)
    const repoCountRows = await deps.db
      .select({ value: count() })
      .from(repos)
      .where(isNull(repos.deletedAt));
    const totalRepos = Number(repoCountRows[0]?.value ?? 0);

    // Reviews this calendar month
    const reviewCountRows = await deps.db
      .select({ value: count() })
      .from(reviewEvalEvent)
      .where(gte(reviewEvalEvent.createdAt, startOfMonth));
    const reviewsMonth = Number(reviewCountRows[0]?.value ?? 0);

    // Cost month-to-date (sum over cost_ledger since start of month)
    const costRows = await deps.db
      .select({ total: sql<number>`coalesce(sum(${costLedger.costUsd}), 0)` })
      .from(costLedger)
      .where(and(gte(costLedger.createdAt, startOfMonth)));
    const costMtd = Number(costRows[0]?.total ?? 0);

    const overview: DashboardOverview = {
      totalRepos,
      reviewsMonth,
      // Queue depth is not tracked in the DB at this layer; expose 0 as a
      // safe default. Operators wiring SQS can extend this endpoint.
      queueDepth: 0,
      costMtd,
    };
    return c.json(overview, 200);
  });

  return app;
}
