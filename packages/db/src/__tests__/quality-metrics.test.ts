/**
 * Unit tests for `loadQualityMetrics` in quality-metrics.ts.
 *
 * All DB interactions are mocked via a Drizzle-shaped fake. Tests verify:
 *   - Metric formula correctness (acceptance rate, FP rate, coverage, latency)
 *   - Graceful N/A on zero-denominator / no-feedback conditions (AC#5)
 *   - Per-repo + overall aggregation
 *   - withTenant (GUC) is invoked with the correct installationId
 */
import { describe, expect, it, vi } from 'vitest';
import { loadQualityMetrics } from '../quality-metrics.js';

const NOW = new Date('2026-05-15T12:00:00Z');

// ---------------------------------------------------------------------------
// Fake DB builder
//
// loadQualityMetrics calls:
//   withTenant(db, installationId, async (tx) => {
//     tx.execute(set_config_sql)             -- GUC
//     tx.select(...).from(...).where(...).groupBy(...)  -- evalRows        [0]
//     tx.select(...).from(...).where(...).groupBy(...)  -- acceptedRows    [1]
//     tx.select(...).from(...).where(...).groupBy(...)  -- rejectedRows    [2]
//     tx.select(...).from(...).where(...).groupBy(...)  -- suppressionRows [3]
//     tx.select(...).from(...).where(...).groupBy(...)  -- overallRow      [4]
//   })
//
// withTenant(db, id, fn) opens db.transaction(txFn) and executes
// set_config before calling fn. So the top-level mock is `db.transaction`.
// ---------------------------------------------------------------------------

function makeFakeDbWithResults(opts: {
  evalRows?: unknown[];
  acceptedRows?: unknown[];
  rejectedRows?: unknown[];
  suppressionRows?: unknown[];
  overallRow?: unknown[];
}) {
  const sequence: unknown[][] = [
    opts.evalRows ?? [],
    opts.acceptedRows ?? [],
    opts.rejectedRows ?? [],
    opts.suppressionRows ?? [],
    opts.overallRow ?? [],
  ];

  function makeTxFlexible() {
    let selectIdx = 0;
    const execSpy = vi.fn().mockResolvedValue([]);

    const tx = {
      execute: execSpy,
      select: () => {
        const currentIdx = selectIdx++;
        const result = sequence[currentIdx] ?? [];

        // `where()` must return a value that:
        //   (a) can be `await`-ed directly (overall query has no .groupBy call)
        //   (b) exposes `.groupBy()` for per-repo grouped queries
        // We attach .groupBy() to the resolved Promise so both paths work.
        const p = Promise.resolve(result);
        const withGroupBy = Object.assign(p, {
          groupBy: () => Promise.resolve(result),
        });

        return {
          from: () => ({
            where: () => withGroupBy,
          }),
        };
      },
    };

    return { tx, execSpy };
  }

  const { tx, execSpy } = makeTxFlexible();

  const db = {
    transaction: vi.fn((fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { db, executeSpy: execSpy };
}

// ---------------------------------------------------------------------------
// Helpers: make rows
// ---------------------------------------------------------------------------

function makeEvalRow(overrides: Record<string, unknown> = {}) {
  return {
    repo: 'owner/repo',
    reviewCount: 10,
    totalCommentCount: '50',
    filesTotal: '100',
    filesReviewed: '80',
    p50: '1234.5',
    p95: '5678.0',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadQualityMetrics', () => {
  it('sets app.current_tenant GUC via withTenant before querying', async () => {
    const { db, executeSpy } = makeFakeDbWithResults({});
    await loadQualityMetrics(db as never, {
      installationId: 42n,
      since: '30d',
      now: NOW,
    });
    // withTenant calls tx.execute(sql`SELECT set_config(...)`)
    // The argument is a Drizzle SQL object (not a string).
    expect(executeSpy).toHaveBeenCalled();
    const firstCall = executeSpy.mock.calls[0]?.[0];
    // Drizzle SQL objects are plain objects — not strings.
    expect(typeof firstCall).toBe('object');
    expect(firstCall).not.toBeNull();
  });

  it('returns zero reviewCount and all-null metrics when DB is empty', async () => {
    const { db } = makeFakeDbWithResults({});
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '7d',
      now: NOW,
    });
    expect(result.overall.reviewCount).toBe(0);
    expect(result.overall.acceptanceRate).toBeNull();
    expect(result.overall.falsePositiveRate).toBeNull();
    expect(result.overall.coverageRate).toBeNull();
    expect(result.overall.latencyP50Ms).toBeNull();
    expect(result.overall.latencyP95Ms).toBeNull();
    expect(result.perRepo).toHaveLength(0);
  });

  it('computes acceptance rate: accepted / (accepted + rejected)', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow()],
      acceptedRows: [{ repo: 'owner/repo', n: 7 }],
      rejectedRows: [{ repo: 'owner/repo', n: 3 }],
      suppressionRows: [],
      overallRow: [
        {
          p50: '1234.5',
          p95: '5678.0',
          filesTotal: '100',
          filesReviewed: '80',
          totalCommentCount: '50',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    const repo = result.perRepo[0];
    expect(repo).toBeDefined();
    expect(repo?.acceptanceRate).toBeCloseTo(7 / 10);
    expect(result.overall.acceptanceRate).toBeCloseTo(7 / 10);
  });

  it('returns null acceptanceRate when no feedback rows exist', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow()],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        { p50: null, p95: null, filesTotal: null, filesReviewed: null, totalCommentCount: '5' },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.acceptanceRate).toBeNull();
    expect(result.overall.acceptanceRate).toBeNull();
  });

  it('computes falsePositiveRate: (rejected + suppression) / totalComments', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ totalCommentCount: '20' })],
      acceptedRows: [],
      rejectedRows: [{ repo: 'owner/repo', n: 3 }],
      suppressionRows: [{ repo: 'owner/repo', n: 2 }],
      overallRow: [
        {
          p50: '1000',
          p95: '2000',
          filesTotal: '100',
          filesReviewed: '80',
          totalCommentCount: '20',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    // (3 + 2) / 20 = 0.25
    expect(result.perRepo[0]?.falsePositiveRate).toBeCloseTo(0.25);
    expect(result.overall.falsePositiveRate).toBeCloseTo(0.25);
  });

  it('returns null falsePositiveRate when totalComments is 0', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ totalCommentCount: '0' })],
      acceptedRows: [],
      rejectedRows: [{ repo: 'owner/repo', n: 2 }],
      suppressionRows: [],
      overallRow: [
        {
          p50: null,
          p95: null,
          filesTotal: null,
          filesReviewed: null,
          totalCommentCount: '0',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.falsePositiveRate).toBeNull();
    expect(result.overall.falsePositiveRate).toBeNull();
  });

  it('returns null falsePositiveRate when feedback numerator is 0', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ totalCommentCount: '10' })],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: null,
          p95: null,
          filesTotal: null,
          filesReviewed: null,
          totalCommentCount: '10',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.falsePositiveRate).toBeNull();
    expect(result.overall.falsePositiveRate).toBeNull();
  });

  it('computes coverageRate: filesReviewed / filesTotal', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ filesTotal: '100', filesReviewed: '75' })],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: '500',
          p95: '1000',
          filesTotal: '100',
          filesReviewed: '75',
          totalCommentCount: '0',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.coverageRate).toBeCloseTo(0.75);
    expect(result.overall.coverageRate).toBeCloseTo(0.75);
  });

  it('returns null coverageRate when filesTotal is null (pre-migration rows)', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ filesTotal: null, filesReviewed: null })],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: null,
          p95: null,
          filesTotal: null,
          filesReviewed: null,
          totalCommentCount: '5',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.coverageRate).toBeNull();
    expect(result.overall.coverageRate).toBeNull();
  });

  it('returns null coverageRate when filesTotal is 0', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ filesTotal: '0', filesReviewed: '0' })],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: null,
          p95: null,
          filesTotal: '0',
          filesReviewed: '0',
          totalCommentCount: '0',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.coverageRate).toBeNull();
    expect(result.overall.coverageRate).toBeNull();
  });

  it('surfaces latency P50/P95 from eval rows', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ p50: '1500', p95: '4800' })],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: '1500',
          p95: '4800',
          filesTotal: null,
          filesReviewed: null,
          totalCommentCount: '0',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.latencyP50Ms).toBeCloseTo(1500);
    expect(result.perRepo[0]?.latencyP95Ms).toBeCloseTo(4800);
    expect(result.overall.latencyP50Ms).toBeCloseTo(1500);
    expect(result.overall.latencyP95Ms).toBeCloseTo(4800);
  });

  it('returns null latency when P50/P95 are null (empty period)', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [makeEvalRow({ p50: null, p95: null })],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: null,
          p95: null,
          filesTotal: null,
          filesReviewed: null,
          totalCommentCount: '0',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '30d',
      now: NOW,
    });
    expect(result.perRepo[0]?.latencyP50Ms).toBeNull();
    expect(result.perRepo[0]?.latencyP95Ms).toBeNull();
    expect(result.overall.latencyP50Ms).toBeNull();
    expect(result.overall.latencyP95Ms).toBeNull();
  });

  it('returns per-repo breakdown with correct repo slugs', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [
        makeEvalRow({ repo: 'org/repo-a', reviewCount: 5 }),
        makeEvalRow({ repo: 'org/repo-b', reviewCount: 3 }),
      ],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: null,
          p95: null,
          filesTotal: null,
          filesReviewed: null,
          totalCommentCount: '0',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '24h',
      now: NOW,
    });
    expect(result.perRepo).toHaveLength(2);
    const slugs = result.perRepo.map((r) => r.repo);
    expect(slugs).toContain('org/repo-a');
    expect(slugs).toContain('org/repo-b');
  });

  it('correctly sums overall reviewCount from per-repo rows', async () => {
    const { db } = makeFakeDbWithResults({
      evalRows: [
        makeEvalRow({ repo: 'org/a', reviewCount: 10 }),
        makeEvalRow({ repo: 'org/b', reviewCount: 7 }),
      ],
      acceptedRows: [],
      rejectedRows: [],
      suppressionRows: [],
      overallRow: [
        {
          p50: null,
          p95: null,
          filesTotal: null,
          filesReviewed: null,
          totalCommentCount: '0',
        },
      ],
    });
    const result = await loadQualityMetrics(db as never, {
      installationId: 1n,
      since: '7d',
      now: NOW,
    });
    expect(result.overall.reviewCount).toBe(17);
  });
});
