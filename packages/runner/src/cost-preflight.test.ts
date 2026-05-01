import { CostExceededError } from '@review-agent/core';
import { describe, expect, it, vi } from 'vitest';
import { assertDailyCapNotExceeded, preflightDailyCap } from './cost-preflight.js';

describe('preflightDailyCap', () => {
  it('proceeds when daily cap is not configured', async () => {
    const readTotals = vi.fn().mockResolvedValue({ running: 0, daily: 0 });
    const decision = await preflightDailyCap(
      { installationId: 1n, jobId: 'j', dailyCapUsd: 0 },
      { readTotals },
    );
    expect(decision).toEqual({ kind: 'proceed' });
    expect(readTotals).not.toHaveBeenCalled();
  });

  it('proceeds when daily total is under the cap', async () => {
    const readTotals = vi.fn().mockResolvedValue({ running: 0, daily: 4.99 });
    const decision = await preflightDailyCap(
      { installationId: 1n, jobId: 'j', dailyCapUsd: 5 },
      { readTotals },
    );
    expect(decision.kind).toBe('proceed');
    expect(readTotals).toHaveBeenCalledOnce();
  });

  it('rejects when daily total has hit the cap exactly', async () => {
    const readTotals = vi.fn().mockResolvedValue({ running: 0, daily: 5 });
    const decision = await preflightDailyCap(
      { installationId: 1n, jobId: 'j', dailyCapUsd: 5 },
      { readTotals },
    );
    expect(decision).toEqual({
      kind: 'reject',
      reason: 'daily_cap',
      dailyUsd: 5,
      capUsd: 5,
    });
  });

  it('uses the supplied date string when provided', async () => {
    const readTotals = vi.fn().mockResolvedValue({ running: 0, daily: 0 });
    await preflightDailyCap(
      { installationId: 1n, jobId: 'j', dailyCapUsd: 5, date: '2026-04-30' },
      { readTotals },
    );
    expect(readTotals).toHaveBeenCalledWith({
      installationId: 1n,
      jobId: 'j',
      date: '2026-04-30',
    });
  });

  it('falls back to UTC today when no date is supplied', async () => {
    const readTotals = vi.fn().mockResolvedValue({ running: 0, daily: 0 });
    await preflightDailyCap({ installationId: 1n, jobId: 'j', dailyCapUsd: 5 }, { readTotals });
    const arg = readTotals.mock.calls[0]?.[0] as { date: string };
    expect(arg.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('assertDailyCapNotExceeded', () => {
  it('returns silently when under cap', async () => {
    const readTotals = vi.fn().mockResolvedValue({ running: 0, daily: 1 });
    await expect(
      assertDailyCapNotExceeded({ installationId: 1n, jobId: 'j', dailyCapUsd: 5 }, { readTotals }),
    ).resolves.toBeUndefined();
  });

  it('throws CostExceededError on cap breach', async () => {
    const readTotals = vi.fn().mockResolvedValue({ running: 0, daily: 5 });
    await expect(() =>
      assertDailyCapNotExceeded({ installationId: 1n, jobId: 'j', dailyCapUsd: 5 }, { readTotals }),
    ).rejects.toBeInstanceOf(CostExceededError);
  });
});
