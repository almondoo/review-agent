import type { AuditAppender } from '@review-agent/db';
import { describe, expect, it, vi } from 'vitest';
import { createReposRouter } from '../repos.js';

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

type RepoRecord = {
  id: string;
  platform: 'github' | 'codecommit';
  name: string;
  enabled: boolean;
  installationId?: bigint | null;
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
    // withTenant calls db.transaction(); return empty event arrays so existing
    // tests that don't exercise review-event enrichment still pass.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      type ChainResult = Promise<unknown[]> & {
        orderBy: (..._a: unknown[]) => ChainResult;
        limit: (n: number) => Promise<unknown[]>;
      };
      function chainable(rows: unknown[]): ChainResult {
        const p: ChainResult = Object.assign(Promise.resolve(rows), {
          orderBy: (..._a: unknown[]): ChainResult => chainable(rows),
          limit: (n: number): Promise<unknown[]> => Promise.resolve(rows.slice(0, n)),
        });
        return p;
      }
      const tx = {
        execute: () => Promise.resolve([]),
        select: (_fields?: unknown) => ({
          from: (_table: unknown) => ({
            where: (_cond?: unknown): ChainResult => chainable([]),
          }),
        }),
      };
      return fn(tx);
    },
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

// ---------------------------------------------------------------------------
// Audit write tests
// ---------------------------------------------------------------------------

type AuditRecord = Parameters<AuditAppender>[0];

function fakeAuditAppender(): { appender: AuditAppender; records: AuditRecord[] } {
  const records: AuditRecord[] = [];
  const appender: AuditAppender = vi.fn(async (ev) => {
    records.push(ev);
    return { ...ev, ts: new Date(), prevHash: '0'.repeat(64), hash: '0'.repeat(64) };
  });
  return { appender, records };
}

describe('repos router audit writes', () => {
  const NOW = new Date('2026-01-01T00:00:00Z');
  let idSeq = 0;

  function makeRouterWithAudit(initialRepos: RepoRecord[], auditAppender: AuditAppender) {
    idSeq = 0;
    return createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeDb(initialRepos) as any,
      now: () => NOW,
      generateId: () => `id-${++idSeq}`,
      auditAppender,
    });
  }

  it('POST / writes repo.create audit event with resourceType=repo', async () => {
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([], appender);
    const res = await app.request('http://host/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'github', name: 'org/repo-audit' }),
    });
    expect(res.status).toBe(201);
    expect(records).toHaveLength(1);
    expect(records[0]?.event).toBe('repo.create');
    expect(records[0]?.resourceType).toBe('repo');
    expect(records[0]?.resourceId).toBeTruthy();
    // No secrets in audit record
    expect(JSON.stringify(records[0])).not.toContain('password');
  });

  it('PATCH /:id writes repo.enable audit event', async () => {
    const existing: RepoRecord = {
      id: 'r-en',
      platform: 'github',
      name: 'org/repo',
      enabled: false,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([existing], appender);
    const res = await app.request('http://host/r-en', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    expect(records.some((r) => r.event === 'repo.enable')).toBe(true);
    const ev = records.find((r) => r.event === 'repo.enable');
    expect(ev?.resourceType).toBe('repo');
    expect(ev?.resourceId).toBe('r-en');
  });

  it('PATCH /:id writes repo.disable audit event', async () => {
    const existing: RepoRecord = {
      id: 'r-dis',
      platform: 'github',
      name: 'org/repo2',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([existing], appender);
    const res = await app.request('http://host/r-dis', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(records.some((r) => r.event === 'repo.disable')).toBe(true);
  });

  it('DELETE /:id writes repo.delete audit event', async () => {
    const existing: RepoRecord = {
      id: 'r-del',
      platform: 'github',
      name: 'org/repo3',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([existing], appender);
    const res = await app.request('http://host/r-del', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(records.some((r) => r.event === 'repo.delete')).toBe(true);
    const ev = records.find((r) => r.event === 'repo.delete');
    expect(ev?.resourceId).toBe('r-del');
  });

  it('PUT /:id/prompt writes prompt.update audit event', async () => {
    const existing: RepoRecord = {
      id: 'r-prompt',
      platform: 'github',
      name: 'org/repo4',
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([existing], appender);
    const res = await app.request('http://host/r-prompt/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'Review carefully.' }),
    });
    expect(res.status).toBe(200);
    expect(records.some((r) => r.event === 'prompt.update')).toBe(true);
    const ev = records.find((r) => r.event === 'prompt.update');
    expect(ev?.resourceType).toBe('repo');
    expect(ev?.resourceId).toBe('r-prompt');
    // No secrets
    expect(JSON.stringify(ev)).not.toContain('password');
  });

  it('PATCH /:id includes installationId in audit when repo has one', async () => {
    const existing: RepoRecord = {
      id: 'r-inst',
      platform: 'github',
      name: 'org/repo-inst',
      enabled: false,
      installationId: 77n,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([existing], appender);
    const res = await app.request('http://host/r-inst', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    expect(res.status).toBe(200);
    const ev = records.find((r) => r.event === 'repo.enable');
    expect(ev?.installationId).toBe(77n);
  });

  it('DELETE /:id includes installationId in audit when repo has one', async () => {
    const existing: RepoRecord = {
      id: 'r-del-inst',
      platform: 'github',
      name: 'org/repo-del-inst',
      enabled: true,
      installationId: 88n,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([existing], appender);
    const res = await app.request('http://host/r-del-inst', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    const ev = records.find((r) => r.event === 'repo.delete');
    expect(ev?.installationId).toBe(88n);
  });

  it('audit write failure is best-effort (does not fail the HTTP response)', async () => {
    const failingAppender: AuditAppender = vi.fn().mockRejectedValue(new Error('audit DB down'));
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: makeDb([]) as any,
      now: () => NOW,
      generateId: () => 'id-safe',
      auditAppender: failingAppender,
    });
    const res = await app.request('http://host/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'github', name: 'org/resilient' }),
    });
    // HTTP response must still succeed even though audit write threw
    expect(res.status).toBe(201);
  });

  it('PUT /:id/prompt includes installationId in audit when repo has one', async () => {
    // Exercises the `installationId != null ? { installationId } : {}` true branch
    // inside the PUT /:id/prompt audit write (line 597 in repos.ts).
    const existing: RepoRecord = {
      id: 'r-prompt-inst',
      platform: 'github',
      name: 'org/repo-prompt-inst',
      enabled: true,
      installationId: 99n,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    const { appender, records } = fakeAuditAppender();
    const app = makeRouterWithAudit([existing], appender);
    const res = await app.request('http://host/r-prompt-inst/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'With installationId.' }),
    });
    expect(res.status).toBe(200);
    const ev = records.find((r) => r.event === 'prompt.update');
    expect(ev).toBeDefined();
    expect(ev?.installationId).toBe(99n);
  });
});

// ---------------------------------------------------------------------------
// withTenant path coverage — proves withTenant is invoked for each of the
// 4 reviewEvalEvent handlers when the repo has a non-null installationId.
// ---------------------------------------------------------------------------

describe('repos router — withTenant path coverage', () => {
  const NOW_WT = new Date('2026-01-01T00:00:00Z');

  // Helper: build a db mock where `transaction` is a spy so we can assert it
  // was called. The spy resolves by invoking the callback with a minimal tx.
  function makeDbWithTransactionSpy(initialRepos: RepoRecord[]) {
    const store = [...initialRepos];

    type ChainResult = Promise<unknown[]> & {
      orderBy: (..._a: unknown[]) => ChainResult;
      limit: (n: number) => Promise<unknown[]>;
    };
    function chainable(rows: unknown[]): ChainResult {
      const p: ChainResult = Object.assign(Promise.resolve(rows), {
        orderBy: (..._a: unknown[]): ChainResult => chainable(rows),
        limit: (n: number): Promise<unknown[]> => Promise.resolve(rows.slice(0, n)),
      });
      return p;
    }

    const transactionSpy = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: () => Promise.resolve([]),
        select: (_fields?: unknown) => ({
          from: (_table: unknown) => ({
            where: (_cond?: unknown): ChainResult => chainable([]),
          }),
        }),
      };
      return fn(tx);
    });

    const db = {
      _store: store,
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => {
            const active = store.filter((r) => r.deletedAt === null);
            return chainable(active);
          },
          orderBy: (..._a: unknown[]) => Promise.resolve(store.filter((r) => r.deletedAt === null)),
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
      transaction: transactionSpy,
    };

    return { db, transactionSpy };
  }

  it('GET / calls withTenant once per distinct installationId in filteredRepos', async () => {
    const repoWithInst: RepoRecord = {
      id: 'ri',
      platform: 'github',
      name: 'org/repo-inst',
      enabled: true,
      installationId: 10n,
      createdAt: NOW_WT,
      updatedAt: NOW_WT,
      deletedAt: null,
    };
    const repoNullInst: RepoRecord = {
      id: 'rn',
      platform: 'github',
      name: 'org/repo-null',
      enabled: true,
      createdAt: NOW_WT,
      updatedAt: NOW_WT,
      deletedAt: null,
    };
    const { db, transactionSpy } = makeDbWithTransactionSpy([repoWithInst, repoNullInst]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW_WT,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/');
    expect(res.status).toBe(200);
    // One withTenant call for installationId=10n; null-inst repo skipped
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('GET /:id calls withTenant when repo has installationId', async () => {
    const repo: RepoRecord = {
      id: 'r-wt',
      platform: 'github',
      name: 'org/repo',
      enabled: true,
      installationId: 20n,
      createdAt: NOW_WT,
      updatedAt: NOW_WT,
      deletedAt: null,
    };
    const { db, transactionSpy } = makeDbWithTransactionSpy([repo]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW_WT,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r-wt');
    expect(res.status).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('PATCH /:id calls withTenant when repo has installationId', async () => {
    const repo: RepoRecord = {
      id: 'r-patch-wt',
      platform: 'github',
      name: 'org/repo',
      enabled: true,
      installationId: 30n,
      createdAt: NOW_WT,
      updatedAt: NOW_WT,
      deletedAt: null,
    };
    const { db, transactionSpy } = makeDbWithTransactionSpy([repo]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW_WT,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r-patch-wt', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('GET /:id/reviews calls withTenant when repo has installationId', async () => {
    const repo: RepoRecord = {
      id: 'r-reviews-wt',
      platform: 'github',
      name: 'org/repo',
      enabled: true,
      installationId: 40n,
      createdAt: NOW_WT,
      updatedAt: NOW_WT,
      deletedAt: null,
    };
    const { db, transactionSpy } = makeDbWithTransactionSpy([repo]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW_WT,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r-reviews-wt/reviews');
    expect(res.status).toBe(200);
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('GET /:id/reviews skips withTenant for null-installationId repo', async () => {
    const repo: RepoRecord = {
      id: 'r-reviews-null',
      platform: 'github',
      name: 'org/repo',
      enabled: true,
      createdAt: NOW_WT,
      updatedAt: NOW_WT,
      deletedAt: null,
    };
    const { db, transactionSpy } = makeDbWithTransactionSpy([repo]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW_WT,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r-reviews-null/reviews');
    expect(res.status).toBe(200);
    const body = await res.json();
    // No items (null-installationId skips withTenant → empty rows)
    expect(body.items).toEqual([]);
    expect(transactionSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET / list — group-by-installationId and event enrichment branches
// ---------------------------------------------------------------------------

describe('repos router — GET / group-by-installationId enrichment', () => {
  const NOW_ENRICH = new Date('2026-03-01T00:00:00Z');

  /**
   * Build a db mock where:
   *   - The outer select returns the provided repos (via orderBy path used by GET /).
   *   - transaction() invokes the callback with a tx whose select returns the
   *     provided event rows.
   */
  function makeDbWithEvents(
    repoRows: RepoRecord[],
    eventRows: { repo: string; createdAt: Date; abortReason: string | null }[],
  ) {
    type ChainResult = Promise<unknown[]> & {
      orderBy: (..._a: unknown[]) => ChainResult;
      limit: (n: number) => Promise<unknown[]>;
    };
    function chainable(rows: unknown[]): ChainResult {
      const p: ChainResult = Object.assign(Promise.resolve(rows), {
        orderBy: (..._a: unknown[]): ChainResult => chainable(rows),
        limit: (n: number): Promise<unknown[]> => Promise.resolve(rows.slice(0, n)),
      });
      return p;
    }

    return {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => chainable(repoRows),
          orderBy: (..._a: unknown[]) => Promise.resolve(repoRows),
        }),
      }),
      insert: (_table: unknown) => ({
        values: (_row: unknown) => Promise.resolve(),
      }),
      update: (_table: unknown) => ({
        set: (_patch: unknown) => ({ where: (_cond: unknown) => Promise.resolve() }),
      }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        const tx = {
          execute: () => Promise.resolve([]),
          select: (_fields?: unknown) => ({
            from: (_table: unknown) => ({
              where: (_cond?: unknown): ChainResult => chainable(eventRows),
            }),
          }),
        };
        return fn(tx);
      },
    };
  }

  it('groups two repos with the same installationId into one withTenant call', async () => {
    // Exercises the `entry !== undefined` true branch (line 170 in repos.ts):
    // the second repo with the same installationId appends to the existing group
    // rather than creating a new entry in byInstallation.
    const repo1: RepoRecord = {
      id: 'r1',
      platform: 'github',
      name: 'org/repo1',
      enabled: true,
      installationId: 50n,
      createdAt: NOW_ENRICH,
      updatedAt: NOW_ENRICH,
      deletedAt: null,
    };
    const repo2: RepoRecord = {
      id: 'r2',
      platform: 'github',
      name: 'org/repo2',
      enabled: true,
      installationId: 50n, // SAME installationId as repo1
      createdAt: NOW_ENRICH,
      updatedAt: NOW_ENRICH,
      deletedAt: null,
    };
    const events = [
      { repo: 'org/repo1', createdAt: NOW_ENRICH, abortReason: null },
      { repo: 'org/repo2', createdAt: NOW_ENRICH, abortReason: 'max_files_exceeded' },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = makeDbWithEvents([repo1, repo2], events) as any;
    const app = createReposRouter({ db, now: () => NOW_ENRICH, generateId: () => 'new' });
    const res = await app.request('http://host/');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Both repos appear in the response
    expect(body).toHaveLength(2);
    // repo1 should have lastOutcome = 'commented' (no abortReason)
    const r1 = body.find((r: { id: string }) => r.id === 'r1');
    expect(r1?.lastOutcome).toBe('commented');
    expect(r1?.lastReviewAt).toBe(NOW_ENRICH.toISOString());
    // repo2 should have lastOutcome = 'failed'
    const r2 = body.find((r: { id: string }) => r.id === 'r2');
    expect(r2?.lastOutcome).toBe('failed');
  });

  it('deduplicates events per repo (first event per repo name wins)', async () => {
    // Exercises the `!latestByRepo.has(ev.repo)` false branch (line 199 in repos.ts):
    // when the same repo name appears twice in events, only the first occurrence
    // is kept (events already ordered DESC so first = most recent).
    const repo: RepoRecord = {
      id: 'r-dup',
      platform: 'github',
      name: 'org/dup-repo',
      enabled: true,
      installationId: 60n,
      createdAt: NOW_ENRICH,
      updatedAt: NOW_ENRICH,
      deletedAt: null,
    };
    const olderDate = new Date(NOW_ENRICH.getTime() - 1000);
    const events = [
      { repo: 'org/dup-repo', createdAt: NOW_ENRICH, abortReason: null }, // most recent
      { repo: 'org/dup-repo', createdAt: olderDate, abortReason: 'max_files_exceeded' }, // duplicate — should be ignored
    ];
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    const db = makeDbWithEvents([repo], events) as any;
    const app = createReposRouter({ db, now: () => NOW_ENRICH, generateId: () => 'new' });
    const res = await app.request('http://host/');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    // First event (most recent, no abortReason) wins — outcome = 'commented'
    expect(body[0].lastOutcome).toBe('commented');
    expect(body[0].lastReviewAt).toBe(NOW_ENRICH.toISOString());
  });
});
