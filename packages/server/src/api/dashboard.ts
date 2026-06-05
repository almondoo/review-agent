import { costLedger, repos, reviewEvalEvent } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { loadQualityMetrics } from '@review-agent/db';
import { and, count, gte, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AuthEnv } from '../auth/types.js';
import { installationAuthz } from './middleware/installation-authz.js';
import type {
  DashboardOverview,
  QualityMetrics,
  RepoQualitySnapshot,
  SinceAlias,
} from './schemas.js';
import { metricsQuerySchema } from './schemas.js';

export type DashboardDeps = {
  readonly db: DbClient;
  readonly now?: () => Date;
  /**
   * Fail-closed multi-tenant guard. Forwarded to `installationAuthz` on
   * `GET /api/dashboard/metrics`. Defaults to false.
   */
  readonly multiTenant?: boolean;
};

export function createDashboardRouter(deps: DashboardDeps): Hono {
  const app = new Hono<AuthEnv>();
  const multiTenant = deps.multiTenant ?? false;

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

  // ---------------------------------------------------------------------------
  // GET /metrics?installationId=<n>&since=24h|7d|30d  (viewer+)
  //
  // `installationId` query param is required when a JWT principal is present.
  // Under legacy / shared-token auth (principal absent, multiTenant=false) the
  // installationAuthz middleware passes through and the installationId is still
  // required in the query string (returned as 400 when missing).
  //
  // `app.current_tenant` GUC is set inside `loadQualityMetrics` via `withTenant`
  // so RLS policies on `review_eval_event` and `review_history` are satisfied.
  // ---------------------------------------------------------------------------
  app.get(
    '/metrics',
    installationAuthz({
      required: 'viewer',
      getInstallationId: (c) => {
        const v = c.req.query('installationId');
        return v !== undefined && /^\d+$/.test(v) ? v : undefined;
      },
      multiTenant,
      db: deps.db,
    }),
    async (c) => {
      const now = (deps.now ?? (() => new Date()))();

      // `installationId` is required — installationAuthz guarantees it is a
      // valid numeric string on the JWT path; on the legacy path we validate it
      // here to return 400 instead of 503.
      const installationIdStr = c.req.query('installationId');
      if (installationIdStr === undefined || !/^\d+$/.test(installationIdStr)) {
        return c.json({ error: 'installationId required' }, 400);
      }
      const installationId = BigInt(installationIdStr);

      // Validate `since` query param.
      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const parsed = metricsQuerySchema.safeParse(rawQuery);
      if (!parsed.success) {
        return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
      }
      const since = parsed.data.since as SinceAlias;

      const result = await loadQualityMetrics(deps.db, {
        installationId,
        since,
        now,
      });

      const response: QualityMetrics = {
        period: since,
        overall: {
          reviewCount: result.overall.reviewCount,
          acceptanceRate: result.overall.acceptanceRate,
          falsePositiveRate: result.overall.falsePositiveRate,
          coverageRate: result.overall.coverageRate,
          latencyP50Ms: result.overall.latencyP50Ms,
          latencyP95Ms: result.overall.latencyP95Ms,
        },
        perRepo: result.perRepo.map((r): RepoQualitySnapshot & { repo: string } => ({
          repo: r.repo,
          reviewCount: r.reviewCount,
          acceptanceRate: r.acceptanceRate,
          falsePositiveRate: r.falsePositiveRate,
          coverageRate: r.coverageRate,
          latencyP50Ms: r.latencyP50Ms,
          latencyP95Ms: r.latencyP95Ms,
        })),
      };
      return c.json(response, 200);
    },
  );

  return app as unknown as Hono;
}
