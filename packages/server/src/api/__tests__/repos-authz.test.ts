/**
 * Repos endpoint authorization tests (issue #161 §F, corrected).
 *
 * Tests the repos router directly (createReposRouter) with an in-memory mock
 * DB that supports both repos queries and membership queries.
 *
 * Covers:
 *   - Session mode: admin / viewer / editor role enforcement per endpoint.
 *   - List filtering: only repos with installation_id ∈ caller memberships OR null.
 *   - Cross-installation: principal from installation A cannot read/mutate repo of B → 404.
 *   - null-installation repos: visible to any authenticated user; mutations require
 *     maxRole ≥ required.
 *   - Legacy regression: no principal → all repos visible, mutations pass-through.
 */
import { installationMemberships, operatorPrincipals, repos } from '@review-agent/core/db';
import type { AuditAppender } from '@review-agent/db';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { issueSessionToken } from '../../auth/jwt.js';
import { sessionAuth } from '../../auth/session-auth.js';
import type { AuthEnv } from '../../auth/types.js';
import { createReposRouter } from '../repos.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_SECRET = 'a-test-secret-that-is-at-least-32-chars!!';
const INSTALLATION_A = BigInt(100);
const INSTALLATION_B = BigInt(200);

const ADMIN_PRINCIPAL = { id: 'p-admin', username: 'admin', tokenVersion: 1 };
const VIEWER_PRINCIPAL = { id: 'p-viewer', username: 'viewer', tokenVersion: 1 };
const EDITOR_PRINCIPAL = { id: 'p-editor', username: 'editor', tokenVersion: 1 };

// ---------------------------------------------------------------------------
// DB row types
// ---------------------------------------------------------------------------

type RepoRow = {
  id: string;
  platform: 'github' | 'codecommit';
  name: string;
  enabled: boolean;
  installationId: bigint | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  systemPrompt: string | null;
  systemPromptUpdatedAt: Date | null;
};

type MembershipRow = { principalId: string; installationId: bigint; role: string };
type PrincipalRow = { id: string; username: string; passwordHash: string; tokenVersion: number };

// ---------------------------------------------------------------------------
// DB mock factory
// ---------------------------------------------------------------------------

const NOW = new Date('2026-01-01T00:00:00Z');

/**
 * Build a DB mock that handles:
 *   - repos table queries (select, insert, update)
 *   - installationMemberships queries
 *   - operatorPrincipals queries (for sessionAuth's tokenVersion check)
 */
function makeDb(
  initialRepos: RepoRow[],
  memberships: MembershipRow[],
  principals: PrincipalRow[] = [],
  // biome-ignore lint/suspicious/noExplicitAny: test mock
): any {
  // Shallow-copy each row so mutations in tests don't affect shared fixture objects.
  const repoStore: RepoRow[] = initialRepos.map((r) => ({ ...r }));
  return {
    select: (_fields?: unknown) => ({
      from: (table: unknown) => ({
        where: (_cond?: unknown) => {
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
          if (table === repos) {
            const active = repoStore.filter((r) => r.deletedAt === null);
            return chainable(active);
          }
          if (table === installationMemberships) {
            return chainable(memberships);
          }
          if (table === operatorPrincipals) {
            return chainable(principals);
          }
          return chainable([]);
        },
        orderBy: (..._a: unknown[]) => Promise.resolve([]),
      }),
    }),
    insert: () => ({
      values: (row: RepoRow) => {
        repoStore.push({ ...row });
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (patch: Partial<RepoRow>) => ({
        where: () => {
          for (const r of repoStore) {
            Object.assign(r, patch);
          }
          return Promise.resolve();
        },
      }),
    }),
    // withTenant calls db.transaction(); return empty event arrays so tests that
    // don't care about review-event enrichment still get 200 back.
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
// App factory
//
// Wraps the repos router with sessionAuth so principal is injected from a JWT.
// ---------------------------------------------------------------------------

function makeApp(
  repoStore: RepoRow[],
  memberships: MembershipRow[],
  principals: PrincipalRow[] = [],
) {
  const db = makeDb(repoStore, memberships, principals);

  const api = new Hono<AuthEnv>();
  api.use(
    '*',
    sessionAuth({
      authMode: 'session',
      sharedToken: undefined,
      sessionSecret: SESSION_SECRET,
      db,
    }),
  );
  api.route(
    '/repos',
    createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
      generateId: () => `new-id-${Date.now()}`,
    }),
  );
  return api;
}

function makeLegacyApp(repoStore: RepoRow[], memberships: MembershipRow[] = []) {
  const db = makeDb(repoStore, memberships);
  const api = new Hono<AuthEnv>();
  // No sessionAuth — legacy path (no principal)
  api.route(
    '/repos',
    createReposRouter({
      // biome-ignore lint/suspicious/noExplicitAny: test mock
      db: db as any,
      now: () => NOW,
    }),
  );
  return api;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

async function adminJwt() {
  return issueSessionToken(
    {
      principalId: ADMIN_PRINCIPAL.id,
      username: ADMIN_PRINCIPAL.username,
      tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
    },
    SESSION_SECRET,
    3600,
  );
}

async function viewerJwt() {
  return issueSessionToken(
    {
      principalId: VIEWER_PRINCIPAL.id,
      username: VIEWER_PRINCIPAL.username,
      tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
    },
    SESSION_SECRET,
    3600,
  );
}

async function editorJwt() {
  return issueSessionToken(
    {
      principalId: EDITOR_PRINCIPAL.id,
      username: EDITOR_PRINCIPAL.username,
      tokenVersion: EDITOR_PRINCIPAL.tokenVersion,
    },
    SESSION_SECRET,
    3600,
  );
}

// ---------------------------------------------------------------------------
// Standard fixtures
// ---------------------------------------------------------------------------

const PRINCIPAL_ROWS: PrincipalRow[] = [
  {
    id: ADMIN_PRINCIPAL.id,
    username: ADMIN_PRINCIPAL.username,
    passwordHash: 'x',
    tokenVersion: ADMIN_PRINCIPAL.tokenVersion,
  },
  {
    id: VIEWER_PRINCIPAL.id,
    username: VIEWER_PRINCIPAL.username,
    passwordHash: 'x',
    tokenVersion: VIEWER_PRINCIPAL.tokenVersion,
  },
  {
    id: EDITOR_PRINCIPAL.id,
    username: EDITOR_PRINCIPAL.username,
    passwordHash: 'x',
    tokenVersion: EDITOR_PRINCIPAL.tokenVersion,
  },
];

/** Repo belonging to installation A */
const REPO_A: RepoRow = {
  id: 'repo-a',
  platform: 'github',
  name: 'org/repo-a',
  enabled: true,
  installationId: INSTALLATION_A,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  systemPrompt: null,
  systemPromptUpdatedAt: null,
};

/** Repo belonging to installation B */
const REPO_B: RepoRow = {
  id: 'repo-b',
  platform: 'github',
  name: 'org/repo-b',
  enabled: true,
  installationId: INSTALLATION_B,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  systemPrompt: null,
  systemPromptUpdatedAt: null,
};

/** Repo with no installation (manually registered) */
const REPO_NULL: RepoRow = {
  id: 'repo-null',
  platform: 'github',
  name: 'org/repo-null',
  enabled: true,
  installationId: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  systemPrompt: null,
  systemPromptUpdatedAt: null,
};

const ADMIN_MEMBERSHIP_A: MembershipRow = {
  principalId: ADMIN_PRINCIPAL.id,
  installationId: INSTALLATION_A,
  role: 'admin',
};
const VIEWER_MEMBERSHIP_A: MembershipRow = {
  principalId: VIEWER_PRINCIPAL.id,
  installationId: INSTALLATION_A,
  role: 'viewer',
};
const EDITOR_MEMBERSHIP_A: MembershipRow = {
  principalId: EDITOR_PRINCIPAL.id,
  installationId: INSTALLATION_A,
  role: 'editor',
};

const JSON_CT = { 'Content-Type': 'application/json' };

// ===========================================================================
// GET /repos — list filtering
// ===========================================================================

describe('GET /repos — list filtering (session mode)', () => {
  it('admin sees repos from their installation + null repos, not others', async () => {
    const app = makeApp([REPO_A, REPO_B, REPO_NULL], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.map((r: { id: string }) => r.id);
    expect(ids).toContain('repo-a'); // their installation
    expect(ids).toContain('repo-null'); // null installation always visible
    expect(ids).not.toContain('repo-b'); // different installation
  });

  it('viewer sees only their installation repos + null repos', async () => {
    const app = makeApp([REPO_A, REPO_B, REPO_NULL], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.map((r: { id: string }) => r.id);
    expect(ids).toContain('repo-a');
    expect(ids).toContain('repo-null');
    expect(ids).not.toContain('repo-b');
  });

  it('principal with no memberships sees only null-installation repos', async () => {
    const app = makeApp([REPO_A, REPO_B, REPO_NULL], [], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.map((r: { id: string }) => r.id);
    expect(ids).toEqual(['repo-null']); // only null-installation repo
  });
});

// ===========================================================================
// GET /repos/:id — single repo access control
// ===========================================================================

describe('GET /repos/:id — single repo access (session mode)', () => {
  it('admin with membership for installation A can GET repo-a → 200', async () => {
    const app = makeApp([REPO_A], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-a', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
  });

  it('cross-installation: admin from installation A requests repo-b (B) → 404', async () => {
    // Store only REPO_B so the mock returns it (mock ignores WHERE id= condition).
    const app = makeApp([REPO_B], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-b', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });

  it('authenticated user can GET null-installation repo → 200', async () => {
    const app = makeApp([REPO_NULL], [], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-null', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Mutation role enforcement
// ===========================================================================

describe('PATCH /repos/:id — admin required', () => {
  it('viewer cannot PATCH repo → 403', async () => {
    const app = makeApp([REPO_A], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-a', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it('editor cannot PATCH repo → 403', async () => {
    const app = makeApp([REPO_A], [EDITOR_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await editorJwt();
    const res = await app.request('http://host/repos/repo-a', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it('admin can PATCH repo → 200', async () => {
    const app = makeApp([REPO_A], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-a', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });

  it('cross-installation: admin of A cannot PATCH repo-b (B) → 404', async () => {
    // Store only REPO_B so the mock returns it.
    const app = makeApp([REPO_B], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-b', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /repos/:id — admin required', () => {
  it('viewer cannot DELETE repo → 403', async () => {
    const app = makeApp([REPO_A], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-a', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(403);
  });

  it('admin can DELETE repo → 204', async () => {
    const app = makeApp([REPO_A], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-a', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(204);
  });

  it('cross-installation: admin of A cannot DELETE repo-b (B) → 404', async () => {
    // Store only REPO_B so the mock returns it.
    const app = makeApp([REPO_B], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-b', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('PUT /repos/:id/prompt — editor required', () => {
  it('viewer cannot PUT prompt → 403', async () => {
    const app = makeApp([REPO_A], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-a/prompt', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ systemPrompt: 'hello' }),
    });
    expect(res.status).toBe(403);
  });

  it('editor can PUT prompt → 200', async () => {
    const app = makeApp([REPO_A], [EDITOR_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await editorJwt();
    const res = await app.request('http://host/repos/repo-a/prompt', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ systemPrompt: 'custom prompt' }),
    });
    expect(res.status).toBe(200);
  });

  it('admin can PUT prompt → 200', async () => {
    const app = makeApp([REPO_A], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-a/prompt', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ systemPrompt: 'custom prompt' }),
    });
    expect(res.status).toBe(200);
  });

  it('cross-installation: editor of A cannot PUT prompt for repo-b (B) → 404', async () => {
    // Store only REPO_B so the mock returns it.
    const app = makeApp([REPO_B], [EDITOR_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await editorJwt();
    const res = await app.request('http://host/repos/repo-b/prompt', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ systemPrompt: 'custom prompt' }),
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// null-installation repos
// ===========================================================================

describe('null-installation repos', () => {
  it('admin with any membership can mutate null-installation repo → 200', async () => {
    const app = makeApp([{ ...REPO_NULL }], [ADMIN_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-null', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });

  it('viewer cannot mutate null-installation repo → 403', async () => {
    const app = makeApp([REPO_NULL], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-null', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it('principal with no memberships cannot mutate null-installation repo → 403', async () => {
    const app = makeApp([REPO_NULL], [], PRINCIPAL_ROWS);
    const jwt = await adminJwt();
    const res = await app.request('http://host/repos/repo-null', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(403);
  });

  it('editor can PUT prompt on null-installation repo → 200', async () => {
    const app = makeApp([{ ...REPO_NULL }], [EDITOR_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await editorJwt();
    const res = await app.request('http://host/repos/repo-null/prompt', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${jwt}`, ...JSON_CT },
      body: JSON.stringify({ systemPrompt: 'test' }),
    });
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Legacy regression — principal absent → all routes pass through unchanged
// ===========================================================================

describe('legacy regression — no principal', () => {
  it('GET /repos returns all repos (no filtering)', async () => {
    const app = makeLegacyApp([REPO_A, REPO_B, REPO_NULL]);
    const res = await app.request('http://host/repos');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(3);
  });

  it('GET /repos/:id returns any repo regardless of installation', async () => {
    const app = makeLegacyApp([REPO_B]);
    const res = await app.request('http://host/repos/repo-b');
    expect(res.status).toBe(200);
  });

  it('PATCH /repos/:id succeeds without auth check', async () => {
    const app = makeLegacyApp([REPO_A]);
    const res = await app.request('http://host/repos/repo-a', {
      method: 'PATCH',
      headers: JSON_CT,
      body: JSON.stringify({ enabled: false }),
    });
    expect(res.status).toBe(200);
  });

  it('DELETE /repos/:id succeeds without auth check', async () => {
    const app = makeLegacyApp([REPO_A]);
    const res = await app.request('http://host/repos/repo-a', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });

  it('PUT /repos/:id/prompt succeeds without auth check', async () => {
    const app = makeLegacyApp([REPO_A]);
    const res = await app.request('http://host/repos/repo-a/prompt', {
      method: 'PUT',
      headers: JSON_CT,
      body: JSON.stringify({ systemPrompt: 'hello' }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Audit + actor integration (session mode)
// ---------------------------------------------------------------------------

describe('repos router — audit actor is populated from JWT principal', () => {
  type AuditRecord = Parameters<AuditAppender>[0];

  function fakeAuditAppender(): { appender: AuditAppender; records: AuditRecord[] } {
    const records: AuditRecord[] = [];
    const appender: AuditAppender = vi.fn(async (ev) => {
      records.push(ev);
      return { ...ev, ts: new Date(), prevHash: '0'.repeat(64), hash: '0'.repeat(64) };
    });
    return { appender, records };
  }

  /** Admin membership for null-installation repos. */
  const NULL_INSTALL_MEMBERSHIPS: MembershipRow[] = [
    { principalId: ADMIN_PRINCIPAL.id, installationId: INSTALLATION_A, role: 'admin' },
  ];

  it('POST /repos includes actor=principal.id in audit when authenticated', async () => {
    const db = makeDb([], NULL_INSTALL_MEMBERSHIPS, PRINCIPAL_ROWS);
    const { appender, records } = fakeAuditAppender();
    const api = new Hono<AuthEnv>();
    api.use(
      '*',
      sessionAuth({
        authMode: 'session',
        sharedToken: undefined,
        sessionSecret: SESSION_SECRET,
        db,
      }),
    );
    api.route(
      '/repos',
      createReposRouter({
        // biome-ignore lint/suspicious/noExplicitAny: test mock
        db: db as any,
        now: () => NOW,
        generateId: () => 'audit-actor-test',
        auditAppender: appender,
      }),
    );
    const token = await adminJwt();
    const res = await api.request('http://host/repos', {
      method: 'POST',
      headers: { ...JSON_CT, Authorization: `Bearer ${token}` },
      body: JSON.stringify({ platform: 'github', name: 'org/actor-test' }),
    });
    expect(res.status).toBe(201);
    expect(records).toHaveLength(1);
    // actor must be the principal ID, not null
    expect(records[0]?.actor).toBe(ADMIN_PRINCIPAL.id);
  });
});

// ===========================================================================
// Session-mode: GET /repos/:id/reviews, GET /repos/:id/metrics,
//               GET /repos/:id/prompt — principal branch coverage
// ===========================================================================
// These tests verify that the `if (principal !== undefined)` branches in
// each of those handlers are exercised (lines 634, 762, 524 in repos.ts).

describe('GET /repos/:id/reviews — session mode', () => {
  it('viewer with membership can GET /:id/reviews → 200', async () => {
    // Exercises the principal !== undefined branch (line 634 in repos.ts)
    // and the checkRepoAccess ok=true path.
    const app = makeApp([REPO_A], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-a/reviews', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('cross-installation: viewer of A cannot GET /:id/reviews for repo-b → 404', async () => {
    // Exercises the checkRepoAccess not-ok path in the reviews handler (line 637-639).
    const app = makeApp([REPO_B], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-b/reviews', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /repos/:id/metrics — session mode', () => {
  it('viewer with membership can GET /:id/metrics → 200', async () => {
    // Exercises the principal !== undefined branch (line 762 in repos.ts).
    const app = makeApp([REPO_A], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-a/metrics', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.totalReviews).toBe('number');
  });

  it('cross-installation: viewer of A cannot GET /:id/metrics for repo-b → 404', async () => {
    // Exercises the checkRepoAccess not-ok path in the metrics handler (line 765-767).
    const app = makeApp([REPO_B], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-b/metrics', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /repos/:id/prompt — session mode', () => {
  it('viewer with membership can GET /:id/prompt → 200', async () => {
    // Exercises the principal !== undefined branch (line 524 in repos.ts).
    const app = makeApp([REPO_A], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-a/prompt', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.systemPrompt).toBe('string');
  });

  it('cross-installation: viewer of A cannot GET /:id/prompt for repo-b → 404', async () => {
    // Exercises the checkRepoAccess not-ok path in the GET /:id/prompt handler.
    const app = makeApp([REPO_B], [VIEWER_MEMBERSHIP_A], PRINCIPAL_ROWS);
    const jwt = await viewerJwt();
    const res = await app.request('http://host/repos/repo-b/prompt', {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    expect(res.status).toBe(404);
  });
});
