import { describe, expect, it, vi } from 'vitest';
import { TENANT_GUC, withTenant } from './tenancy.js';

type FakeTx = { execute: ReturnType<typeof vi.fn> };

function fakeDb() {
  const tx: FakeTx = { execute: vi.fn().mockResolvedValue([]) };
  const transaction = vi.fn(async (fn: (tx: FakeTx) => Promise<unknown>) => fn(tx));
  return { db: { transaction } as unknown as Parameters<typeof withTenant>[0], tx, transaction };
}

describe('withTenant', () => {
  it('opens a transaction, sets the tenant GUC, then runs the callback', async () => {
    const { db, tx, transaction } = fakeDb();
    const result = await withTenant(db, 12345n, async (scopedTx) => {
      expect(scopedTx).toBe(tx);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(1);
    const [stmt] = tx.execute.mock.calls[0] ?? [];
    // sql.raw produces a chunk with the SQL text. Stringify-ish:
    const text = String(
      (stmt as { queryChunks?: Array<{ value?: string[] }> })?.queryChunks?.[0]?.value?.join('') ??
        '',
    );
    expect(text).toContain(`SET LOCAL ${TENANT_GUC} = '12345';`);
  });

  it('accepts numeric installationId by stringifying', async () => {
    const { db, tx } = fakeDb();
    await withTenant(db, 7, async () => undefined);
    const [stmt] = tx.execute.mock.calls[0] ?? [];
    const text = String(
      (stmt as { queryChunks?: Array<{ value?: string[] }> })?.queryChunks?.[0]?.value?.join('') ??
        '',
    );
    expect(text).toContain(`= '7';`);
  });

  it('rejects non-numeric installationId to prevent GUC injection', async () => {
    const { db } = fakeDb();
    await expect(() =>
      withTenant(db, 'evil; DROP TABLE foo' as unknown as bigint, async () => undefined),
    ).rejects.toThrow(/positive integer/);
  });

  it('rejects negative numbers', async () => {
    const { db } = fakeDb();
    await expect(() => withTenant(db, -1, async () => undefined)).rejects.toThrow(
      /positive integer/,
    );
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
