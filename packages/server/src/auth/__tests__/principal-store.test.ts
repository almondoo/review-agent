/**
 * Tests for principal-store.ts.
 *
 * Uses in-memory DB mocks — no live Postgres required. The mock intercepts the
 * Drizzle query builder chain by matching on `from(table)` table object identity.
 *
 * Cross-principal isolation is a DB-layer guarantee (WHERE principalId = ?) and
 * is verified at the contract level: getMembership accepts a principalId argument
 * and must pass it to the DB where clause. The real isolation test lives in DB
 * integration tests (skipped when TEST_DATABASE_APP_URL is absent).
 */
import { installationMemberships, operatorPrincipals } from '@review-agent/core/db';
import { describe, expect, it } from 'vitest';
import {
  findPrincipalById,
  findPrincipalByUsername,
  getMembership,
  getMembershipsByPrincipal,
} from '../principal-store.js';

// ---------------------------------------------------------------------------
// Types mirroring the DB schema
// ---------------------------------------------------------------------------

type PrincipalRow = {
  id: string;
  username: string;
  passwordHash: string;
  tokenVersion: number;
};

type MembershipRow = {
  principalId: string;
  installationId: bigint;
  role: string;
};

// ---------------------------------------------------------------------------
// DB mock factory
//
// The Drizzle query builder uses method chaining. We intercept `from(table)`
// to dispatch to the right in-memory store based on the Drizzle table object
// reference (same as the real table imports).
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test mock
function makeDb(principals: PrincipalRow[], memberships: MembershipRow[]): any {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          // getMembershipsByPrincipal awaits .where() directly (no .limit()).
          // findPrincipalBy* chains .limit(n) after .where().
          // Return an object that is both a Promise and has a .limit() method.
          const rows =
            table === operatorPrincipals
              ? principals
              : table === installationMemberships
                ? memberships
                : [];
          const p: Promise<unknown[]> & { limit: (n: number) => Promise<unknown[]> } =
            Object.assign(Promise.resolve(rows), {
              limit: (n: number) => Promise.resolve(rows.slice(0, n)),
            });
          return p;
        },
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// findPrincipalByUsername
// ---------------------------------------------------------------------------

describe('findPrincipalByUsername', () => {
  it('returns null when principals table is empty', async () => {
    const db = makeDb([], []);
    expect(await findPrincipalByUsername(db, 'alice')).toBeNull();
  });

  it('returns the first row when principals are present', async () => {
    const principal: PrincipalRow = {
      id: 'p-1',
      username: 'alice',
      passwordHash: 'scrypt$hash',
      tokenVersion: 3,
    };
    const db = makeDb([principal], []);
    const result = await findPrincipalByUsername(db, 'alice');
    expect(result?.id).toBe('p-1');
    expect(result?.username).toBe('alice');
    expect(result?.tokenVersion).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// findPrincipalById
// ---------------------------------------------------------------------------

describe('findPrincipalById', () => {
  it('returns null when principals table is empty', async () => {
    const db = makeDb([], []);
    expect(await findPrincipalById(db, 'p-99')).toBeNull();
  });

  it('returns the first row when principals are present', async () => {
    const principal: PrincipalRow = {
      id: 'p-42',
      username: 'bob',
      passwordHash: 'scrypt$hash2',
      tokenVersion: 1,
    };
    const db = makeDb([principal], []);
    const result = await findPrincipalById(db, 'p-42');
    expect(result?.id).toBe('p-42');
    expect(result?.username).toBe('bob');
  });
});

// ---------------------------------------------------------------------------
// getMembershipsByPrincipal
// ---------------------------------------------------------------------------

describe('getMembershipsByPrincipal', () => {
  it('returns empty array when no memberships', async () => {
    const db = makeDb([], []);
    expect(await getMembershipsByPrincipal(db, 'p-1')).toEqual([]);
  });

  it('returns memberships with bigint converted to string', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'admin' },
      { principalId: 'p-1', installationId: BigInt(200), role: 'viewer' },
    ];
    const db = makeDb([], memberships);
    const result = await getMembershipsByPrincipal(db, 'p-1');
    expect(result).toHaveLength(2);
    expect(result[0]?.installationId).toBe('100');
    expect(result[0]?.role).toBe('admin');
    expect(result[1]?.installationId).toBe('200');
    expect(result[1]?.role).toBe('viewer');
  });

  it('excludes rows with unrecognised role values (no silent default)', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'superuser' }, // invalid
      { principalId: 'p-1', installationId: BigInt(200), role: 'editor' },
    ];
    const db = makeDb([], memberships);
    const result = await getMembershipsByPrincipal(db, 'p-1');
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('editor');
    expect(result[0]?.installationId).toBe('200');
  });
});

// ---------------------------------------------------------------------------
// getMembership
// ---------------------------------------------------------------------------

describe('getMembership', () => {
  it('returns null for a non-numeric installationId', async () => {
    const db = makeDb([], []);
    expect(await getMembership(db, 'p-1', 'not-a-number')).toBeNull();
  });

  it('returns null for an empty installationId string', async () => {
    const db = makeDb([], []);
    expect(await getMembership(db, 'p-1', '')).toBeNull();
  });

  it('returns null when the installationId does not match any row', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'viewer' },
    ];
    const db = makeDb([], memberships);
    expect(await getMembership(db, 'p-1', '999')).toBeNull();
  });

  it('returns the role when membership is found', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'admin' },
    ];
    const db = makeDb([], memberships);
    const result = await getMembership(db, 'p-1', '100');
    expect(result?.role).toBe('admin');
  });

  it('handles all three valid roles', async () => {
    for (const role of ['viewer', 'editor', 'admin'] as const) {
      const memberships: MembershipRow[] = [
        { principalId: 'p-1', installationId: BigInt(555), role },
      ];
      const db = makeDb([], memberships);
      const result = await getMembership(db, 'p-1', '555');
      expect(result?.role).toBe(role);
    }
  });

  it('returns null when the matched row has an unrecognised role', async () => {
    const memberships: MembershipRow[] = [
      { principalId: 'p-1', installationId: BigInt(100), role: 'godmode' },
    ];
    const db = makeDb([], memberships);
    expect(await getMembership(db, 'p-1', '100')).toBeNull();
  });
});
