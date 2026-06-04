/**
 * Unit tests for operator-principals.ts DB helpers.
 * All Drizzle interactions are mocked via fake chain objects — no real Postgres
 * connection required.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPrincipal,
  deletePrincipal,
  getPrincipalByUsername,
  listMemberships,
  listPrincipals,
  revokeMembership,
  setPrincipalPassword,
  upsertMembership,
} from '../operator-principals.js';

// ---------------------------------------------------------------------------
// createPrincipal
// ---------------------------------------------------------------------------
describe('createPrincipal', () => {
  it('inserts a principal row', async () => {
    const valuesFn = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { insert: insertFn } as never;

    await createPrincipal(db, {
      id: 'uuid-1',
      username: 'alice',
      passwordHash: 'scrypt$...',
    });

    expect(insertFn).toHaveBeenCalledOnce();
    const arg = valuesFn.mock.calls[0]?.[0];
    expect(arg).toMatchObject({ id: 'uuid-1', username: 'alice', passwordHash: 'scrypt$...' });
  });

  it('converts a unique-constraint violation (code 23505) to a readable error', async () => {
    const valuesFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { insert: insertFn } as never;

    await expect(
      createPrincipal(db, { id: 'uuid-2', username: 'alice', passwordHash: 'h' }),
    ).rejects.toThrow("Username 'alice' is already taken.");
  });

  it('re-throws non-unique errors unchanged', async () => {
    const cause = Object.assign(new Error('something else'), { code: '08003' });
    const valuesFn = vi.fn().mockRejectedValue(cause);
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { insert: insertFn } as never;

    await expect(
      createPrincipal(db, { id: 'uuid-3', username: 'bob', passwordHash: 'h' }),
    ).rejects.toThrow('something else');
  });
});

// ---------------------------------------------------------------------------
// listPrincipals
// ---------------------------------------------------------------------------
describe('listPrincipals', () => {
  function makeSelectChain(resolveWith: unknown) {
    const orderByFn = vi.fn().mockResolvedValue(resolveWith);
    const fromFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    return { select: selectFn };
  }

  it('returns rows ordered by username', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const rows = [
      { id: 'a', username: 'alice', tokenVersion: 1, createdAt: now },
      { id: 'b', username: 'bob', tokenVersion: 2, createdAt: now },
    ];
    const db = makeSelectChain(rows) as never;
    const result = await listPrincipals(db);
    expect(result).toHaveLength(2);
    expect(result[0]?.username).toBe('alice');
  });

  it('returns an empty array when no principals exist', async () => {
    const db = makeSelectChain([]) as never;
    const result = await listPrincipals(db);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getPrincipalByUsername
// ---------------------------------------------------------------------------
describe('getPrincipalByUsername', () => {
  function makeWhereChain(resolveWith: unknown) {
    const whereFn = vi.fn().mockResolvedValue(resolveWith);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    return { select: selectFn };
  }

  it('returns the principal when found', async () => {
    const db = makeWhereChain([{ id: 'a', username: 'alice', tokenVersion: 1 }]) as never;
    const result = await getPrincipalByUsername(db, 'alice');
    expect(result).toMatchObject({ id: 'a', username: 'alice', tokenVersion: 1 });
  });

  it('returns null when not found', async () => {
    const db = makeWhereChain([]) as never;
    const result = await getPrincipalByUsername(db, 'nobody');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// setPrincipalPassword
// ---------------------------------------------------------------------------
describe('setPrincipalPassword', () => {
  it('updates password hash and bumps tokenVersion', async () => {
    const whereFn = vi.fn().mockResolvedValue(undefined);
    const setFn = vi.fn().mockReturnValue({ where: whereFn });
    const updateFn = vi.fn().mockReturnValue({ set: setFn });
    const db = { update: updateFn } as never;

    await setPrincipalPassword(db, 'uuid-1', 'new-hash');

    expect(updateFn).toHaveBeenCalledOnce();
    const setArg = setFn.mock.calls[0]?.[0];
    // passwordHash is updated
    expect(setArg?.passwordHash).toBe('new-hash');
    // tokenVersion uses a SQL expression (truthy object), not a literal
    expect(setArg?.tokenVersion).toBeTruthy();
    expect(setArg?.updatedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// deletePrincipal
// ---------------------------------------------------------------------------
describe('deletePrincipal', () => {
  it('executes a delete by principal id', async () => {
    const whereFn = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: whereFn });
    const db = { delete: deleteFn } as never;

    await deletePrincipal(db, 'uuid-1');

    expect(deleteFn).toHaveBeenCalledOnce();
    expect(whereFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// upsertMembership
// ---------------------------------------------------------------------------
describe('upsertMembership', () => {
  it('inserts and resolves conflict with onConflictDoUpdate', async () => {
    const onConflictFn = vi.fn().mockResolvedValue(undefined);
    const valuesFn = vi.fn().mockReturnValue({ onConflictDoUpdate: onConflictFn });
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { insert: insertFn } as never;

    await upsertMembership(db, 'p-1', '12345', 'editor');

    expect(insertFn).toHaveBeenCalledOnce();
    const valArg = valuesFn.mock.calls[0]?.[0];
    expect(valArg?.principalId).toBe('p-1');
    expect(valArg?.installationId).toBe(12345n);
    expect(valArg?.role).toBe('editor');
    expect(onConflictFn).toHaveBeenCalledOnce();
  });

  it('throws a Zod error for an invalid role', async () => {
    const db = {} as never;
    await expect(upsertMembership(db, 'p-1', '123', 'superuser' as never)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// revokeMembership
// ---------------------------------------------------------------------------
describe('revokeMembership', () => {
  it('deletes the membership row', async () => {
    const whereFn = vi.fn().mockResolvedValue(undefined);
    const deleteFn = vi.fn().mockReturnValue({ where: whereFn });
    const db = { delete: deleteFn } as never;

    await revokeMembership(db, 'p-1', '12345');

    expect(deleteFn).toHaveBeenCalledOnce();
    expect(whereFn).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// listMemberships
// ---------------------------------------------------------------------------
describe('listMemberships', () => {
  function makeWhereChain(resolveWith: unknown) {
    const orderByFn = vi.fn().mockResolvedValue(resolveWith);
    const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    return { select: selectFn };
  }

  it('maps rows and converts installationId to string', async () => {
    const raw = [
      { installationId: 100n, role: 'viewer' },
      { installationId: 200n, role: 'admin' },
    ];
    const db = makeWhereChain(raw) as never;
    const rows = await listMemberships(db, 'p-1');

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ installationId: '100', role: 'viewer' });
    expect(rows[1]).toEqual({ installationId: '200', role: 'admin' });
  });

  it('returns an empty array when the principal has no memberships', async () => {
    const db = makeWhereChain([]) as never;
    const rows = await listMemberships(db, 'p-2');
    expect(rows).toHaveLength(0);
  });

  it('throws when a stored role value is not a valid DashboardRole', async () => {
    const raw = [{ installationId: 10n, role: 'invalid' }];
    const db = makeWhereChain(raw) as never;
    await expect(listMemberships(db, 'p-3')).rejects.toThrow();
  });
});
