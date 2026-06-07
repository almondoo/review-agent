/**
 * Unit tests for `loadCostMetrics` in cost-metrics.ts.
 *
 * All DB interactions are mocked via a Drizzle-shaped fake. Tests verify:
 *   - Overall cost/token/call aggregation
 *   - Per-model GROUP BY aggregation
 *   - Per-repo JOIN aggregation (cost_ledger ⟶ review_eval_event)
 *   - Per-period bucket aggregation
 *   - Cursor-based pagination of per-repo results
 *   - Empty data handling (0s, empty arrays)
 *   - withTenant GUC invocation (the execute spy must be called)
 *   - budget_alert_usd threshold: null when not exceeded, set when exceeded
 */
import { describe, expect, it, vi } from 'vitest';
import { loadCostMetrics } from '../cost-metrics.js';

const NOW = new Date('2026-05-15T12:00:00Z');

// ---------------------------------------------------------------------------
// Fake DB builder
//
// loadCostMetrics makes these calls inside withTenant (i.e. db.transaction):
//   tx.execute(set_config_sql)                            -- GUC        [0]
//   tx.select(...).from(...).where(...)                   -- overallRow  [1]
//   tx.select(...).from(...).where(...).groupBy(...).orderBy(...)  -- perModelRows [2]
//   tx.select(...innerJoin...).where(...).groupBy(...).orderBy(...)  -- perRepoAllRows [3]
//   tx.select(...).from(...).where(...).groupBy(...).orderBy(...)  -- perPeriodRows [4]
// ---------------------------------------------------------------------------

type SelectResult = unknown[];

/**
 * Build a fake DbClient that replays `sequences` in order.
 *
 * The fake supports:
 *   - tx.execute() → for the GUC set_config call (always returns [])
 *   - tx.select()  → returns the next result in `sequences`, attaching
 *                    .from().where() and optionally .groupBy().orderBy()
 *                    so all call patterns work.
 */
function makeFakeDb(sequences: SelectResult[]) {
  let selectIdx = 0;
  const execSpy = vi.fn().mockResolvedValue([]);

  function makeChain(result: SelectResult) {
    const resolved = Promise.resolve(result);
    const withExtras = Object.assign(resolved, {
      groupBy: () =>
        Object.assign(Promise.resolve(result), {
          orderBy: () => Promise.resolve(result),
        }),
      orderBy: () => Promise.resolve(result),
    });
    return withExtras;
  }

  const tx = {
    execute: execSpy,
    select: () => {
      const currentIdx = selectIdx++;
      const result = sequences[currentIdx] ?? [];
      return {
        from: () => ({
          where: () => makeChain(result),
          innerJoin: () => ({
            where: () => makeChain(result),
          }),
        }),
      };
    },
  };

  const db = {
    transaction: vi.fn((fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { db, execSpy };
}

// ---------------------------------------------------------------------------
// Row constructors
// ---------------------------------------------------------------------------

function makeOverallRow(overrides: Record<string, unknown> = {}) {
  return {
    totalCostUsd: '18.42',
    totalInputTokens: '2000000',
    totalOutputTokens: '180000',
    totalCacheReadTokens: '500000',
    totalCacheCreationTokens: '300000',
    callCount: 347,
    ...overrides,
  };
}

function makeModelRow(provider: string, model: string, costUsd: string, callCount: number) {
  return { provider, model, costUsd, callCount };
}

function makeRepoRow(repo: string, costUsd: string) {
  return { repo, costUsd };
}

function makePeriodRow(bucket: string, costUsd: string) {
  return { bucket, costUsd };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadCostMetrics', () => {
  it('sets app.current_tenant GUC via withTenant before querying', async () => {
    const { db, execSpy } = makeFakeDb([[], [], [], []]);
    await loadCostMetrics(db as never, {
      installationId: 42n,
      since: '30d',
      now: NOW,
    });
    expect(execSpy).toHaveBeenCalled();
    const firstCall = execSpy.mock.calls[0]?.[0];
    expect(typeof firstCall).toBe('object');
    expect(firstCall).not.toBeNull();
  });

  it('returns zero overall when DB is empty', async () => {
    const { db } = makeFakeDb([[], [], [], []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.overall.totalCostUsd).toBe(0);
    expect(result.overall.totalInputTokens).toBe(0);
    expect(result.overall.totalOutputTokens).toBe(0);
    expect(result.overall.callCount).toBe(0);
    expect(result.overall.budgetAlertUsd).toBeNull();
    expect(result.perModel).toHaveLength(0);
    expect(result.perRepo).toHaveLength(0);
    expect(result.perPeriod).toHaveLength(0);
    expect(result.nextCursor).toBeNull();
  });

  it('parses overall aggregates correctly', async () => {
    const { db } = makeFakeDb([[makeOverallRow()], [], [], []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.overall.totalCostUsd).toBeCloseTo(18.42);
    expect(result.overall.totalInputTokens).toBe(2_000_000);
    expect(result.overall.totalOutputTokens).toBe(180_000);
    expect(result.overall.totalCacheReadTokens).toBe(500_000);
    expect(result.overall.totalCacheCreationTokens).toBe(300_000);
    expect(result.overall.callCount).toBe(347);
  });

  it('returns budgetAlertUsd=null when threshold not exceeded', async () => {
    const { db } = makeFakeDb([[makeOverallRow({ totalCostUsd: '5.0' })], [], [], []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      budgetAlertUsd: 50,
      now: NOW,
    });
    expect(result.overall.budgetAlertUsd).toBeNull();
  });

  it('returns budgetAlertUsd set when threshold is exceeded', async () => {
    const { db } = makeFakeDb([[makeOverallRow({ totalCostUsd: '75.0' })], [], [], []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      budgetAlertUsd: 50,
      now: NOW,
    });
    expect(result.overall.budgetAlertUsd).toBe(50);
  });

  it('returns budgetAlertUsd=null when budgetAlertUsd option is not provided', async () => {
    const { db } = makeFakeDb([[makeOverallRow({ totalCostUsd: '100.0' })], [], [], []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.overall.budgetAlertUsd).toBeNull();
  });

  it('aggregates per-model rows correctly', async () => {
    const { db } = makeFakeDb([
      [makeOverallRow()],
      [
        makeModelRow('anthropic', 'claude-sonnet-4-5', '15.2', 290),
        makeModelRow('anthropic', 'claude-haiku-4-5', '3.22', 57),
      ],
      [],
      [],
    ]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perModel).toHaveLength(2);
    const sonnet = result.perModel.find((m) => m.model === 'claude-sonnet-4-5');
    expect(sonnet).toBeDefined();
    expect(sonnet?.costUsd).toBeCloseTo(15.2);
    expect(sonnet?.callCount).toBe(290);
    expect(sonnet?.provider).toBe('anthropic');
  });

  it('maps per-repo JOIN rows to RepoCostSnapshot', async () => {
    const { db } = makeFakeDb([
      [makeOverallRow()],
      [],
      [
        makeRepoRow('acme/api-service', '4.8'),
        makeRepoRow('acme/auth', '3.9'),
        makeRepoRow('acme/infra', '3.5'),
      ],
      [],
    ]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo).toHaveLength(3);
    const api = result.perRepo.find((r) => r.repo === 'acme/api-service');
    expect(api?.costUsd).toBeCloseTo(4.8);
  });

  it('returns nextCursor=null when perRepo fits within one page', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRepoRow(`owner/repo-${i}`, String(i + 1)));
    const { db } = makeFakeDb([[makeOverallRow()], [], rows, []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      limit: 20,
      now: NOW,
    });
    expect(result.nextCursor).toBeNull();
    expect(result.perRepo).toHaveLength(5);
  });

  it('paginates perRepo and returns nextCursor when there are more rows', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeRepoRow(`owner/repo-${i}`, String(25 - i)),
    );
    const { db } = makeFakeDb([[makeOverallRow()], [], rows, []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      limit: 20,
      now: NOW,
    });
    expect(result.perRepo).toHaveLength(20);
    // The cursor should be the last repo name on the first page.
    expect(result.nextCursor).toBe('owner/repo-19');
  });

  it('advances to the next page using cursor', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      makeRepoRow(`owner/repo-${i}`, String(25 - i)),
    );
    // Two separate DB calls with the same rows (cursor pagination is in-JS).
    const { db } = makeFakeDb([[makeOverallRow()], [], rows, []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      limit: 20,
      cursor: 'owner/repo-19',
      now: NOW,
    });
    // After repo-19 there are 5 rows remaining (repo-20..repo-24).
    expect(result.perRepo).toHaveLength(5);
    expect(result.nextCursor).toBeNull();
  });

  it('maps per-period bucket rows to PeriodCostBucket', async () => {
    const { db } = makeFakeDb([
      [makeOverallRow()],
      [],
      [],
      [
        makePeriodRow('2026-05-14T00:00:00.000Z', '0.42'),
        makePeriodRow('2026-05-15T00:00:00.000Z', '0.61'),
      ],
    ]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perPeriod).toHaveLength(2);
    const first = result.perPeriod[0];
    expect(first?.bucket).toBe('2026-05-14T00:00:00.000Z');
    expect(first?.costUsd).toBeCloseTo(0.42);
  });

  it('converts Date bucket values to ISO string', async () => {
    const bucketDate = new Date('2026-05-14T00:00:00.000Z');
    const { db } = makeFakeDb([
      [makeOverallRow()],
      [],
      [],
      [{ bucket: bucketDate, costUsd: '0.5' }],
    ]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '24h',
      now: NOW,
    });
    expect(typeof result.perPeriod[0]?.bucket).toBe('string');
    expect(result.perPeriod[0]?.bucket).toBe(bucketDate.toISOString());
  });

  it('returns empty perPeriod for 24h window with no data', async () => {
    const { db } = makeFakeDb([[], [], [], []]);
    const result = await loadCostMetrics(db as never, {
      installationId: 1n,
      since: '24h',
      now: NOW,
    });
    expect(result.perPeriod).toHaveLength(0);
  });
});
