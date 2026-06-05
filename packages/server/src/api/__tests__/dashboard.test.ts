import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthEnv } from '../auth/types.js';
import { createDashboardRouter } from '../dashboard.js';

const NOW = new Date('2026-05-15T12:00:00Z');

describe('dashboard router', () => {
  describe('GET /overview', () => {
    // The overview handler (legacy mode, no principal):
    //   db.select(...repos count...)            -> totalRepos
    //   db.selectDistinct(...repos installs...)  -> installationIds
    //   loadOverviewTotals -> db.transaction per installation (withTenant):
    //     tx.execute(set_config); tx.select(reviews count); tx.select(cost sum)
    it('returns overview shape with zeros on empty DB', async () => {
      const db = {
        select: () => ({ from: () => ({ where: () => Promise.resolve([{ value: 0 }]) }) }),
        selectDistinct: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/overview');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        totalRepos: 0,
        reviewsMonth: 0,
        queueDepth: 0,
        costMtd: 0,
      });
    });

    it('aggregates reviewsMonth and costMtd across installations (legacy mode)', async () => {
      // repos=5; one installation with reviews=42, cost=12.34 summed via withTenant.
      const db = {
        select: () => ({ from: () => ({ where: () => Promise.resolve([{ value: 5 }]) }) }),
        selectDistinct: () => ({
          from: () => ({ where: () => Promise.resolve([{ installationId: 1n }]) }),
        }),
        transaction: (fn: (tx: unknown) => Promise<unknown>) => {
          let i = 0;
          const tx = {
            execute: vi.fn().mockResolvedValue([]),
            select: () => ({
              from: () => ({
                where: () => Promise.resolve(i++ === 0 ? [{ value: 42 }] : [{ total: 12.34 }]),
              }),
            }),
          };
          return fn(tx);
        },
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/overview');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalRepos).toBe(5);
      expect(body.reviewsMonth).toBe(42);
      expect(body.costMtd).toBeCloseTo(12.34);
      expect(body.queueDepth).toBe(0);
    });

    it('scopes to caller memberships in session mode', async () => {
      // principal present -> getMembershipsByPrincipal(db, id) then per-installation totals.
      const db = {
        // Both the repo-count query and getMembershipsByPrincipal use
        // select().from().where(); here both resolve to the membership row set.
        // The repo-count path reads `.value` (undefined here -> 0), which is fine
        // since this test asserts only reviewsMonth / costMtd.
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ installationId: '7', role: 'admin' }]),
          }),
        }),
        selectDistinct: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        transaction: (fn: (tx: unknown) => Promise<unknown>) => {
          let i = 0;
          const tx = {
            execute: vi.fn().mockResolvedValue([]),
            select: () => ({
              from: () => ({
                where: () => Promise.resolve(i++ === 0 ? [{ value: 3 }] : [{ total: 1.5 }]),
              }),
            }),
          };
          return fn(tx);
        },
      };
      const app = new Hono<AuthEnv>();
      app.use('*', async (c, next) => {
        c.set('principal', { id: 'p1', username: 'alice' });
        await next();
      });
      app.route(
        '/',
        createDashboardRouter({
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          db: db as any,
          now: () => NOW,
        }),
      );
      const res = await app.request('http://host/overview');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reviewsMonth).toBe(3);
      expect(body.costMtd).toBeCloseTo(1.5);
    });

    it('handles missing DB rows gracefully (undefined first element)', async () => {
      const db = {
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        selectDistinct: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/overview');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.totalRepos).toBe(0);
      expect(body.costMtd).toBe(0);
    });

    it('uses current date when deps.now is not provided', async () => {
      const db = {
        select: () => ({ from: () => ({ where: () => Promise.resolve([{ value: 1 }]) }) }),
        selectDistinct: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };
      // No now() injection — exercises the fallback branch
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
      });
      const res = await app.request('http://host/overview');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.totalRepos).toBe('number');
    });
  });

  // ---------------------------------------------------------------------------
  // GET /metrics
  // ---------------------------------------------------------------------------
  describe('GET /metrics', () => {
    it('returns 400 when installationId is missing', async () => {
      const db = {
        transaction: vi.fn().mockResolvedValue({ overall: { reviewCount: 0 }, perRepo: [] }),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/metrics');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'installationId required' });
    });

    it('returns 400 when installationId is not a number', async () => {
      const db = {
        transaction: vi.fn().mockResolvedValue({ overall: { reviewCount: 0 }, perRepo: [] }),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/metrics?installationId=abc');
      expect(res.status).toBe(400);
    });

    it('returns 200 with QualityMetrics shape for valid installationId', async () => {
      // Build a db that returns a sensible metrics result from loadQualityMetrics
      const db = {
        transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
          const results = [
            // evalRows per-repo
            [
              {
                repo: 'owner/repo',
                reviewCount: 5,
                totalCommentCount: '10',
                filesTotal: '20',
                filesReviewed: '15',
                p50: '1500',
                p95: '4800',
              },
            ],
            [], // acceptedRows
            [], // rejectedRows
            [], // suppressionRows
            // overallRow
            [
              {
                p50: '1500',
                p95: '4800',
                filesTotal: '20',
                filesReviewed: '15',
                totalCommentCount: '10',
              },
            ],
          ];
          let idx = 0;
          const tx = {
            execute: vi.fn().mockResolvedValue([]),
            select: vi.fn(() => ({
              from: () => ({
                where: () => ({
                  groupBy: () => Promise.resolve(results[idx++] ?? []),
                }),
              }),
            })),
          };
          return fn(tx);
        }),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };

      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/metrics?installationId=42');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('period');
      expect(body).toHaveProperty('overall');
      expect(body).toHaveProperty('perRepo');
      expect(['24h', '7d', '30d']).toContain(body.period);
      expect(typeof body.overall.reviewCount).toBe('number');
    });

    it('defaults since to 30d when not provided', async () => {
      const db = {
        transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
          const tx = {
            execute: vi.fn().mockResolvedValue([]),
            select: vi.fn(() => ({
              from: () => ({
                where: () => ({
                  groupBy: () => Promise.resolve([]),
                }),
              }),
            })),
          };
          return fn(tx);
        }),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/metrics?installationId=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period).toBe('30d');
    });

    it('accepts all valid since aliases', async () => {
      for (const since of ['24h', '7d', '30d'] as const) {
        const db = {
          transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => {
            const tx = {
              execute: vi.fn().mockResolvedValue([]),
              select: vi.fn(() => ({
                from: () => ({
                  where: () => ({
                    groupBy: () => Promise.resolve([]),
                  }),
                }),
              })),
            };
            return fn(tx);
          }),
          select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
        };
        const app = createDashboardRouter({
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          db: db as any,
          now: () => NOW,
        });
        const res = await app.request(`http://host/metrics?installationId=1&since=${since}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.period).toBe(since);
      }
    });

    it('returns 422 for invalid since value', async () => {
      const db = {
        transaction: vi.fn().mockResolvedValue({}),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/metrics?installationId=1&since=1year');
      expect(res.status).toBe(422);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /cost
  // ---------------------------------------------------------------------------
  describe('GET /cost', () => {
    /**
     * Build a minimal db mock for loadCostMetrics.
     *
     * loadCostMetrics calls inside withTenant (db.transaction):
     *   tx.execute(set_config)   -- GUC
     *   tx.select().from().where()                         -- overallRow
     *   tx.select().from().where().groupBy().orderBy()     -- perModelRows
     *   tx.select().from().innerJoin().where().groupBy().orderBy() -- perRepoAllRows
     *   tx.select().from().where().groupBy().orderBy()     -- perPeriodRows
     */
    function makeMinimalCostDb(
      overrides: {
        overallRow?: unknown[];
        perModelRows?: unknown[];
        perRepoRows?: unknown[];
        perPeriodRows?: unknown[];
      } = {},
    ) {
      const sequences = [
        overrides.overallRow ?? [
          {
            totalCostUsd: '5.0',
            totalInputTokens: '100000',
            totalOutputTokens: '10000',
            totalCacheReadTokens: '5000',
            totalCacheCreationTokens: '3000',
            callCount: 20,
          },
        ],
        overrides.perModelRows ?? [
          { provider: 'anthropic', model: 'claude-sonnet-4-5', costUsd: '5.0', callCount: 20 },
        ],
        overrides.perRepoRows ?? [{ repo: 'owner/repo', costUsd: '5.0' }],
        overrides.perPeriodRows ?? [{ bucket: '2026-05-15T00:00:00.000Z', costUsd: '5.0' }],
      ];
      let selectIdx = 0;
      const execSpy = vi.fn().mockResolvedValue([]);

      function makeChain(result: unknown[]) {
        const resolved = Promise.resolve(result);
        return Object.assign(resolved, {
          groupBy: () =>
            Object.assign(Promise.resolve(result), {
              orderBy: () => Promise.resolve(result),
            }),
          orderBy: () => Promise.resolve(result),
        });
      }

      const tx = {
        execute: execSpy,
        select: () => {
          const currentIdx = selectIdx++;
          const result = sequences[currentIdx] ?? [];
          return {
            from: () => ({
              where: () => makeChain(result),
              innerJoin: () => ({
                where: () => makeChain(result),
              }),
            }),
          };
        },
      };

      const db = {
        transaction: vi.fn((fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
        select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
      };

      return { db, execSpy };
    }

    it('returns 400 when installationId is missing', async () => {
      const { db } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/cost');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'installationId required' });
    });

    it('returns 400 when installationId is not numeric', async () => {
      const { db } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/cost?installationId=notanumber');
      expect(res.status).toBe(400);
    });

    it('returns 200 with CostMetrics shape for valid installationId', async () => {
      const { db } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/cost?installationId=42');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('period');
      expect(body).toHaveProperty('overall');
      expect(body).toHaveProperty('perModel');
      expect(body).toHaveProperty('perRepo');
      expect(body).toHaveProperty('nextCursor');
      expect(body).toHaveProperty('perPeriod');
      expect(['24h', '7d', '30d']).toContain(body.period);
      expect(typeof body.overall.totalCostUsd).toBe('number');
      expect(Array.isArray(body.perModel)).toBe(true);
      expect(Array.isArray(body.perRepo)).toBe(true);
      expect(Array.isArray(body.perPeriod)).toBe(true);
    });

    it('defaults since to 30d when not provided', async () => {
      const { db } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/cost?installationId=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.period).toBe('30d');
    });

    it('accepts all valid since aliases', async () => {
      for (const since of ['24h', '7d', '30d'] as const) {
        const { db } = makeMinimalCostDb();
        const app = createDashboardRouter({
          // biome-ignore lint/suspicious/noExplicitAny: test mock
          db: db as any,
          now: () => NOW,
        });
        const res = await app.request(`http://host/cost?installationId=1&since=${since}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.period).toBe(since);
      }
    });

    it('returns 422 for invalid since value', async () => {
      const { db } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/cost?installationId=1&since=badvalue');
      expect(res.status).toBe(422);
    });

    it('returns overall.budgetAlertUsd=null when not exceeded', async () => {
      const { db } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/cost?installationId=1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.overall.budgetAlertUsd).toBeNull();
    });

    it('propagates pagination cursor in query', async () => {
      const { db } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/cost?installationId=1&cursor=owner%2Frepo-19');
      // With only 1 repo in the mock and cursor pointing past it, perRepo will be empty.
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.nextCursor).toBeNull();
    });

    it('sets app.current_tenant GUC via withTenant', async () => {
      const { db, execSpy } = makeMinimalCostDb();
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      await app.request('http://host/cost?installationId=99');
      expect(execSpy).toHaveBeenCalled();
      const firstCall = execSpy.mock.calls[0]?.[0];
      expect(typeof firstCall).toBe('object');
      expect(firstCall).not.toBeNull();
    });
  });
});
