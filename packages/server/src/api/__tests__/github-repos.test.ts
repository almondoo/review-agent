/**
 * Unit tests for:
 *   GET  /api/github/installations/:installationId/repos  (spec §8.2.4)
 *   POST /api/repos/bulk                                   (spec §8.2.5)
 *
 * Uses stub DB and stub AppAuthClient — no live Postgres or GitHub API.
 */
import type { AppAuthClient } from '@review-agent/platform-github';
import { describe, expect, it, vi } from 'vitest';
import { createGithubReposRouter } from '../github-repos.js';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

type RepoRecord = {
  id: string;
  platform: string;
  name: string;
  enabled: boolean;
  installationId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type InstallationRecord = {
  installationId: bigint;
  suspendedAt: Date | null;
};

// ---------------------------------------------------------------------------
// DB mock builder
// ---------------------------------------------------------------------------

/**
 * Build a DB mock that:
 *   - holds an in-memory repos store and github_installations store
 *   - supports select().from().where().limit()
 *   - supports insert().values()
 *   - supports transaction() that mimics withTenant (calls fn with the same mock)
 */
function makeDb(opts: { installations?: InstallationRecord[]; repos?: RepoRecord[] } = {}) {
  const repoStore: RepoRecord[] = [...(opts.repos ?? [])];
  const installationStore: InstallationRecord[] = [...(opts.installations ?? [])];

  type ChainResult = Promise<unknown[]> & {
    orderBy: (..._a: unknown[]) => ChainResult;
    limit: (_n: number) => Promise<unknown[]>;
  };

  function chainable(rows: unknown[]): ChainResult {
    const p: ChainResult = Object.assign(Promise.resolve(rows), {
      orderBy: (..._a: unknown[]): ChainResult => chainable(rows),
      limit: (_n: number): Promise<unknown[]> => Promise.resolve(rows.slice(0, _n)),
    });
    return p;
  }

  const self: {
    _repos: RepoRecord[];
    _installations: InstallationRecord[];
    select: (_fields?: unknown) => {
      from: (_table: unknown) => {
        where: (_cond?: unknown) => ChainResult;
      };
    };
    insert: (_table: unknown) => {
      values: (_row: unknown) => Promise<void>;
    };
    transaction: <T>(_fn: (_tx: unknown) => Promise<T>) => Promise<T>;
    execute: (_sql: unknown) => Promise<unknown[]>;
  } = {
    _repos: repoStore,
    _installations: installationStore,

    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond?: unknown): ChainResult => {
          // Detect which table is queried via the Drizzle Symbol(drizzle:Name).
          const drizzleName = (table as Record<symbol, string>)[Symbol.for('drizzle:Name')];
          if (drizzleName === 'github_installations') {
            return chainable(installationStore.map((r) => ({ ...r })));
          }
          // Default: return repos (non-deleted only)
          const active = repoStore.filter((r) => r.deletedAt === null);
          return chainable(active);
        },
      }),
    }),

    insert: (_table: unknown) => ({
      values: (row: unknown) => {
        repoStore.push(row as RepoRecord);
        return Promise.resolve();
      },
    }),

    // withTenant opens a transaction and calls set_config; we just call fn
    // with the same db mock (sufficient for unit tests).
    transaction: async <T>(fn: (_tx: unknown) => Promise<T>): Promise<T> => {
      // Simulate SET LOCAL app.current_tenant via execute
      return fn(self);
    },

    execute: async (_sql: unknown): Promise<unknown[]> => {
      // Simulates SELECT set_config(...) used by withTenant
      return [];
    },
  };

  return self;
}

// ---------------------------------------------------------------------------
// Stub AppAuthClient
// ---------------------------------------------------------------------------

function makeAppAuthClient(): AppAuthClient {
  return {
    getInstallationToken: vi.fn().mockResolvedValue({ token: 'fake-token', expiresAt: new Date() }),
    invalidate: vi.fn().mockResolvedValue(undefined),
    createAppJwt: vi.fn().mockResolvedValue('fake-jwt'),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-01T00:00:00Z');
let idSeq = 0;
function nextId(): string {
  return `id-${++idSeq}`;
}

// Mock the dynamic @octokit/rest import + listInstallationRepos in tests.
// We pass an octokitFactory stub via deps. Rather than relying on ESM mocks,
// we bypass the Octokit path by injecting a custom listInstallationRepos-like
// setup in the appAuth deps. The router's GET handler imports Octokit
// dynamically and calls listInstallationRepos — so we need to stub that path.
//
// Strategy: we mock the module so `listInstallationRepos` resolves with
// whatever the test configures via a module-level vi.mock().

vi.mock('@review-agent/platform-github', async (importOriginal) => {
  const original = await importOriginal<typeof import('@review-agent/platform-github')>();
  return {
    ...original,
    listInstallationRepos: vi.fn(),
  };
});

vi.mock('@octokit/rest', () => {
  class MockOctokit {
    auth: string;
    constructor(opts: { auth: string }) {
      this.auth = opts.auth;
    }
    static plugin(..._plugins: unknown[]) {
      return MockOctokit;
    }
  }
  return { Octokit: MockOctokit };
});

// Re-import after mock to get the vi.fn() instance
const { listInstallationRepos } = await import('@review-agent/platform-github');
const mockedListInstallationRepos = vi.mocked(listInstallationRepos);

// ---------------------------------------------------------------------------
// Tests: GET /github/installations/:installationId/repos
// ---------------------------------------------------------------------------

describe('GET /github/installations/:installationId/repos', () => {
  it('returns 503 when appAuth is not configured', async () => {
    const db = makeDb();
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
    });
    const res = await router.request('http://host/github/installations/42/repos');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('github_app_not_configured');
  });

  it('returns 422 when installationId is not numeric', async () => {
    const db = makeDb();
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      appAuth: { appAuthClient: makeAppAuthClient() },
    });
    const res = await router.request('http://host/github/installations/not-a-number/repos');
    expect(res.status).toBe(422);
  });

  it('returns 404 when installation does not exist in github_installations', async () => {
    const db = makeDb({ installations: [] });
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      appAuth: { appAuthClient: makeAppAuthClient() },
      now: () => NOW,
    });
    const res = await router.request('http://host/github/installations/99/repos');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('not_found');
  });

  it('returns 404 when installation has suspendedAt set', async () => {
    const db = makeDb({
      installations: [{ installationId: 42n, suspendedAt: new Date('2025-01-01T00:00:00Z') }],
    });
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      appAuth: { appAuthClient: makeAppAuthClient() },
    });
    const res = await router.request('http://host/github/installations/42/repos');
    expect(res.status).toBe(404);
  });

  it('returns repos list with registered=false when no repos registered', async () => {
    const db = makeDb({
      installations: [{ installationId: 42n, suspendedAt: null }],
      repos: [],
    });
    mockedListInstallationRepos.mockResolvedValueOnce([
      { id: 1, fullName: 'owner/repo-a', private: false },
      { id: 2, fullName: 'owner/repo-b', private: true },
    ]);
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      appAuth: { appAuthClient: makeAppAuthClient() },
    });
    const res = await router.request('http://host/github/installations/42/repos');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toHaveLength(2);
    expect(body.repos[0]).toEqual({
      id: 1,
      fullName: 'owner/repo-a',
      private: false,
      registered: false,
    });
    expect(body.repos[1]).toEqual({
      id: 2,
      fullName: 'owner/repo-b',
      private: true,
      registered: false,
    });
  });

  it('returns 502 when getInstallationToken throws (GitHub API error)', async () => {
    const db = makeDb({
      installations: [{ installationId: 42n, suspendedAt: null }],
    });
    const appAuthClient = makeAppAuthClient();
    vi.mocked(appAuthClient.getInstallationToken).mockRejectedValueOnce(
      new Error('GitHub API unavailable'),
    );
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      appAuth: { appAuthClient },
    });
    const res = await router.request('http://host/github/installations/42/repos');
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('github_api_error');
    expect(typeof body.message).toBe('string');
  });

  it('returns 200 with empty repos list when GitHub returns no repos', async () => {
    const db = makeDb({
      installations: [{ installationId: 42n, suspendedAt: null }],
      repos: [],
    });
    mockedListInstallationRepos.mockResolvedValueOnce([]);
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      appAuth: { appAuthClient: makeAppAuthClient() },
    });
    const res = await router.request('http://host/github/installations/42/repos');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repos).toEqual([]);
  });

  it('returns registered=true for repos already in the local repos table', async () => {
    const db = makeDb({
      installations: [{ installationId: 42n, suspendedAt: null }],
      repos: [
        {
          id: 'r1',
          platform: 'github',
          name: 'owner/repo-a',
          enabled: true,
          installationId: 42n,
          createdAt: NOW,
          updatedAt: NOW,
          deletedAt: null,
        },
      ],
    });
    mockedListInstallationRepos.mockResolvedValueOnce([
      { id: 1, fullName: 'owner/repo-a', private: false },
      { id: 2, fullName: 'owner/repo-b', private: false },
    ]);
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      appAuth: { appAuthClient: makeAppAuthClient() },
    });
    const res = await router.request('http://host/github/installations/42/repos');
    expect(res.status).toBe(200);
    const body = await res.json();
    const repoA = body.repos.find((r: { fullName: string }) => r.fullName === 'owner/repo-a');
    const repoB = body.repos.find((r: { fullName: string }) => r.fullName === 'owner/repo-b');
    expect(repoA.registered).toBe(true);
    expect(repoB.registered).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: POST /repos/bulk
// ---------------------------------------------------------------------------

describe('POST /repos/bulk', () => {
  it('returns 400 on invalid JSON body', async () => {
    const db = makeDb();
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
    });
    const res = await router.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('returns 422 when names exceeds 100 items', async () => {
    const db = makeDb();
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
    });
    const names = Array.from({ length: 101 }, (_, i) => `owner/repo-${i}`);
    const res = await router.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 42, names }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('validation_error');
  });

  it('returns 422 when a name exceeds 200 characters', async () => {
    const db = makeDb();
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
    });
    const longName = 'a'.repeat(201);
    const res = await router.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 42, names: [longName] }),
    });
    expect(res.status).toBe(422);
  });

  it('returns 201 when all names are newly created', async () => {
    const db = makeDb({ repos: [] });
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      now: () => NOW,
      generateId: nextId,
    });
    const res = await router.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 42, names: ['owner/repo-a', 'owner/repo-b'] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toEqual(['owner/repo-a', 'owner/repo-b']);
    expect(body.alreadyExists).toEqual([]);
    expect(body.errors).toEqual([]);
    // Verify rows were inserted into the store
    expect(db._repos).toHaveLength(2);
    expect(db._repos[0].platform).toBe('github');
    expect(db._repos[0].installationId).toBe(42n);
    expect(db._repos[0].enabled).toBe(true);
  });

  it('returns 200 when all names already exist', async () => {
    const existingRepos: RepoRecord[] = [
      {
        id: 'e1',
        platform: 'github',
        name: 'owner/repo-a',
        enabled: true,
        installationId: 42n,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
      {
        id: 'e2',
        platform: 'github',
        name: 'owner/repo-b',
        enabled: true,
        installationId: 42n,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ];
    const db = makeDb({ repos: existingRepos });
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      now: () => NOW,
      generateId: nextId,
    });
    const res = await router.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 42, names: ['owner/repo-a', 'owner/repo-b'] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyExists).toEqual(['owner/repo-a', 'owner/repo-b']);
    expect(body.created).toEqual([]);
    expect(body.errors).toEqual([]);
  });

  it('returns 207 on partial failure (errors non-empty)', async () => {
    // One name new (will succeed), one name triggers an insert error
    const db = makeDb({ repos: [] });
    let callCount = 0;
    // Override transaction to fail on the second insert
    const origTransaction = db.transaction.bind(db);
    db.transaction = async <T>(fn: (_tx: unknown) => Promise<T>): Promise<T> => {
      callCount++;
      if (callCount === 2) {
        throw new Error('simulated DB error');
      }
      return origTransaction(fn);
    };
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      now: () => NOW,
      generateId: nextId,
    });
    const res = await router.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 42, names: ['owner/repo-a', 'owner/repo-fail'] }),
    });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.created).toEqual(['owner/repo-a']);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].name).toBe('owner/repo-fail');
  });

  it('returns 207 when some names are new and some already exist', async () => {
    const existingRepos: RepoRecord[] = [
      {
        id: 'x1',
        platform: 'github',
        name: 'owner/existing',
        enabled: true,
        installationId: 42n,
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ];
    const db = makeDb({ repos: existingRepos });
    const router = createGithubReposRouter({
      db: db as Parameters<typeof createGithubReposRouter>[0]['db'],
      now: () => NOW,
      generateId: nextId,
    });
    const res = await router.request('http://host/repos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ installationId: 42, names: ['owner/existing', 'owner/new-one'] }),
    });
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body.alreadyExists).toContain('owner/existing');
    expect(body.created).toContain('owner/new-one');
    expect(body.errors).toEqual([]);
  });
});
