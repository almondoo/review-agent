import { describe, expect, it } from 'vitest';
import { COST_THRESHOLDS, decideCostAction } from './cost.js';

describe('decideCostAction', () => {
  it('proceeds when projected cost is below 80%', () => {
    expect(
      decideCostAction({ running: 0, estimate: 0.5, perPrCap: 1, daily: 0, dailyCap: 0 }),
    ).toEqual({ kind: 'proceed' });
  });

  it('signals fallback when projected cost crosses 80% but under 100%', () => {
    expect(
      decideCostAction({ running: 0, estimate: 0.85, perPrCap: 1, daily: 0, dailyCap: 0 }),
    ).toMatchObject({ kind: 'fallback', reason: 'soft_cap' });
  });

  it('aborts when projected exceeds 100%', () => {
    const r = decideCostAction({ running: 0.9, estimate: 0.2, perPrCap: 1, daily: 0, dailyCap: 0 });
    expect(r.kind).toBe('abort');
    expect(r).toMatchObject({ reason: 'cost_exceeded' });
  });

  it('kills when running already exceeds 150%', () => {
    const r = decideCostAction({ running: 1.6, estimate: 0.1, perPrCap: 1, daily: 0, dailyCap: 0 });
    expect(r.kind).toBe('kill');
    expect(r).toMatchObject({ reason: 'kill_switch' });
  });

  it('aborts for daily cap regardless of per-PR cap', () => {
    const r = decideCostAction({
      running: 0,
      estimate: 0.01,
      perPrCap: 1,
      daily: 50,
      dailyCap: 50,
    });
    expect(r.kind).toBe('abort');
    expect(r).toMatchObject({ reason: 'daily_cap' });
  });

  it('skips per-PR check when cap is 0 or negative', () => {
    expect(
      decideCostAction({ running: 100, estimate: 50, perPrCap: 0, daily: 0, dailyCap: 0 }).kind,
    ).toBe('proceed');
  });

  it('exposes thresholds for documentation', () => {
    expect(COST_THRESHOLDS).toMatchObject({ fallback: 0.8, abort: 1, kill: 1.5 });
  });
});
