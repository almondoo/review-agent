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
});
