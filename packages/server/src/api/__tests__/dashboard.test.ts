import { describe, expect, it } from 'vitest';
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
});
