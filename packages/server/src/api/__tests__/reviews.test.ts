import { describe, expect, it } from 'vitest';
import { createReviewsRouter } from '../reviews.js';

// ---------------------------------------------------------------------------
// Mock DB builder
// ---------------------------------------------------------------------------

type EvalRow = {
  id: bigint;
  repo: string;
  prNumber: number;
  jobId: string;
  abortReason: string | null;
  costUsd: number;
  latencyMs: number;
  createdAt: Date;
  provider: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
};

type RepoRow = {
  id: string;
  name: string;
  platform: 'github' | 'codecommit';
  systemPrompt: string | null;
};

// ---------------------------------------------------------------------------
// Helper to make a clean router with a simple stateful mock
// ---------------------------------------------------------------------------

const NOW = new Date('2026-05-01T12:00:00Z');

function makeRow(overrides: Partial<EvalRow> = {}): EvalRow {
  return {
    id: BigInt(1),
    repo: 'owner/repo',
    prNumber: 42,
    jobId: 'owner/repo#42@1234',
    abortReason: null,
    costUsd: 0.05,
    latencyMs: 2000,
    createdAt: NOW,
    provider: 'anthropic',
    model: 'claude-3-5-sonnet',
    tokensInput: 100,
    tokensOutput: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Actual DB mock that properly distinguishes count vs select queries
// ---------------------------------------------------------------------------

// Chain-result type: awaitable AND supports .limit() / .orderBy()
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

function makeFullDb(evalRows: EvalRow[], repoRows: RepoRow[]) {
  return {
    select: (fields?: Record<string, unknown>) => {
      const isCountQuery =
        fields !== undefined &&
        Object.keys(fields).includes('value') &&
        !Object.keys(fields).includes('id');
      // Repo query: has 'name' or 'platform' fields AND has 'id' field
      // (the updated GET / now selects {id, name, platform})
      const isRepoQuery =
        fields !== undefined &&
        (Object.keys(fields).includes('name') || Object.keys(fields).includes('platform')) &&
        !Object.keys(fields).includes('repo');

      return {
        from: (_table: unknown) => ({
          where: (_cond?: unknown): DbChainResult => {
            if (isCountQuery) {
              return makeChainable([{ value: evalRows.length }]);
            }
            if (isRepoQuery) {
              return makeChainable(repoRows);
            }
            return makeChainable(evalRows);
          },
          orderBy: (..._args: unknown[]) => ({
            limit: (n: number): Promise<unknown[]> => {
              if (isCountQuery) return Promise.resolve([{ value: evalRows.length }]);
              if (isRepoQuery) return Promise.resolve(repoRows.slice(0, n));
              return Promise.resolve(evalRows.slice(0, n));
            },
          }),
        }),
      };
    },
  };
}

describe('reviews router', () => {
  describe('GET /', () => {
    it('returns empty items when no reviews exist', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        awsRegion: 'us-east-1',
      });
      const res = await app.request('http://host/');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toEqual([]);
      expect(body.nextCursor).toBe(null);
      expect(typeof body.total).toBe('number');
    });

    it('returns items with correct shape when repo is registered', async () => {
      const row = makeRow();
      const db = makeFullDb(
        [row],
        [{ id: 'uuid-repo-1', name: 'owner/repo', platform: 'github', systemPrompt: null }],
      );
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        awsRegion: 'us-east-1',
      });
      const res = await app.request('http://host/');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBe(1);
      // repoId must be the UUID from the repos table, not the repo name
      expect(body.items[0].repoId).toBe('uuid-repo-1');
      expect(body.items[0].repoName).toBe('owner/repo');
    });

    it('skips orphaned events (eval row with no matching repo)', async () => {
      const row = makeRow({ repo: 'ghost/orphan' });
      // No repos entry for 'ghost/orphan'
      const db = makeFullDb([row], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        awsRegion: 'us-east-1',
      });
      const res = await app.request('http://host/');
      expect(res.status).toBe(200);
      const body = await res.json();
      // Orphaned event must be excluded
      expect(body.items).toEqual([]);
    });

    it('validates limit parameter — clamps to 200', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?limit=300');
      // Should succeed (limit clamped to 200)
      expect(res.status).toBe(200);
    });

    it('returns 400 on invalid cursor', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?cursor=!!!invalid!!!');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe('invalid_cursor');
    });

    it('returns 400 on cursor with invalid timestamp', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      // base64url encode { t: "not-a-date", id: "1" }
      const badCursor = Buffer.from(JSON.stringify({ t: 'not-a-date', id: '1' })).toString(
        'base64url',
      );
      const res = await app.request(`http://host/?cursor=${badCursor}`);
      expect(res.status).toBe(400);
    });

    it('returns 422 on invalid since parameter', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?since=not-valid-at-all');
      expect(res.status).toBe(422);
    });

    it('accepts since=24h alias', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?since=24h');
      expect(res.status).toBe(200);
    });

    it('accepts since=7d alias', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?since=7d');
      expect(res.status).toBe(200);
    });

    it('accepts since=30d alias', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?since=30d');
      expect(res.status).toBe(200);
    });

    it('accepts since as ISO datetime string', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?since=2026-01-01T00:00:00Z');
      expect(res.status).toBe(200);
    });

    it('applies platform filter (in-memory)', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?platform=github');
      expect(res.status).toBe(200);
    });

    it('applies outcome filter (in-memory)', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?outcome=failed');
      expect(res.status).toBe(200);
    });

    it('applies repoQuery filter', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?repoQuery=myrepo');
      expect(res.status).toBe(200);
    });

    it('response includes total field', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/');
      const body = await res.json();
      expect('total' in body).toBe(true);
    });
  });

  describe('GET /:id', () => {
    it('returns 404 when review does not exist', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        awsRegion: 'us-east-1',
      });
      const res = await app.request('http://host/999');
      expect(res.status).toBe(404);
    });

    it('returns 404 for non-numeric id', async () => {
      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/not-a-number');
      expect(res.status).toBe(404);
    });

    it('returns detail shape for existing review (github platform)', async () => {
      const row = makeRow({ id: BigInt(42) });
      const repoRow: RepoRow = {
        id: 'uuid-42-repo',
        name: 'owner/repo',
        platform: 'github',
        systemPrompt: null,
      };

      let callIdx = 0;
      const responses = [
        [row], // first select: eval row
        [repoRow], // second select: repo row
      ];
      const callCountDb = {
        select: (_fields?: unknown) => ({
          from: (_table: unknown) => ({
            where: (_cond?: unknown) => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
              orderBy: (..._args: unknown[]) => ({
                limit: (_n: number) => Promise.resolve([repoRow]),
              }),
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: callCountDb as any,
        now: () => NOW,
        awsRegion: 'us-east-1',
      });
      const res = await app.request('http://host/42');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('id', '42');
      // repoId must be the UUID from the repos table
      expect(body.repoId).toBe('uuid-42-repo');
      expect(body).toHaveProperty('comments');
      expect(body).toHaveProperty('toolCalls');
      expect(body).toHaveProperty('tokens');
      expect(body).toHaveProperty('timing');
      expect(body).toHaveProperty('provider');
      expect(body).toHaveProperty('externalUrl');
      expect(body).toHaveProperty('systemPromptAtReview');
    });

    it('generates correct github externalUrl', async () => {
      const row = makeRow({ id: BigInt(1), repo: 'acme/widget', prNumber: 7 });
      const repoRow: RepoRow = {
        id: 'uuid-acme-widget',
        name: 'acme/widget',
        platform: 'github',
        systemPrompt: null,
      };

      let callIdx = 0;
      const responses = [[row], [repoRow]];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        awsRegion: 'us-east-1',
      });
      const res = await app.request('http://host/1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.externalUrl).toBe('https://github.com/acme/widget/pull/7');
    });

    it('generates correct codecommit externalUrl', async () => {
      const row = makeRow({ id: BigInt(2), repo: 'my-repo', prNumber: 3 });
      const repoRow: RepoRow = {
        id: 'uuid-my-repo',
        name: 'my-repo',
        platform: 'codecommit',
        systemPrompt: null,
      };

      let callIdx = 0;
      const responses = [[row], [repoRow]];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        awsRegion: 'eu-west-1',
      });
      const res = await app.request('http://host/2');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.externalUrl).toContain('codecommit');
      expect(body.externalUrl).toContain('my-repo');
      expect(body.externalUrl).toContain('3');
      expect(body.externalUrl).toContain('eu-west-1');
    });

    it('falls back to github platform and repo name as repoId when repo not found', async () => {
      const row = makeRow({ id: BigInt(3) });
      let callIdx = 0;
      const responses = [[row], []]; // no repo row
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        awsRegion: 'us-east-1',
      });
      const res = await app.request('http://host/3');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.platform).toBe('github');
      // Falls back to repo name string when no UUID available
      expect(body.repoId).toBe('owner/repo');
    });

    it('returns comments=[] when no comment table present', async () => {
      const row = makeRow({ id: BigInt(5) });
      let callIdx = 0;
      const responses = [[row], []];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/5');
      const body = await res.json();
      expect(body.comments).toEqual([]);
    });

    it('returns toolCalls=[] when no tool call table present', async () => {
      const row = makeRow({ id: BigInt(6) });
      let callIdx = 0;
      const responses = [[row], []];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/6');
      const body = await res.json();
      expect(body.toolCalls).toEqual([]);
    });

    it('returns timing.startedAt and completedAt as null', async () => {
      const row = makeRow({ id: BigInt(7) });
      let callIdx = 0;
      const responses = [[row], []];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/7');
      const body = await res.json();
      expect(body.timing.startedAt).toBe(null);
      expect(body.timing.completedAt).toBe(null);
    });

    it('returns tokens from row columns', async () => {
      const row = makeRow({ id: BigInt(8), tokensInput: 300, tokensOutput: 150 });
      let callIdx = 0;
      const responses = [[row], []];
      const db = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: (_n: number) => {
                const r = responses[callIdx] ?? [];
                callIdx++;
                return Promise.resolve(r);
              },
            }),
          }),
        }),
      };

      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/8');
      const body = await res.json();
      expect(body.tokens.prompt).toBe(300);
      expect(body.tokens.completion).toBe(150);
      expect(body.tokens.total).toBe(450);
    });
  });

  // Additional branch coverage tests
  describe('filter branches', () => {
    it('platform filter rejects non-matching rows', async () => {
      // Row has no matching repo so it is orphaned → 0 items (not defaulted to github)
      const row = makeRow({ id: BigInt(10) });
      const db = makeFullDb([row], []); // no repo rows → orphaned, skipped
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?platform=codecommit');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBe(0);
    });

    it('outcome filter rejects non-matching rows', async () => {
      // Row has no abortReason → outcome=commented; filter for failed → 0 items
      const row = makeRow({ id: BigInt(11), abortReason: null });
      const db = makeFullDb(
        [row],
        [{ id: 'uuid-11', name: 'owner/repo', platform: 'github', systemPrompt: null }],
      );
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?outcome=failed');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBe(0);
    });

    it('outcome=failed matches rows with abortReason', async () => {
      const row = makeRow({ id: BigInt(12), abortReason: 'schema_violation' });
      const db = makeFullDb(
        [row],
        [{ id: 'uuid-12', name: 'owner/repo', platform: 'github', systemPrompt: null }],
      );
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?outcome=failed');
      const body = await res.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].outcome).toBe('failed');
    });

    it('hasMore triggers nextCursor generation', async () => {
      // 11 rows with limit=10 → hasMore=true, nextCursor set
      const rows = Array.from({ length: 11 }, (_, i) =>
        makeRow({ id: BigInt(i + 100), prNumber: i + 1 }),
      );
      const db = makeFullDb(rows, [
        { id: 'uuid-owner-repo', name: 'owner/repo', platform: 'github', systemPrompt: null },
      ]);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?limit=10');
      const body = await res.json();
      expect(body.nextCursor).not.toBe(null);
      expect(body.items.length).toBe(10);
    });

    it('accepts valid cursor and executes cursor predicate', async () => {
      // Build a valid cursor string
      const cursorDate = new Date('2026-04-01T00:00:00Z');
      const cursorId = BigInt(1);
      const validCursor = Buffer.from(
        JSON.stringify({ t: cursorDate.toISOString(), id: cursorId.toString() }),
      ).toString('base64url');

      const db = makeFullDb([], []);
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request(`http://host/?cursor=${validCursor}`);
      expect(res.status).toBe(200);
    });

    it('tie-break: two pages with same createdAt produce no duplicates and no skips', async () => {
      // 4 rows all with the same createdAt, ids 1-4 ordered desc: [4,3,2,1]
      // Page 1: limit=2, no cursor → rows [4,3], nextCursor encodes {t, id:3}
      // Page 2: cursor={t, id:3} → rows with id < 3 at same timestamp = [2,1]
      // Without tie-break, lt(createdAt, cursorDate) would skip ALL same-ts rows.
      const sharedDate = new Date('2026-05-01T12:00:00Z');
      const allRows = [4, 3, 2, 1].map((n) =>
        makeRow({ id: BigInt(n), prNumber: n, createdAt: sharedDate }),
      );
      const repoEntry = [
        { id: 'uuid-repo', name: 'owner/repo', platform: 'github' as const, systemPrompt: null },
      ];

      // Page 1: return first 3 rows (limit+1=3) so hasMore=true, page=[4,3]
      const page1Rows = allRows.slice(0, 3); // [id4, id3, id2]
      const db1 = makeFullDb(page1Rows, repoEntry);
      const app1 = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db1 as any,
        now: () => NOW,
      });
      const res1 = await app1.request('http://host/?limit=2');
      expect(res1.status).toBe(200);
      const body1 = await res1.json();
      expect(body1.items.length).toBe(2); // [id4, id3]
      expect(body1.nextCursor).not.toBe(null);

      // Page 2: cursor from page1 encodes {t: sharedDate, id: 3}
      // Only rows with same date AND id < 3 should come back = [id2, id1]
      const page2Rows = allRows.slice(2); // [id2, id1]
      const db2 = makeFullDb(page2Rows, repoEntry);
      const app2 = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db2 as any,
        now: () => NOW,
      });
      const res2 = await app2.request(`http://host/?limit=2&cursor=${body1.nextCursor}`);
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.items.length).toBe(2); // [id2, id1]

      // Verify no duplicates between page 1 and page 2
      const page1Ids = new Set(body1.items.map((i: { id: string }) => i.id));
      for (const item of body2.items as Array<{ id: string }>) {
        expect(page1Ids.has(item.id)).toBe(false);
      }
    });

    it('platform filter passes matching rows (codecommit)', async () => {
      const row = makeRow({ id: BigInt(20), repo: 'my-cc-repo' });
      const db = makeFullDb(
        [row],
        [{ id: 'uuid-cc', name: 'my-cc-repo', platform: 'codecommit', systemPrompt: null }],
      );
      const app = createReviewsRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
      });
      const res = await app.request('http://host/?platform=codecommit');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.length).toBe(1);
      expect(body.items[0].platform).toBe('codecommit');
    });
  });
});
