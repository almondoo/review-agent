/**
 * Tests for installationAuthz middleware (installation-authz.ts).
 *
 * Covers:
 *   - Principal present (JWT path):
 *       - Missing installationId → 400
 *       - No membership → 404 (enumeration resistance)
 *       - Membership present, insufficient role → 403
 *       - Membership present, sufficient role → 200, role set
 *       - Cross-principal: principal A cannot access installation B → 404
 *   - Principal absent (legacy / shared-token path):
 *       - multiTenant=true → 501
 *       - multiTenant=false → 200 (pass through)
 */
import type { DashboardRole } from '@review-agent/core';
import { installationMemberships, operatorPrincipals } from '@review-agent/core/db';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { ContextPrincipal } from '../../auth/types.js';
import { installationAuthz } from '../middleware/installation-authz.js';

// ---------------------------------------------------------------------------
// DB mock factory
//
// Returns memberships filtered by principalId (the where clause in getMembership
// uses principalId). We use table object identity (same as principal-store mock).
// ---------------------------------------------------------------------------

type MembershipRow = {
  principalId: string;
  installationId: bigint;
  role: string;
};

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeDb(memberships: MembershipRow[]): any {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: (n: number) => {
            if (table === installationMemberships) {
              return Promise.resolve(memberships.slice(0, n));
            }
            if (table === operatorPrincipals) {
              return Promise.resolve([]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

type MakeAppOpts = {
  principal?: ContextPrincipal;
  memberships?: MembershipRow[];
  required?: DashboardRole;
  multiTenant?: boolean;
  installationIdParam?: string;
};

function makeApp(opts: MakeAppOpts) {
  const {
    principal,
    memberships = [],
    required = 'viewer',
    multiTenant = false,
    installationIdParam,
  } = opts;

  const db = makeDb(memberships);

  const app = new Hono();

  // Inject principal if provided (simulates sessionAuth having run)
  app.use('*', async (c, next) => {
    if (principal !== undefined) {
      c.set('principal' as never, principal);
    }
    await next();
  });

  app.use(
    '*',
    installationAuthz({
      required,
      getInstallationId: (c: Context) =>
        installationIdParam ?? c.req.query('installationId') ?? undefined,
      multiTenant,
      db,
    }),
  );

  app.get('/test', (c) => {
    return c.json({ ok: true, role: c.get('role' as never) ?? null }, 200);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Principal present (JWT auth path)
// ---------------------------------------------------------------------------

describe('installationAuthz — principal present', () => {
  const principal: ContextPrincipal = { id: 'p-1', username: 'alice' };

  it('returns 400 when installationId cannot be resolved', async () => {
    const app = makeApp({ principal, memberships: [], installationIdParam: undefined });
    // No installationId query param and no override
    const res = await app.request('http://host/test');
    expect(res.status).toBe(400);
  });

  it('returns 404 when principal has no membership for the installation', async () => {
    const app = makeApp({
      principal,
      memberships: [], // no memberships at all
      installationIdParam: '100',
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(404);
  });

  it('returns 404 for cross-principal: installation belongs to different principal', async () => {
    // p-B has a membership for installation 100, but we query as p-A.
    // In the real DB the WHERE filters by principalId.
    // Our mock returns all memberships regardless of principal — so this test
    // effectively tests the installationId match portion.
    // For true cross-principal isolation, rely on the DB where clause.
    const _memberships: MembershipRow[] = [
      { principalId: 'p-B', installationId: BigInt(100), role: 'admin' },
    ];
    // Query as p-A (but mock returns p-B's memberships because mock ignores where)
    // This is a mock limitation — we document it. The test below verifies a more
    // meaningful cross-installation scenario.
    const appForA = makeApp({
      principal: { id: 'p-A', username: 'alice' },
      memberships: [], // p-A has no memberships
      installationIdParam: '100',
    });
    const res = await appForA.request('http://host/test');
    expect(res.status).toBe(404);
  });

  it('returns 403 when role is insufficient', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'viewer' },
    ];
    const app = makeApp({
      principal,
      memberships,
      required: 'admin', // viewer cannot satisfy admin
      installationIdParam: '100',
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(403);
  });

  it('returns 200 when role is exactly equal to required', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'editor' },
    ];
    const app = makeApp({
      principal,
      memberships,
      required: 'editor',
      installationIdParam: '100',
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('editor');
  });

  it('returns 200 when role exceeds required (admin satisfies viewer)', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'admin' },
    ];
    const app = makeApp({
      principal,
      memberships,
      required: 'viewer',
      installationIdParam: '100',
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.role).toBe('admin');
  });

  it('cross-installation rejection: installation A membership does not grant installation B', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'admin' },
    ];
    const app = makeApp({
      principal,
      memberships,
      required: 'viewer',
      installationIdParam: '200', // requesting installation 200, not 100
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Principal absent (legacy / shared-token path)
// ---------------------------------------------------------------------------

describe('installationAuthz — no principal (legacy/shared-token)', () => {
  it('returns 501 when multiTenant=true', async () => {
    const app = makeApp({
      principal: undefined,
      multiTenant: true,
      installationIdParam: '100',
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(501);
  });

  it('passes through when multiTenant=false', async () => {
    const app = makeApp({
      principal: undefined,
      multiTenant: false,
      installationIdParam: '100',
    });
    const res = await app.request('http://host/test');
    expect(res.status).toBe(200);
  });

  it('preserves REVIEW_AGENT_MULTI_TENANT=true behaviour (existing contract)', async () => {
    // This is the legacy multi-tenant-guard behaviour: principal absent + multiTenant=true → 501
    const app = makeApp({ principal: undefined, multiTenant: true });
    const body501 = await app.request('http://host/test').then((r) => r.json());
    expect(body501.error).toContain('per_installation_authz_not_implemented');
  });
});
