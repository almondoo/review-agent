/**
 * Unit tests for operator-principals.ts DB helpers.
 * All Drizzle interactions are mocked via fake chain objects — no real Postgres
 * connection required.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPrincipal,
  deletePrincipal,
  findPrincipalByExternalId,
  getPrincipalByUsername,
  listMemberships,
  listPrincipals,
  revokeMembership,
  setPrincipalPassword,
  upsertMembership,
  upsertOidcPrincipal,
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

  it('inserts an OIDC principal with null passwordHash and provider/externalId', async () => {
    const valuesFn = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { insert: insertFn } as never;

    await createPrincipal(db, {
      id: 'uuid-oidc-1',
      username: 'alice',
      provider: 'google',
      externalId: 'sub-123',
    });

    const arg = valuesFn.mock.calls[0]?.[0];
    expect(arg?.passwordHash).toBeNull();
    expect(arg?.provider).toBe('google');
    expect(arg?.externalId).toBe('sub-123');
  });

  it('defaults provider to "local" and externalId to null when omitted', async () => {
    const valuesFn = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { insert: insertFn } as never;

    await createPrincipal(db, { id: 'uuid-4', username: 'carol', passwordHash: 'h' });

    const arg = valuesFn.mock.calls[0]?.[0];
    expect(arg?.provider).toBe('local');
    expect(arg?.externalId).toBeNull();
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
      { id: 'a', username: 'alice', provider: 'local', tokenVersion: 1, createdAt: now },
      { id: 'b', username: 'bob', provider: 'google', tokenVersion: 2, createdAt: now },
    ];
    const db = makeSelectChain(rows) as never;
    const result = await listPrincipals(db);
    expect(result).toHaveLength(2);
    expect(result[0]?.username).toBe('alice');
    expect(result[0]?.provider).toBe('local');
    expect(result[1]?.provider).toBe('google');
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

// ---------------------------------------------------------------------------
// findPrincipalByExternalId
// ---------------------------------------------------------------------------
describe('findPrincipalByExternalId', () => {
  function makeWhereChain(resolveWith: unknown) {
    const whereFn = vi.fn().mockResolvedValue(resolveWith);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    return { select: selectFn };
  }

  it('returns the principal when found by (provider, externalId)', async () => {
    const db = makeWhereChain([{ id: 'oidc-1', username: 'alice', tokenVersion: 1 }]) as never;
    const result = await findPrincipalByExternalId(db, 'google', 'sub-abc');
    expect(result).toMatchObject({ id: 'oidc-1', username: 'alice', tokenVersion: 1 });
  });

  it('returns null when no principal has that (provider, externalId)', async () => {
    const db = makeWhereChain([]) as never;
    const result = await findPrincipalByExternalId(db, 'google', 'sub-unknown');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// upsertOidcPrincipal
// ---------------------------------------------------------------------------
describe('upsertOidcPrincipal', () => {
  function makeSelectChain(resolveWith: unknown) {
    const whereFn = vi.fn().mockResolvedValue(resolveWith);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    return selectFn;
  }

  it('returns existing principal (created: false) when (provider, externalId) already exists', async () => {
    const existing = { id: 'oidc-old', username: 'alice', tokenVersion: 2 };
    const selectFn = makeSelectChain([existing]);
    const db = { select: selectFn } as never;

    const result = await upsertOidcPrincipal(db, {
      provider: 'google',
      externalId: 'sub-abc',
      username: 'alice',
      id: 'new-id',
    });

    // tokenVersion is passed through from the existing row so the OIDC callback
    // can embed the correct value in the session JWT (sessionAuth re-checks it).
    expect(result).toEqual({ id: 'oidc-old', username: 'alice', tokenVersion: 2, created: false });
  });

  it('inserts a new principal and returns (created: true) when not found', async () => {
    // findPrincipalByExternalId returns [] (not found)
    const selectFn = makeSelectChain([]);
    const valuesFn = vi.fn().mockResolvedValue(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { select: selectFn, insert: insertFn } as never;

    const result = await upsertOidcPrincipal(db, {
      provider: 'google',
      externalId: 'sub-new',
      username: 'bob',
      id: 'uuid-new',
    });

    expect(result).toEqual({ id: 'uuid-new', username: 'bob', tokenVersion: 1, created: true });
    expect(insertFn).toHaveBeenCalledOnce();
    const insertArg = valuesFn.mock.calls[0]?.[0];
    expect(insertArg?.passwordHash).toBeNull();
    expect(insertArg?.provider).toBe('google');
    expect(insertArg?.externalId).toBe('sub-new');
  });

  it('retries with suffixed username when preferred username is taken (23505)', async () => {
    // findPrincipalByExternalId returns [] (not found)
    const selectFn = makeSelectChain([]);
    const valuesFn = vi
      .fn()
      // First insert: username conflict
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }))
      // Second insert (suffixed username): success
      .mockResolvedValueOnce(undefined);
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { select: selectFn, insert: insertFn } as never;

    const result = await upsertOidcPrincipal(db, {
      provider: 'google',
      externalId: 'sub-12345678abcdef',
      username: 'alice',
      id: 'uuid-retry',
    });

    // externalId.toLowerCase().slice(0,8) = 'sub-1234'
    expect(result).toEqual({
      id: 'uuid-retry',
      username: 'alice_sub-1234',
      tokenVersion: 1,
      created: true,
    });
    expect(insertFn).toHaveBeenCalledTimes(2);
    const secondInsertArg = valuesFn.mock.calls[1]?.[0];
    expect(secondInsertArg?.username).toBe('alice_sub-1234');
  });

  it('returns the race winner when a concurrent first-login wins the INSERT (TOCTOU)', async () => {
    // Initial lookup: not found. INSERT loses the race (23505). Re-check by
    // external_id finds the winner → return it (created: false), no suffix retry.
    const whereFn = vi
      .fn()
      .mockResolvedValueOnce([]) // findPrincipalByExternalId → not found
      .mockResolvedValueOnce([{ id: 'winner', username: 'carol', tokenVersion: 1 }]); // re-check → winner
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const valuesFn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { select: selectFn, insert: insertFn } as never;

    const result = await upsertOidcPrincipal(db, {
      provider: 'google',
      externalId: 'sub-race',
      username: 'carol',
      id: 'my-id',
    });

    expect(result).toEqual({ id: 'winner', username: 'carol', tokenVersion: 1, created: false });
    // No suffix retry — the race was detected via the external_id re-check.
    expect(insertFn).toHaveBeenCalledOnce();
  });

  it('propagates non-unique errors from INSERT', async () => {
    const selectFn = makeSelectChain([]);
    const valuesFn = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('connection error'), { code: '08003' }));
    const insertFn = vi.fn().mockReturnValue({ values: valuesFn });
    const db = { select: selectFn, insert: insertFn } as never;

    await expect(
      upsertOidcPrincipal(db, {
        provider: 'google',
        externalId: 'sub-x',
        username: 'charlie',
        id: 'uuid-err',
      }),
    ).rejects.toThrow('connection error');
  });
});
