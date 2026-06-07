import { describe, expect, it } from 'vitest';
import { createReposRouter } from '../repos.js';

const NOW = new Date('2026-05-15T10:00:00Z');

type RepoRecord = {
  id: string;
  platform: 'github' | 'codecommit';
  name: string;
  enabled: boolean;
  installationId?: bigint | null;
  systemPrompt: string | null | undefined;
  systemPromptUpdatedAt: Date | null | undefined;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

/**
 * Build a DB mock that implements the chain patterns used by the repos router.
 * Each `select()` call increments a call counter so sequential calls to the
 * same app instance return different rows (repo lookup → eval lookup, etc.).
 */
function _makeDb(
  repoStore: RepoRecord[],
  evalStore: { createdAt: Date; abortReason: string | null }[] = [],
) {
  let callIdx = 0;
  return {
    _store: repoStore,
    select: (_fields?: unknown) => {
      const thisCallIdx = callIdx++;
      return {
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            orderBy: (..._args: unknown[]) => ({
              limit: (_n: number) => {
                // Even calls return eval rows, odd calls return repo rows
                if (thisCallIdx % 2 === 1) {
                  return Promise.resolve(evalStore.slice(0, _n));
                }
                return Promise.resolve(evalStore.slice(0, _n));
              },
            }),
            limit: (_n: number) => {
              // Return filtered repo store based on deletedAt
              const alive = repoStore.filter((r) => r.deletedAt === null);
              return Promise.resolve(alive.slice(0, _n));
            },
          }),
          orderBy: (..._args: unknown[]) => ({
            limit: (_n: number) => Promise.resolve(repoStore.slice(0, _n)),
          }),
        }),
      };
    },
    update: (_table: unknown) => ({
      set: (patch: Partial<RepoRecord>) => ({
        where: (_cond: unknown) => {
          for (const r of repoStore) {
            Object.assign(r, patch);
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: (_table: unknown) => ({
      values: (row: RepoRecord) => {
        repoStore.push(row);
        return Promise.resolve();
      },
    }),
  };
}

// Precise mock for single-repo detail tests — each select() call consumes
// the next response from the array. Supports all chain forms used in repos.ts:
//   .where()           → awaitable AND chainable with .limit() / .orderBy().limit()
//   .orderBy().limit() → awaitable
type ChainResult = Promise<unknown[]> & {
  orderBy: (..._a: unknown[]) => ChainResult;
  limit: (_n: number) => Promise<unknown[]>;
};

function makeSequentialDb(responses: unknown[][], txResponses: unknown[][] = []) {
  let idx = 0;

  function chainable(rows: unknown[]): ChainResult {
    const p: ChainResult = Object.assign(Promise.resolve(rows), {
      orderBy: (..._a: unknown[]): ChainResult => chainable(rows),
      limit: (_n: number): Promise<unknown[]> => Promise.resolve(rows),
    });
    return p;
  }

  return {
    select: (_fields?: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond?: unknown): ChainResult => {
          const r = responses[idx] ?? [];
          idx++;
          return chainable(r);
        },
        orderBy: (..._args: unknown[]) => ({
          limit: (_n: number) => {
            const r = responses[idx] ?? [];
            idx++;
            return Promise.resolve(r);
          },
        }),
      }),
    }),
    // transaction() is used by withTenant for RLS-scoped queries (metrics).
    // The callback receives a tx object whose select() consumes `txResponses`.
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      let txIdx = 0;
      const tx = {
        execute: () => Promise.resolve([]),
        select: (_fields?: unknown) => ({
          from: (_table: unknown) => ({
            where: (_cond?: unknown): ChainResult => {
              const r = txResponses[txIdx] ?? [];
              txIdx++;
              return chainable(r);
            },
          }),
        }),
      };
      return fn(tx);
    },
    update: (_table: unknown) => ({
      set: (_patch: unknown) => ({
        where: (_cond: unknown) => Promise.resolve(),
      }),
    }),
    insert: (_table: unknown) => ({
      values: (_row: unknown) => Promise.resolve(),
    }),
  };
}

function makeRepo(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    id: 'r1',
    platform: 'github',
    name: 'org/repo',
    enabled: true,
    systemPrompt: null,
    systemPromptUpdatedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe('GET /repos/:id', () => {
  it('returns 404 for non-existent repo', async () => {
    const db = makeSequentialDb([
      [], // select repo → not found
    ]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 404 for soft-deleted repo', async () => {
    const _deleted = makeRepo({ deletedAt: NOW });
    const db = makeSequentialDb([
      [], // no result because deleted_at IS NOT NULL filtered
    ]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r1');
    expect(res.status).toBe(404);
  });

  it('returns detail with systemPromptPresent=false when null', async () => {
    const repo = makeRepo({ systemPrompt: null });
    const db = makeSequentialDb([
      [repo], // repo select
      [], // eval events (none)
    ]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.systemPromptPresent).toBe(false);
    expect(body.createdAt).toBe(NOW.toISOString());
    expect(body.updatedAt).toBe(NOW.toISOString());
  });

  it('returns detail with systemPromptPresent=false for empty string', async () => {
    const repo = makeRepo({ systemPrompt: '' });
    const db = makeSequentialDb([[repo], []]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r1');
    const body = await res.json();
    expect(body.systemPromptPresent).toBe(false);
  });

  it('returns detail with systemPromptPresent=true for non-empty prompt', async () => {
    const repo = makeRepo({ systemPrompt: 'You are a strict reviewer.' });
    const db = makeSequentialDb([[repo], []]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r1');
    const body = await res.json();
    expect(body.systemPromptPresent).toBe(true);
  });

  it('uses withTenant path when repo has installationId — populates lastReviewAt', async () => {
    // Repo with installationId → handler wraps reviewEvalEvent query in withTenant.
    // The tx select returns one eval row; the response should reflect it.
    const repo = makeRepo({ installationId: 42n, systemPrompt: null });
    const evalRow = { createdAt: NOW, abortReason: null };
    const db = makeSequentialDb(
      [[repo]], // outer: repo lookup
      [[evalRow]], // tx: last eval event
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastReviewAt).toBe(NOW.toISOString());
    expect(body.lastOutcome).toBe('commented');
  });

  it('returns null lastReviewAt for null-installationId repo (no tenant scope)', async () => {
    // Repo with installationId=null → withTenant skipped → lastReviewAt is null.
    const repo = makeRepo({ installationId: null, systemPrompt: null });
    const db = makeSequentialDb([[repo]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => 'new-id',
    });
    const res = await app.request('http://host/r1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastReviewAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /:id/prompt
// ---------------------------------------------------------------------------

describe('GET /repos/:id/prompt', () => {
  it('returns 404 for non-existent repo', async () => {
    const db = makeSequentialDb([[]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/nonexistent/prompt');
    expect(res.status).toBe(404);
  });

  it('returns empty string when no prompt set', async () => {
    const repo = makeRepo({ systemPrompt: null, systemPromptUpdatedAt: null });
    const db = makeSequentialDb([[repo]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/prompt');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.systemPrompt).toBe('');
    expect(body.updatedAt).toBe(null);
  });

  it('returns saved prompt and updatedAt', async () => {
    const repo = makeRepo({
      systemPrompt: 'Be concise.',
      systemPromptUpdatedAt: NOW,
    });
    const db = makeSequentialDb([[repo]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/prompt');
    const body = await res.json();
    expect(body.systemPrompt).toBe('Be concise.');
    expect(body.updatedAt).toBe(NOW.toISOString());
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/prompt
// ---------------------------------------------------------------------------

describe('PUT /repos/:id/prompt', () => {
  it('returns 404 when repo does not exist', async () => {
    const db = makeSequentialDb([[]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/nonexistent/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'hello' }),
    });
    expect(res.status).toBe(404);
  });

  it('saves non-empty prompt and returns it', async () => {
    const repo = makeRepo();
    let updated = false;
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => Promise.resolve([repo]),
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (_patch: unknown) => ({
          where: (_cond: unknown) => {
            updated = true;
            return Promise.resolve();
          },
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'Focus on security.' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.systemPrompt).toBe('Focus on security.');
    expect(body.updatedAt).toBe(NOW.toISOString());
    expect(updated).toBe(true);
  });

  it('stores NULL (returns empty string) for empty input', async () => {
    const repo = makeRepo();
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => Promise.resolve([repo]),
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (_patch: unknown) => ({
          where: (_cond: unknown) => Promise.resolve(),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: '' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.systemPrompt).toBe('');
  });

  it('stores NULL for whitespace-only input', async () => {
    const repo = makeRepo();
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => Promise.resolve([repo]),
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (_patch: unknown) => ({
          where: (_cond: unknown) => Promise.resolve(),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: '   ' }),
    });
    const body = await res.json();
    expect(body.systemPrompt).toBe('');
  });

  it('returns 422 for prompt exceeding 50000 chars', async () => {
    const repo = makeRepo();
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => Promise.resolve([repo]),
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (_patch: unknown) => ({
          where: (_cond: unknown) => Promise.resolve(),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'x'.repeat(50001) }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 400 on malformed JSON', async () => {
    const repo = makeRepo();
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => Promise.resolve([repo]),
          }),
        }),
      }),
      update: (_table: unknown) => ({
        set: (_patch: unknown) => ({
          where: (_cond: unknown) => Promise.resolve(),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: 'broken json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for soft-deleted repo', async () => {
    const db = makeSequentialDb([
      [], // lookup returns empty (deleted_at IS NULL filter removes it)
    ]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/deleted/prompt', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ systemPrompt: 'test' }),
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/metrics
// ---------------------------------------------------------------------------

describe('GET /repos/:id/metrics', () => {
  it('returns 404 when repo not found', async () => {
    const db = makeSequentialDb([[]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/nonexistent/metrics');
    expect(res.status).toBe(404);
  });

  it('returns zeros when repo has null installation_id (no RLS tenant scope)', async () => {
    // Repo without installationId — the handler skips withTenant and returns
    // 0/0/0/0 because null-installation repos cannot be scoped under RLS.
    const db = makeSequentialDb(
      [[{ name: 'org/repo', installationId: null }]], // repo lookup (no installationId)
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalReviews).toBe(0);
    expect(body.reviewsLast30d).toBe(0);
    expect(body.avgDurationMs).toBe(0);
    expect(body.totalCostUsd).toBe(0);
  });

  it('aggregates metrics via withTenant when repo has installationId', async () => {
    // Repo with installationId — handler runs withTenant, which calls
    // db.transaction(). The tx select() calls consume txResponses.
    const db = makeSequentialDb(
      [[{ name: 'org/repo', installationId: 42n }]], // outer: repo lookup
      [
        [{ totalReviews: 15, avgDurationMs: '1200.5', totalCostUsd: '3.75' }], // tx: all-time agg
        [{ reviewsLast30d: 5 }], // tx: last 30d count
      ],
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalReviews).toBe(15);
    expect(body.reviewsLast30d).toBe(5);
    expect(typeof body.avgDurationMs).toBe('number');
    expect(typeof body.totalCostUsd).toBe('number');
  });

  it('returns zeros when no reviews exist (installationId present, empty data)', async () => {
    const db = makeSequentialDb(
      [[{ name: 'org/repo', installationId: 99n }]], // outer: repo lookup
      [
        [{ totalReviews: 0, avgDurationMs: null, totalCostUsd: null }], // tx: all-time agg
        [{ reviewsLast30d: 0 }], // tx: last 30d count
      ],
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalReviews).toBe(0);
    expect(body.reviewsLast30d).toBe(0);
    expect(body.avgDurationMs).toBe(0);
    expect(body.totalCostUsd).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// GET /:id/reviews
// ---------------------------------------------------------------------------

describe('GET /repos/:id/reviews', () => {
  it('returns 404 when repo not found', async () => {
    const db = makeSequentialDb([[]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/nonexistent/reviews');
    expect(res.status).toBe(404);
  });

  it('returns empty items array when no reviews', async () => {
    let callIdx = 0;
    const responses = [
      [{ name: 'org/repo', platform: 'github' }], // repo lookup
      [], // eval events
    ];
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => {
              const r = responses[callIdx] ?? [];
              callIdx++;
              return Promise.resolve(r);
            },
            orderBy: (..._args: unknown[]) => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/reviews');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBe(null);
  });

  it('returns 400 on invalid cursor', async () => {
    let callIdx = 0;
    const responses = [[{ name: 'org/repo', platform: 'github' }], []];
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => {
              const r = responses[callIdx] ?? [];
              callIdx++;
              return Promise.resolve(r);
            },
            orderBy: (..._args: unknown[]) => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/reviews?cursor=!!!');
    expect(res.status).toBe(400);
  });

  it('applies limit parameter', async () => {
    let callIdx = 0;
    const responses = [[{ name: 'org/repo', platform: 'github' }], []];
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => {
              const r = responses[callIdx] ?? [];
              callIdx++;
              return Promise.resolve(r);
            },
            orderBy: (..._args: unknown[]) => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/reviews?limit=5');
    expect(res.status).toBe(200);
  });

  it('accepts valid cursor for repo reviews', async () => {
    const cursorDate = new Date('2026-04-01T00:00:00Z');
    const validCursor = Buffer.from(
      JSON.stringify({ t: cursorDate.toISOString(), id: '1' }),
    ).toString('base64url');

    let callIdx = 0;
    const responses = [[{ name: 'org/repo', platform: 'github' }], []];
    const db = {
      select: (_fields?: unknown) => ({
        from: (_table: unknown) => ({
          where: (_cond?: unknown) => ({
            limit: (_n: number) => {
              const r = responses[callIdx] ?? [];
              callIdx++;
              return Promise.resolve(r);
            },
            orderBy: (..._args: unknown[]) => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      }),
    };
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request(`http://host/r1/reviews?cursor=${validCursor}`);
    expect(res.status).toBe(200);
  });

  it('returns failed outcome for review with abortReason set', async () => {
    // Repo has installationId so the handler takes the withTenant path.
    // Eval row goes into txResponses (consumed by the transaction mock).
    const evalRow = {
      id: BigInt(10),
      repo: 'org/repo',
      prNumber: 5,
      jobId: 'org/repo#5@ts',
      abortReason: 'max_files_exceeded',
      costUsd: 0.01,
      latencyMs: 500,
      createdAt: NOW,
    };
    const db = makeSequentialDb(
      [[{ name: 'org/repo', platform: 'github', installationId: 42n }]], // repo lookup
      [[evalRow]], // tx: reviews (consumed inside withTenant)
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/reviews');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].outcome).toBe('failed');
  });

  it('returns platform=codecommit for a codecommit repo review list', async () => {
    // Repo has installationId so the handler takes the withTenant path.
    const evalRow = {
      id: BigInt(20),
      repo: 'my-cc-repo',
      prNumber: 1,
      jobId: 'j1',
      abortReason: null,
      costUsd: 0.01,
      latencyMs: 100,
      createdAt: NOW,
    };
    const db = makeSequentialDb(
      [[{ name: 'my-cc-repo', platform: 'codecommit', installationId: 55n }]], // repo lookup
      [[evalRow]], // tx: reviews
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/reviews');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.length).toBe(1);
    expect(body.items[0].platform).toBe('codecommit');
  });

  it('returns nextCursor when hasMore is true', async () => {
    // Create limit+1 rows so hasMore fires; repo has installationId.
    const baseRow = {
      id: BigInt(1),
      repo: 'org/repo',
      prNumber: 1,
      jobId: 'j1',
      abortReason: null,
      costUsd: 0.01,
      latencyMs: 100,
      createdAt: NOW,
    };
    const rows = Array.from({ length: 21 }, (_, i) => ({
      ...baseRow,
      id: BigInt(i + 1),
      prNumber: i + 1,
    }));
    const db = makeSequentialDb(
      [[{ name: 'org/repo', platform: 'github', installationId: 77n }]], // repo lookup
      [rows], // tx: 21 rows > default limit of 20
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/reviews?limit=20');
    const body = await res.json();
    expect(body.nextCursor).not.toBe(null);
  });

  it('silently coerces non-numeric limit to default (schema transforms, never 422)', async () => {
    // The reviewsQuerySchema transforms `limit=abc` to 50 (the default) rather
    // than rejecting it, so the safeParse always succeeds and the handler returns
    // 200 with the default page size.
    const db = makeSequentialDb([[{ name: 'org/repo', platform: 'github', installationId: null }]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/reviews?limit=abc');
    expect(res.status).toBe(200);
    const body = await res.json();
    // Coerced to default limit, returns empty items for null-installationId repo
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('returns 400 for cursor with valid base64 JSON but NaN timestamp', async () => {
    // decodeCursor succeeds (returns {t, id}) but new Date(decoded.t) is NaN.
    // Exercises the Number.isNaN branch (line 663 in repos.ts).
    const badCursor = Buffer.from(JSON.stringify({ t: 'not-a-date', id: '1' })).toString(
      'base64url',
    );
    const db = makeSequentialDb([[{ name: 'org/repo', platform: 'github', installationId: null }]]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request(`http://host/r1/reviews?cursor=${badCursor}`);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_cursor');
  });

  it('passes cursor into withTenant query when repo has installationId', async () => {
    // Exercises the cursorDate !== undefined && cursorId !== undefined true branch
    // inside the withTenant call (line 696 in repos.ts): the query uses the
    // cursor-filtered WHERE clause rather than the no-cursor fallback.
    const cursorDate = new Date('2026-04-01T00:00:00Z');
    const validCursor = Buffer.from(
      JSON.stringify({ t: cursorDate.toISOString(), id: '5' }),
    ).toString('base64url');

    const evalRow = {
      id: BigInt(3),
      repo: 'org/repo',
      prNumber: 2,
      jobId: 'j2',
      abortReason: null,
      costUsd: 0.02,
      latencyMs: 200,
      createdAt: new Date('2026-03-15T00:00:00Z'),
    };
    const db = makeSequentialDb(
      [[{ name: 'org/repo', platform: 'github', installationId: 42n }]], // repo lookup
      [[evalRow]], // tx: reviews with cursor filter applied
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request(`http://host/r1/reviews?cursor=${validCursor}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Should return the eval row mapped to a ReviewEvent
    expect(body.items).toHaveLength(1);
    expect(body.items[0].outcome).toBe('commented');
    expect(body.nextCursor).toBe(null); // only 1 row, no next page
  });
});

// ---------------------------------------------------------------------------
// GET /:id/metrics — additional branch coverage
// ---------------------------------------------------------------------------

describe('GET /repos/:id/metrics — additional branches', () => {
  it('returns zeros when last30d tx call returns empty array (last30d undefined)', async () => {
    // Covers the results.last30d?.reviewsLast30d branch where last30d is
    // undefined (tx second select returns []).
    const db = makeSequentialDb(
      [[{ name: 'org/repo', installationId: 42n }]],
      [
        [{ totalReviews: 3, avgDurationMs: '500', totalCostUsd: '0.5' }], // all-time agg
        [], // last30d returns empty — last30dRows[0] is undefined
      ],
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/metrics');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewsLast30d).toBe(0);
    // All-time values are still populated
    expect(body.totalReviews).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id — lastReviewAt populated when installationId present
// ---------------------------------------------------------------------------

describe('PATCH /repos/:id — lastReviewAt and lastOutcome populated via withTenant', () => {
  it('returns lastReviewAt and lastOutcome from withTenant event when repo has installationId', async () => {
    // Exercises lines 446-447: last !== undefined true branch in PATCH summary.
    // The tx (called twice by PATCH: once for GET /:id, once post-update) returns
    // an event row on the second transaction call.
    const evalRow = { createdAt: NOW, abortReason: null };
    const repoRow = {
      id: 'r1',
      platform: 'github',
      name: 'org/repo',
      enabled: true,
      installationId: 55n,
      systemPrompt: null,
      systemPromptUpdatedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    };
    // PATCH /:id selects the repo twice:
    //   1. Before update (to check existence + principal auth)
    //   2. After update (to build summary response)
    // Each outer select() call consumes one response entry.
    // Then withTenant (called after update) consumes one txResponse entry.
    const db = makeSequentialDb(
      [[repoRow], [repoRow]], // outer: before-update lookup, after-update lookup
      [[evalRow]], // tx: last eval event for the repo
    );
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lastReviewAt).toBe(NOW.toISOString());
    expect(body.lastOutcome).toBe('commented');
  });
});
