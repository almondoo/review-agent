import { CostExceededError } from '@review-agent/core';
import type { Middleware } from '../types.js';

const FALLBACK_THRESHOLD = 0.8;
const ABORT_THRESHOLD = 1.0;

export type CostState = {
  totalCostUsd: number;
};

export type CostGuardOptions = {
  readonly state: CostState;
  readonly onFallbackHint?: () => void;
};

export function createCostGuard({ state, onFallbackHint }: CostGuardOptions): Middleware {
  return async (ctx, next) => {
    const cap = ctx.job.costCapUsd;
    if (cap <= 0) return next();

    const estimate = await ctx.provider.estimateCost(ctx.input);
    const projected = state.totalCostUsd + estimate.estimatedUsd;

    if (projected > cap * ABORT_THRESHOLD) {
      throw new CostExceededError(cap, projected);
    }
    if (projected > cap * FALLBACK_THRESHOLD) {
      onFallbackHint?.();
    }

    const result = await next();
    state.totalCostUsd += result.costUsd;
    if (state.totalCostUsd > cap * ABORT_THRESHOLD) {
      throw new CostExceededError(cap, state.totalCostUsd);
    }
    return result;
  };
}
