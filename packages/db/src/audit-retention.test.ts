import { describe, expect, it, vi } from 'vitest';
import {
  loadAuditLogForExport,
  loadCostLedgerForExport,
  pruneAuditLog,
  pruneCostLedger,
} from './audit-retention.js';
import type { DbClient } from './connection.js';

// Build a fake DbClient terminal that satisfies the read paths used by
// loadAuditLogForExport / loadCostLedgerForExport. The chain we model is:
//   db.select(...).from(...).where(...).orderBy(...)
// `await` lands on the Promise returned by `.orderBy(...)`.
function fakeReadDb<R>(rows: ReadonlyArray<R>): DbClient {
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => Promise.resolve(rows) }),
      }),
    }),
  };
  return db as unknown as DbClient;
}

describe('loadAuditLogForExport', () => {
  it('maps DB rows to the export shape (audit kind)', async () => {
    const ts = new Date('2026-04-30T00:00:00Z');
    const rows = [
      {
        id: 42n,
        ts,
        installationId: 7n,
        prId: 'o/r#1',
        event: 'review.start',
        model: 'claude',
        inputTokens: 100,
        outputTokens: 50,
        prevHash: 'p'.repeat(64),
        hash: 'h'.repeat(64),
      },
    ];
    const out = await loadAuditLogForExport(fakeReadDb(rows), {
      installationId: 7n,
      since: new Date('2026-01-01Z'),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'audit', id: 42n, event: 'review.start' });
  });

  it('passes an until bound through the query (no throw)', async () => {
    const out = await loadAuditLogForExport(fakeReadDb([]), {
      installationId: 7n,
      since: new Date('2026-01-01Z'),
      until: new Date('2026-12-31Z'),
    });
    expect(out).toEqual([]);
  });
});

describe('loadCostLedgerForExport', () => {
  it('maps DB rows to the export shape (cost kind)', async () => {
    const createdAt = new Date('2026-04-30T00:00:00Z');
    const rows = [
      {
        id: 11n,
        installationId: 7n,
        jobId: 'job-1',
        provider: 'anthropic',
        model: 'claude',
        callPhase: 'review_main',
        inputTokens: 1,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.01,
        status: 'success',
        createdAt,
      },
    ];
    const out = await loadCostLedgerForExport(fakeReadDb(rows), {
      installationId: 7n,
      since: new Date('2026-01-01Z'),
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'cost', id: 11n, provider: 'anthropic' });
  });

  it('passes an until bound through the query (no throw)', async () => {
    const out = await loadCostLedgerForExport(fakeReadDb([]), {
      installationId: 7n,
      since: new Date('2026-01-01Z'),
      until: new Date('2026-12-31Z'),
    });
    expect(out).toEqual([]);
  });
});

describe('pruneAuditLog', () => {
  it('returns no-op when no anchor exists (table empty before boundary)', async () => {
    const anchorRows: ReadonlyArray<{ id: bigint; hash: string }> = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve(anchorRows) }),
          }),
        }),
      }),
      delete: () => ({
        where: () => ({ returning: () => Promise.resolve([]) }),
      }),
    };
    const db = {
      transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as DbClient;
    const result = await pruneAuditLog(db, { before: new Date('2026-01-01Z') });
    expect(result).toEqual({ deleted: 0, anchorId: null, anchorHash: null });
  });

  it('keeps the most-recent row before the boundary as the new anchor', async () => {
    const anchorRow = { id: 901n, hash: 'a'.repeat(64) };
    const deletedRows = Array.from({ length: 900 }, (_v, i) => ({ id: BigInt(i + 1) }));
    const deleteWhere = vi.fn(() => ({ returning: () => Promise.resolve(deletedRows) }));
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => Promise.resolve([anchorRow]) }),
          }),
        }),
      }),
      delete: () => ({
        where: deleteWhere,
      }),
    };
    const db = {
      transaction: async (fn: (tx: unknown) => unknown) => fn(tx),
    } as unknown as DbClient;
    const result = await pruneAuditLog(db, { before: new Date('2026-12-31Z') });
    expect(result).toEqual({ deleted: 900, anchorId: 901n, anchorHash: 'a'.repeat(64) });
    expect(deleteWhere).toHaveBeenCalledOnce();
  });
});

describe('pruneCostLedger', () => {
  it('deletes every row older than the boundary', async () => {
    const deletedRows = Array.from({ length: 7 }, (_v, i) => ({ id: BigInt(i + 1) }));
    const deleteWhere = vi.fn(() => ({ returning: () => Promise.resolve(deletedRows) }));
    const db = {
      delete: () => ({ where: deleteWhere }),
    } as unknown as DbClient;
    const result = await pruneCostLedger(db, { before: new Date('2026-12-31Z') });
    expect(result).toEqual({ deleted: 7 });
    expect(deleteWhere).toHaveBeenCalledOnce();
  });
});
