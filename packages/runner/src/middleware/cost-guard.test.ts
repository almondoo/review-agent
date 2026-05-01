import { CostExceededError } from '@review-agent/core';
import type { ReviewOutput } from '@review-agent/llm';
import { describe, expect, it, vi } from 'vitest';
import type { MiddlewareCtx } from '../types.js';
import { type CostState, createCostGuard } from './cost-guard.js';

function makeCtx(estimate: number): MiddlewareCtx {
  return {
    job: { jobId: 'j', costCapUsd: 1 },
    input: {} as MiddlewareCtx['input'],
    provider: {
      name: 'mock',
      model: 'm',
      generateReview: vi.fn(),
      estimateCost: vi.fn().mockResolvedValue({ inputTokens: 0, estimatedUsd: estimate }),
      pricePerMillionTokens: () => ({ input: 0, output: 0 }),
      classifyError: () => ({ kind: 'fatal' as const }),
    },
  } as unknown as MiddlewareCtx;
}

const okResult: ReviewOutput = {
  comments: [],
  summary: 's',
  tokensUsed: { input: 100, output: 50 },
  costUsd: 0.1,
};

describe('createCostGuard', () => {
  it('proceeds and tracks total when projected stays under cap', async () => {
    const state: CostState = { totalCostUsd: 0 };
    const mw = createCostGuard({ state });
    const result = await mw(makeCtx(0.2), async () => okResult);
    expect(result).toBe(okResult);
    expect(state.totalCostUsd).toBeCloseTo(0.1, 6);
  });

  it('signals fallback above 80%', async () => {
    const state: CostState = { totalCostUsd: 0 };
    const onFallbackHint = vi.fn();
    const mw = createCostGuard({ state, onFallbackHint });
    await mw(makeCtx(0.85), async () => okResult);
    expect(onFallbackHint).toHaveBeenCalledOnce();
  });

  it('aborts above 100%', async () => {
    const state: CostState = { totalCostUsd: 0 };
    const mw = createCostGuard({ state });
    await expect(mw(makeCtx(1.5), async () => okResult)).rejects.toBeInstanceOf(CostExceededError);
  });

  it('aborts on daily cap', async () => {
    const state: CostState = { totalCostUsd: 0 };
    const mw = createCostGuard({
      state,
      dailyCapUsd: 50,
      readTotals: async () => ({ running: 0, daily: 50 }),
    });
    await expect(mw(makeCtx(0.01), async () => okResult)).rejects.toBeInstanceOf(CostExceededError);
  });

  it('records to ledger when recorder + recordContext provided', async () => {
    const state: CostState = { totalCostUsd: 0 };
    const recorder = vi.fn().mockResolvedValue(undefined);
    const mw = createCostGuard({
      state,
      recorder,
      recordContext: { installationId: 1n, jobId: 'j', provider: 'p', model: 'm' },
    });
    await mw(makeCtx(0.1), async () => okResult);
    expect(recorder).toHaveBeenCalledOnce();
    const arg = recorder.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      installationId: 1n,
      jobId: 'j',
      callPhase: 'review_main',
      inputTokens: 100,
      outputTokens: 50,
      status: 'success',
    });
  });

  it('fires onThresholdCrossed with the expected event on each tier', async () => {
    const events: Array<{ threshold: string; cumulativeUsd: number; capUsd: number }> = [];
    const onThresholdCrossed = (e: { threshold: string; cumulativeUsd: number; capUsd: number }) =>
      events.push(e);

    // Fallback (80–100%)
    const fallbackState: CostState = { totalCostUsd: 0 };
    await createCostGuard({ state: fallbackState, onThresholdCrossed })(
      makeCtx(0.85),
      async () => okResult,
    );
    expect(events.at(-1)?.threshold).toBe('fallback');

    // Abort (100–150%)
    const abortState: CostState = { totalCostUsd: 0 };
    await expect(() =>
      createCostGuard({ state: abortState, onThresholdCrossed })(
        makeCtx(1.2),
        async () => okResult,
      ),
    ).rejects.toBeInstanceOf(CostExceededError);
    expect(events.at(-1)?.threshold).toBe('abort');

    // Kill (>150%) — feed an already-overrun running total via readTotals
    const killState: CostState = { totalCostUsd: 0 };
    await expect(() =>
      createCostGuard({
        state: killState,
        onThresholdCrossed,
        readTotals: async () => ({ running: 1.7, daily: 0 }),
      })(makeCtx(0.01), async () => okResult),
    ).rejects.toBeInstanceOf(CostExceededError);
    expect(events.at(-1)?.threshold).toBe('kill');

    // Daily cap
    const dailyState: CostState = { totalCostUsd: 0 };
    await expect(() =>
      createCostGuard({
        state: dailyState,
        dailyCapUsd: 50,
        onThresholdCrossed,
        readTotals: async () => ({ running: 0, daily: 50 }),
      })(makeCtx(0.01), async () => okResult),
    ).rejects.toBeInstanceOf(CostExceededError);
    expect(events.at(-1)?.threshold).toBe('daily_cap');
  });

  it('records a cost_exceeded ledger row when the cap is breached', async () => {
    const state: CostState = { totalCostUsd: 0 };
    const recorder = vi.fn().mockResolvedValue(undefined);
    const mw = createCostGuard({
      state,
      recorder,
      recordContext: { installationId: 1n, jobId: 'j', provider: 'p', model: 'm' },
    });
    await expect(() => mw(makeCtx(1.5), async () => okResult)).rejects.toBeInstanceOf(
      CostExceededError,
    );
    expect(recorder).toHaveBeenCalledOnce();
    expect(recorder.mock.calls[0]?.[0]).toMatchObject({
      installationId: 1n,
      jobId: 'j',
      status: 'cost_exceeded',
    });
  });
});
