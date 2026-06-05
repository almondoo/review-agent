import { describe, expect, it } from 'vitest';
import { createApi } from '../index.js';

const NOW = new Date('2026-05-01T00:00:00Z');

// Minimal DB mock that returns empty arrays for all queries
type DbChainResult = Promise<unknown[]> & {
  orderBy: (..._a: unknown[]) => DbChainResult;
  limit: (_n: number) => Promise<unknown[]>;
};

function makeChainable(rows: unknown[]): DbChainResult {
  const p: DbChainResult = Object.assign(Promise.resolve(rows), {
    orderBy: (..._a: unknown[]): DbChainResult => makeChainable(rows),
    limit: (_n: number): Promise<unknown[]> => Promise.resolve(rows),
  });
  return p;
}

function makeMinimalDb() {
  return {
    select: () => ({
      from: () => ({
        where: (): DbChainResult => makeChainable([]),
        orderBy: (): DbChainResult => makeChainable([]),
      }),
    }),
    selectDistinct: () => ({
      from: () => ({
        where: (): DbChainResult => makeChainable([]),
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  };
}

describe('createApi', () => {
  it('mounts /dashboard/overview route', async () => {
    const db = makeMinimalDb();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      now: () => NOW,
      generateId: () => 'test-id',
      awsRegion: 'us-east-1',
      dashboardToken: undefined,
      requireDashboardAuth: false,
    });
    const res = await api.request('http://host/dashboard/overview');
    expect(res.status).toBe(200);
  });

  it('mounts /repos route', async () => {
    const db = makeMinimalDb();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      now: () => NOW,
      generateId: () => 'test-id',
      awsRegion: 'us-east-1',
      dashboardToken: undefined,
      requireDashboardAuth: false,
    });
    const res = await api.request('http://host/repos');
    expect(res.status).toBe(200);
  });

  it('mounts /integrations route', async () => {
    const db = makeMinimalDb();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      now: () => NOW,
      dashboardToken: undefined,
      requireDashboardAuth: false,
    });
    const res = await api.request('http://host/integrations');
    expect(res.status).toBe(200);
  });

  it('mounts /reviews route', async () => {
    const db = makeMinimalDb();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      now: () => NOW,
      awsRegion: 'us-east-1',
      dashboardToken: undefined,
      requireDashboardAuth: false,
    });
    const res = await api.request('http://host/reviews');
    expect(res.status).toBe(200);
  });

  it('works without optional deps (no generateId, no awsRegion)', async () => {
    const db = makeMinimalDb();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      dashboardToken: undefined,
      requireDashboardAuth: false,
    });
    const res = await api.request('http://host/integrations');
    expect(res.status).toBe(200);
  });

  it('enforces bearer auth when token is configured', async () => {
    const db = makeMinimalDb();
    const api = createApi({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      env: {},
      dashboardToken: 'my-secret',
      requireDashboardAuth: false,
    });
    const unauthed = await api.request('http://host/integrations');
    expect(unauthed.status).toBe(401);

    const authed = await api.request('http://host/integrations', {
      headers: { Authorization: 'Bearer my-secret' },
    });
    expect(authed.status).toBe(200);
  });
});
