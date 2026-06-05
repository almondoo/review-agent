import { describe, expect, it, vi } from 'vitest';
import { createDashboardRouter } from '../dashboard.js';

const NOW = new Date('2026-05-15T12:00:00Z');

describe('dashboard router', () => {
  describe('GET /overview', () => {
    it('returns overview shape with zeros on empty DB', async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ value: 0, total: 0 }]),
          }),
        }),
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

    it('returns numeric values from DB', async () => {
      // Mock that returns different values per call (repos=5, reviews=42, cost=12.34)
      const calls: number[] = [];
      const results = [
        [{ value: 5, total: 0 }], // repos count
        [{ value: 42, total: 0 }], // reviews count
        [{ value: 0, total: 12.34 }], // cost
      ];
      const db = {
        select: () => ({
          from: () => ({
            where: () => {
              const idx = calls.length;
              calls.push(idx);
              return Promise.resolve(results[idx] ?? [{ value: 0, total: 0 }]);
            },
          }),
        }),
      };
      const app = createDashboardRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/overview');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(typeof body.totalRepos).toBe('number');
      expect(typeof body.reviewsMonth).toBe('number');
      expect(body.queueDepth).toBe(0);
      expect(typeof body.costMtd).toBe('number');
    });

    it('handles missing DB rows gracefully (undefined first element)', async () => {
      const db = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([]),
          }),
        }),
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
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ value: 1, total: 0.5 }]),
          }),
        }),
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
