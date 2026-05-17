import { type SQL, StringChunk } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { TENANT_GUC, withTenant } from './tenancy.js';

type FakeTx = { execute: ReturnType<typeof vi.fn> };

function fakeDb() {
  const tx: FakeTx = { execute: vi.fn().mockResolvedValue([]) };
  const transaction = vi.fn(async (fn: (tx: FakeTx) => Promise<unknown>) => fn(tx));
  return { db: { transaction } as unknown as Parameters<typeof withTenant>[0], tx, transaction };
}

function lastExecuteCall(tx: FakeTx): SQL {
  const call = tx.execute.mock.calls[0];
  if (!call) {
    throw new Error('tx.execute was not called');
  }
  return call[0] as SQL;
}

// Joins every StringChunk in a Drizzle SQL object — i.e. the parts of
// the query that are inlined into the SQL text literally. Anything that
// would appear here is attacker-influenceable.
function rawSqlText(stmt: SQL): string {
  return stmt.queryChunks
    .filter((c): c is StringChunk => c instanceof StringChunk)
    .flatMap((c) => c.value)
    .join('');
}

// Pulls out the chunks that are NOT StringChunks. The `sql` tagged
// template pushes interpolated values straight onto `queryChunks`; the
// query builder converts them into driver-bound parameters at render
// time (see drizzle-orm/sql/sql.js — non-StringChunk values flow into
// `escapeParam(...)` with the value pushed into `params`). For our
// purposes that means: anything here goes through libpq's prepared-
// statement protocol and can never be parsed as SQL.
function boundParamValues(stmt: SQL): unknown[] {
  return stmt.queryChunks.filter((c) => !(c instanceof StringChunk));
}

describe('withTenant', () => {
  it('opens a transaction, sets the tenant GUC via set_config, then runs the callback', async () => {
    const { db, tx, transaction } = fakeDb();
    const result = await withTenant(db, 12345n, async (scopedTx) => {
      expect(scopedTx).toBe(tx);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);

    const stmt = lastExecuteCall(tx);
    expect(rawSqlText(stmt)).toMatch(/select\s+set_config\s*\(/i);
    expect(boundParamValues(stmt)).toEqual([TENANT_GUC, '12345']);
  });

  it('accepts numeric installationId by stringifying', async () => {
    const { db, tx } = fakeDb();
    await withTenant(db, 7, async () => undefined);
    const stmt = lastExecuteCall(tx);
    expect(boundParamValues(stmt)).toEqual([TENANT_GUC, '7']);
  });

  it('binds the tenant id as a parameter rather than interpolating it into raw SQL', async () => {
    // Defence-in-depth: if anyone ever weakens the regex above, the
    // value still cannot become SQL because it travels through libpq's
    // prepared-statement protocol.
    const { db, tx } = fakeDb();
    await withTenant(db, 12345n, async () => undefined);
    const stmt = lastExecuteCall(tx);
    expect(rawSqlText(stmt)).not.toContain('12345');
    expect(boundParamValues(stmt)).toContain('12345');
  });

  it('rejects non-numeric installationId to prevent GUC injection', async () => {
    const { db, tx } = fakeDb();
    await expect(() =>
      withTenant(db, 'evil; DROP TABLE foo' as unknown as bigint, async () => undefined),
    ).rejects.toThrow(/positive integer/);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('rejects negative numbers', async () => {
    const { db, tx } = fakeDb();
    await expect(() => withTenant(db, -1, async () => undefined)).rejects.toThrow(
      /positive integer/,
    );
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('rejects ids that mix digits with SQL syntax', async () => {
    const { db, tx } = fakeDb();
    await expect(() =>
      withTenant(db, "1'; SELECT 1; --" as unknown as bigint, async () => undefined),
    ).rejects.toThrow(/positive integer/);
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it('propagates errors thrown inside the callback (caller can catch)', async () => {
    const { db } = fakeDb();
    await expect(() =>
      withTenant(db, 1n, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});
