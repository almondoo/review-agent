/**
 * Unit tests for the #155 suppression-rule DB helpers in review-history.ts.
 * All DB interactions are mocked via a Drizzle-shaped fake so no real
 * Postgres connection is required.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  countRejectionsByFingerprint,
  createSuppressionRule,
  deleteSuppressionRule,
  loadActiveSuppressionRules,
} from '../review-history.js';

// ---------------------------------------------------------------------------
// countRejectionsByFingerprint
// ---------------------------------------------------------------------------
// Helper: build a select-chain fake that returns `resolveWith` when
// `.where()` is called after `.from()`.
function makeCountChain(resolveWith: unknown): { select: ReturnType<typeof vi.fn> } {
  // countRejectionsByFingerprint chains: db.select({n:count()}).from(...).where(...and(...))
  // The where() call should resolve with the mock rows.
  const whereFn = vi.fn().mockResolvedValue(resolveWith);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return { select: selectFn };
}

describe('countRejectionsByFingerprint', () => {
  it('returns 0 when no rows found', async () => {
    const { select } = makeCountChain([{ n: 0 }]);
    const db = { select } as never;
    const n = await countRejectionsByFingerprint(db, {
      installationId: 1n,
      repo: 'org/repo',
      fingerprint: 'abc123',
    });
    expect(n).toBe(0);
  });

  it('returns the count from the aggregation row', async () => {
    const { select } = makeCountChain([{ n: 3 }]);
    const db = { select } as never;
    const n = await countRejectionsByFingerprint(db, {
      installationId: 1n,
      repo: 'org/repo',
      fingerprint: 'deadbeef',
    });
    expect(n).toBe(3);
  });

  it('returns 0 when the aggregation row is missing (empty array)', async () => {
    const { select } = makeCountChain([]);
    const db = { select } as never;
    const n = await countRejectionsByFingerprint(db, {
      installationId: 1n,
      repo: 'org/repo',
      fingerprint: 'deadbeef',
    });
    expect(n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createSuppressionRule
// ---------------------------------------------------------------------------
describe('createSuppressionRule', () => {
  it('inserts a suppression_rule row with the correct factText prefix', async () => {
    const inserted = [{ id: 42n }];
    const valuesFn = vi.fn().mockReturnThis();
    const returningFn = vi.fn().mockResolvedValue(inserted);
    const insertFn = vi.fn(() => ({ values: valuesFn }));
    // Wire values → returning
    valuesFn.mockReturnValue({ returning: returningFn });

    const db = { insert: insertFn } as never;
    const id = await createSuppressionRule(db, {
      installationId: 1n,
      repo: 'org/repo',
      fingerprint: 'abc123',
      reason: 'Auto-suppressed after 3 rejection(s)',
    });
    expect(id).toBe(42n);
    expect(insertFn).toHaveBeenCalledTimes(1);
    const rowArg = valuesFn.mock.calls[0]?.[0];
    expect(rowArg?.factType).toBe('suppression_rule');
    expect(rowArg?.factText).toBe('[fp:abc123] Auto-suppressed after 3 rejection(s)');
  });

  it('throws when the insert returns no rows', async () => {
    const valuesFn = vi.fn().mockReturnThis();
    const returningFn = vi.fn().mockResolvedValue([]);
    const insertFn = vi.fn(() => ({ values: valuesFn }));
    valuesFn.mockReturnValue({ returning: returningFn });

    const db = { insert: insertFn } as never;
    await expect(
      createSuppressionRule(db, {
        installationId: 1n,
        repo: 'org/repo',
        fingerprint: 'abc123',
        reason: 'x',
      }),
    ).rejects.toThrow(/insert returned no rows/);
  });
});

// ---------------------------------------------------------------------------
// loadActiveSuppressionRules
// ---------------------------------------------------------------------------
describe('loadActiveSuppressionRules', () => {
  it('returns active suppression rows ordered by createdAt desc', async () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const expires = new Date('2026-11-28T00:00:00Z');
    const rawRows = [
      { id: 10n, factText: '[fp:aaa] reason', createdAt: now, expiresAt: expires },
      { id: 11n, factText: '[fp:bbb] reason', createdAt: now, expiresAt: expires },
    ];

    // Build a minimal chain that resolves after orderBy().
    const whereFn = vi.fn().mockReturnThis();
    const orderByFn = vi.fn().mockResolvedValue(rawRows);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    whereFn.mockReturnValue({ orderBy: orderByFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as never;

    const rows = await loadActiveSuppressionRules(db, {
      installationId: 1n,
      repo: 'org/repo',
      now,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe(10n);
    expect(rows[0]?.factText).toBe('[fp:aaa] reason');
  });

  it('returns an empty array when there are no active rules', async () => {
    const whereFn = vi.fn().mockReturnThis();
    const orderByFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    whereFn.mockReturnValue({ orderBy: orderByFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as never;

    const rows = await loadActiveSuppressionRules(db, {
      installationId: 1n,
      repo: 'org/repo',
    });
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteSuppressionRule
// ---------------------------------------------------------------------------
describe('deleteSuppressionRule', () => {
  it('returns true when a row is deleted (rowCount=1)', async () => {
    const whereFn = vi.fn().mockResolvedValue({ rowCount: 1 });
    const deleteFn = vi.fn().mockReturnValue({ where: whereFn });
    const db = { delete: deleteFn } as never;

    const ok = await deleteSuppressionRule(db, {
      id: 5n,
      installationId: 1n,
      repo: 'org/repo',
    });
    expect(ok).toBe(true);
  });

  it('returns false when no row is deleted (rowCount=0 — already removed)', async () => {
    const whereFn = vi.fn().mockResolvedValue({ rowCount: 0 });
    const deleteFn = vi.fn().mockReturnValue({ where: whereFn });
    const db = { delete: deleteFn } as never;

    const ok = await deleteSuppressionRule(db, {
      id: 999n,
      installationId: 1n,
      repo: 'org/repo',
    });
    expect(ok).toBe(false);
  });

  it('returns false when result has neither rowCount nor length', async () => {
    const whereFn = vi.fn().mockResolvedValue({});
    const deleteFn = vi.fn().mockReturnValue({ where: whereFn });
    const db = { delete: deleteFn } as never;

    const ok = await deleteSuppressionRule(db, {
      id: 1n,
      installationId: 1n,
      repo: 'org/repo',
    });
    expect(ok).toBe(false);
  });
});
