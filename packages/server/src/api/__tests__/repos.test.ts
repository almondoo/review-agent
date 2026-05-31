import { describe, expect, it } from 'vitest';
import { createReposRouter } from '../repos.js';

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

type RepoRecord = {
  id: string;
  platform: 'github' | 'codecommit';
  name: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/**
 * Build a flexible Drizzle-shaped mock that handles the chaining patterns
 * used in repos.ts:
 *   - .select().from().where().orderBy()          → Promise<rows>
 *   - .select().from().where().orderBy().limit()  → Promise<rows>
 *   - .select().from().where().limit()            → Promise<rows>
 *   - .insert().values()                          → Promise<void>
 *   - .update().set().where()                     → Promise<void>
 */
function makeDb(initialRepos: RepoRecord[] = []) {
  const store: RepoRecord[] = [...initialRepos];

  // A "thenable" builder: awaitable AND further chainable
  type ChainResult = Promise<unknown[]> & {
    orderBy: (..._a: unknown[]) => ChainResult;
    limit: (_n: number) => Promise<unknown[]>;
  };

  function chainable(rows: unknown[]): ChainResult {
    const p: ChainResult = Object.assign(Promise.resolve(rows), {
      orderBy: (..._a: unknown[]): ChainResult => chainable(rows),
      limit: (_n: number): Promise<unknown[]> => Promise.resolve(rows),
    });
    return p;
  }

  return {
    _store: store,
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond?: unknown) => {
          const activeRepos = store.filter((r) => r.deletedAt === null);
          return chainable(activeRepos);
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (row: RepoRecord) => {
        store.push(row);
        return Promise.resolve();
      },
    }),
    update: (_table: unknown) => ({
      set: (patch: Partial<RepoRecord>) => ({
        where: (_cond: unknown) => {
          for (const r of store) {
            Object.assign(r, patch);
          }
          return Promise.resolve();
        },
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Integration-style tests via Hono request dispatch
// ---------------------------------------------------------------------------

describe('repos router', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  let idSeq = 0;

  function makeRouter(initialRepos: RepoRecord[] = []) {
    idSeq = 0;
    return createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeDb(initialRepos) as any,
      now: () => NOW,
      generateId: () => `id-${++idSeq}`,
    });
  }

  // GET /
  describe('GET /', () => {
    it('returns empty array when no repos exist', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    it('returns repo summaries', async () => {
      const repo: RepoRecord = {
        id: 'r1',
        platform: 'github',
        name: 'owner/repo',
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      };
      const app = makeRouter([repo]);
      const res = await app.request('http://host/');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    });

    it('uses at most 2 DB queries for 3 repos (no N+1)', async () => {
      const repos3: RepoRecord[] = [1, 2, 3].map((i) => ({
        id: `r${i}`,
        platform: 'github' as const,
        name: `org/repo${i}`,
        enabled: true,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      }));
      let selectCallCount = 0;
      const db = {
        _store: repos3,
        select: (_fields?: unknown) => {
          selectCallCount++;
          return {
            from: (_table: unknown) => ({
              where: (_cond?: unknown) => ({
                orderBy: (..._a: unknown[]) =>
                  Promise.resolve(repos3.filter((r) => r.deletedAt === null)),
                limit: (_n: number) =>
                  Promise.resolve(repos3.filter((r) => r.deletedAt === null).slice(0, _n)),
              }),
              orderBy: (..._a: unknown[]) =>
                Promise.resolve(repos3.filter((r) => r.deletedAt === null)),
            }),
          };
        },
        insert: (_table: unknown) => ({ values: (_row: unknown) => Promise.resolve() }),
        update: (_table: unknown) => ({
          set: (_patch: unknown) => ({ where: (_cond: unknown) => Promise.resolve() }),
        }),
      };
      const app = createReposRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        generateId: () => 'new-id',
      });
      const res = await app.request('http://host/');
      expect(res.status).toBe(200);
      // Must use exactly 2 select calls: 1 for repos, 1 for all events
      expect(selectCallCount).toBeLessThanOrEqual(2);
    });
  });

  // POST /
  describe('POST /', () => {
    it('creates a repo and returns 201', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'github', name: 'org/repo' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toMatchObject({
        platform: 'github',
        name: 'org/repo',
        enabled: true,
        lastReviewAt: null,
        lastOutcome: null,
      });
      expect(typeof body.id).toBe('string');
    });

    it('returns 422 when platform is invalid', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'gitlab', name: 'org/repo' }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body).toMatchObject({ error: 'validation_error' });
    });

    it('returns 422 when name is empty string', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'github', name: '' }),
      });
      expect(res.status).toBe(422);
    });

    it('returns 422 when name exceeds 200 chars', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'github', name: 'a'.repeat(201) }),
      });
      expect(res.status).toBe(422);
    });

    it('returns 400 on malformed JSON', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });
      expect(res.status).toBe(400);
    });

    it('accepts codecommit platform', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'codecommit', name: 'my-repo' }),
      });
      expect(res.status).toBe(201);
      expect((await res.json()).platform).toBe('codecommit');
    });
  });

  // PATCH /:id
  describe('PATCH /:id', () => {
    const existing: RepoRecord = {
      id: 'existing-1',
      platform: 'github',
      name: 'org/repo',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };

    it('returns 404 when repo not found', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/nonexistent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 400 on malformed JSON', async () => {
      const app = makeRouter([existing]);
      const res = await app.request('http://host/existing-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: 'bad',
      });
      expect(res.status).toBe(400);
    });

    it('returns 422 when enabled is not boolean', async () => {
      const app = makeRouter([existing]);
      const res = await app.request('http://host/existing-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      });
      expect(res.status).toBe(422);
    });

    it('accepts empty patch body (no-op)', async () => {
      const app = makeRouter([existing]);
      const res = await app.request('http://host/existing-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
    });
  });

  // DELETE /:id
  describe('DELETE /:id', () => {
    const existing: RepoRecord = {
      id: 'to-delete',
      platform: 'github',
      name: 'org/repo',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };

    it('returns 204 on successful soft delete', async () => {
      const app = makeRouter([existing]);
      const res = await app.request('http://host/to-delete', {
        method: 'DELETE',
      });
      expect(res.status).toBe(204);
    });

    it('returns 404 when repo not found', async () => {
      const app = makeRouter();
      const res = await app.request('http://host/nonexistent', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 when repo is already soft-deleted', async () => {
      const deleted: RepoRecord = { ...existing, deletedAt: NOW };
      const app = makeRouter([deleted]);
      const res = await app.request('http://host/to-delete', {
        method: 'DELETE',
      });
      expect(res.status).toBe(404);
    });
  });
});
