import { describe, expect, it } from 'vitest';
import { createReposRouter } from '../repos.js';

const NOW = new Date('2026-05-15T10:00:00Z');

type RepoRecord = {
  id: string;
  platform: 'github' | 'codecommit';
  name: string;
  enabled: boolean;
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

function makeSequentialDb(responses: unknown[][]) {
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

  it('returns zeros when no reviews exist', async () => {
    const db = makeSequentialDb([
      [{ name: 'org/repo' }], // repo lookup
      [{ totalReviews: 0, avgDurationMs: null, totalCostUsd: null }], // all-time agg
      [{ reviewsLast30d: 0 }], // last 30d count
    ]);
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

  it('returns numeric aggregates', async () => {
    const db = makeSequentialDb([
      [{ name: 'org/repo' }],
      [{ totalReviews: 15, avgDurationMs: '1200.5', totalCostUsd: '3.75' }],
      [{ reviewsLast30d: 5 }],
    ]);
    const app = createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    });
    const res = await app.request('http://host/r1/metrics');
    const body = await res.json();
    expect(body.totalReviews).toBe(15);
    expect(body.reviewsLast30d).toBe(5);
    expect(typeof body.avgDurationMs).toBe('number');
    expect(typeof body.totalCostUsd).toBe('number');
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
    let callIdx = 0;
    const responses = [
      [{ name: 'org/repo', platform: 'github' }], // repo lookup
      [evalRow], // reviews
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
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items[0].outcome).toBe('failed');
  });

  it('returns platform=codecommit for a codecommit repo review list', async () => {
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
    let callIdx = 0;
    const responses = [
      [{ name: 'my-cc-repo', platform: 'codecommit' }], // repo lookup
      [evalRow],
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
    expect(body.items.length).toBe(1);
    expect(body.items[0].platform).toBe('codecommit');
  });

  it('returns nextCursor when hasMore is true', async () => {
    // Create limit+1 rows so hasMore fires
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
    let callIdx = 0;
    const responses = [
      [{ name: 'org/repo', platform: 'github' }],
      rows, // 21 rows > default limit of 20
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
    const res = await app.request('http://host/r1/reviews?limit=20');
    const body = await res.json();
    expect(body.nextCursor).not.toBe(null);
  });
});
