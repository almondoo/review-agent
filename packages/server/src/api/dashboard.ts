import { repos } from '@review-agent/core/db';
import type { DbClient } from '@review-agent/db';
import { loadCostMetrics, loadOverviewTotals, loadQualityMetrics } from '@review-agent/db';
import { count, isNotNull, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import { getMembershipsByPrincipal } from '../auth/principal-store.js';
import type { AuthEnv } from '../auth/types.js';
import { installationAuthz } from './middleware/installation-authz.js';
import type {
  CostMetrics,
  DashboardOverview,
  QualityMetrics,
  RepoQualitySnapshot,
  SinceAlias,
} from './schemas.js';
import { costQuerySchema, metricsQuerySchema } from './schemas.js';

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
    const principal = c.get('principal');

    // Total active repos (not soft-deleted). `repos` has no RLS — readable
    // without `app.current_tenant`.
    const repoCountRows = await deps.db
      .select({ value: count() })
      .from(repos)
      .where(isNull(repos.deletedAt));
    const totalRepos = Number(repoCountRows[0]?.value ?? 0);

    // ---------------------------------------------------------------------------
    // Determine the set of installation IDs to aggregate over.
    //
    // `review_eval_event` and `cost_ledger` are RLS-scoped by `installation_id`.
    // Without `app.current_tenant` set these tables return zero rows for the
    // `review_agent_app` role (fail-closed). We must iterate over the caller's
    // installations and sum inside `withTenant` (via `loadOverviewTotals`).
    //
    // Session mode (principal present):
    //   Use the caller's `installation_memberships` to bound the scope.
    //
    // Legacy / shared-token mode (no principal):
    //   Use distinct non-null `installation_id` values from the `repos` table
    //   (non-RLS) as a proxy for all known installations. `github_installations`
    //   is RLS-enabled and cannot be queried without a GUC — avoid it here.
    //
    // Repos with installation_id IS NULL (manually-registered) are excluded from
    // the review/cost totals: per-installation RLS has no tenant to match for
    // those rows. This is documented as an inherent per-installation RLS
    // limitation and is consistent with the behaviour of GET /metrics and
    // GET /cost which both require an explicit installationId.
    // ---------------------------------------------------------------------------
    let installationIds: bigint[];

    if (principal !== undefined) {
      const memberships = await getMembershipsByPrincipal(deps.db, principal.id);
      installationIds = memberships.map((m) => BigInt(m.installationId));
    } else {
      // Legacy mode: derive installation IDs from the repos table (non-RLS).
      const instRows = await deps.db
        .selectDistinct({ installationId: repos.installationId })
        .from(repos)
        .where(isNotNull(repos.installationId));
      installationIds = instRows
        .map((r) => r.installationId)
        .filter((id): id is bigint => id !== null);
    }

    // Aggregate reviewsMonth and costMtd across all relevant installations.
    // Each installation is queried inside withTenant so RLS is satisfied.
    const totals = await loadOverviewTotals(deps.db, installationIds, startOfMonth);

    const overview: DashboardOverview = {
      totalRepos,
      reviewsMonth: totals.reviewsMonth,
      // Queue depth is not tracked in the DB at this layer; expose 0 as a
      // safe default. Operators wiring SQS can extend this endpoint.
      queueDepth: 0,
      costMtd: totals.costMtd,
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

  // ---------------------------------------------------------------------------
  // GET /cost?installationId=<n>&since=24h|7d|30d&limit=<n>&cursor=<s>  (viewer+)
  //
  // Returns cost analytics for the given installation over the requested period:
  //   - overall: total cost, token breakdown, call count, budget alert threshold.
  //   - perModel: cost by provider+model.
  //   - perRepo: cost by repo (JOIN with review_eval_event on job_id), paginated.
  //   - perPeriod: time-series buckets (hourly for 24h, daily for 7d/30d).
  //
  // `app.current_tenant` GUC is set inside `loadCostMetrics` via `withTenant`
  // so RLS policies on `cost_ledger` and `review_eval_event` are satisfied.
  //
  // NOTE: budget_alert_usd notification delivery is NOT implemented here.
  // The overall.budgetAlertUsd field exposes the threshold when exceeded so
  // the dashboard can highlight overspend. Actual notification channels
  // (Slack / email) are deferred to issue #144.
  // ---------------------------------------------------------------------------
  app.get(
    '/cost',
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

      const installationIdStr = c.req.query('installationId');
      if (installationIdStr === undefined || !/^\d+$/.test(installationIdStr)) {
        return c.json({ error: 'installationId required' }, 400);
      }
      const installationId = BigInt(installationIdStr);

      const rawQuery = Object.fromEntries(new URL(c.req.url).searchParams.entries());
      const parsed = costQuerySchema.safeParse(rawQuery);
      if (!parsed.success) {
        return c.json({ error: 'validation_error', issues: parsed.error.issues }, 422);
      }
      const { since, limit, cursor } = parsed.data;
      const sinceAlias = since as SinceAlias;

      const result = await loadCostMetrics(deps.db, {
        installationId,
        since: sinceAlias,
        limit,
        now,
        ...(cursor !== undefined ? { cursor } : {}),
      });

      const response: CostMetrics = {
        period: sinceAlias,
        overall: {
          totalCostUsd: result.overall.totalCostUsd,
          totalInputTokens: result.overall.totalInputTokens,
          totalOutputTokens: result.overall.totalOutputTokens,
          totalCacheReadTokens: result.overall.totalCacheReadTokens,
          totalCacheCreationTokens: result.overall.totalCacheCreationTokens,
          callCount: result.overall.callCount,
          budgetAlertUsd: result.overall.budgetAlertUsd,
        },
        perModel: result.perModel.map((m) => ({
          provider: m.provider,
          model: m.model,
          costUsd: m.costUsd,
          callCount: m.callCount,
        })),
        perRepo: result.perRepo.map((r) => ({
          repo: r.repo,
          costUsd: r.costUsd,
        })),
        nextCursor: result.nextCursor,
        perPeriod: result.perPeriod.map((p) => ({
          bucket: p.bucket,
          costUsd: p.costUsd,
        })),
      };
      return c.json(response, 200);
    },
  );

  return app as unknown as Hono;
}
