import {
  CostExceededError,
  type CostLedgerRecorder,
  type CostTotals,
  decideCostAction,
} from '@review-agent/core';
import type { Middleware } from '../types.js';

export type CostState = {
  totalCostUsd: number;
};

export type CostGuardRecordContext = {
  readonly installationId: bigint;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
};

export type CostGuardOptions = {
  readonly state: CostState;
  readonly onFallbackHint?: () => void;
  readonly dailyCapUsd?: number;
  readonly readTotals?: () => Promise<CostTotals>;
  readonly recorder?: CostLedgerRecorder;
  readonly recordContext?: CostGuardRecordContext;
};

export function createCostGuard({
  state,
  onFallbackHint,
  dailyCapUsd = 0,
  readTotals,
  recorder,
  recordContext,
}: CostGuardOptions): Middleware {
  return async (ctx, next) => {
    const cap = ctx.job.costCapUsd;

    // Skip estimation when no cap is in effect — preserves the v0.1 behavior
    // and avoids charging for a tokenizer round-trip we'd ignore anyway.
    if (cap <= 0 && dailyCapUsd <= 0 && !recorder) {
      return next();
    }

    const estimate = await ctx.provider.estimateCost(ctx.input);
    const totals = readTotals ? await readTotals() : { running: state.totalCostUsd, daily: 0 };

    const decision = decideCostAction({
      running: totals.running,
      estimate: estimate.estimatedUsd,
      perPrCap: cap,
      daily: totals.daily,
      dailyCap: dailyCapUsd,
    });

    if (decision.kind === 'abort' || decision.kind === 'kill') {
      throw new CostExceededError(decision.capUsd, decision.runningUsd);
    }
    if (decision.kind === 'fallback') {
      onFallbackHint?.();
    }

    const result = await next();
    state.totalCostUsd = totals.running + result.costUsd;
    if (recorder && recordContext) {
      await recorder({
        installationId: recordContext.installationId,
        jobId: recordContext.jobId,
        provider: recordContext.provider,
        model: recordContext.model,
        callPhase: 'review_main',
        inputTokens: result.tokensUsed.input,
        outputTokens: result.tokensUsed.output,
        costUsd: result.costUsd,
        status: 'success',
      });
    }
    if (cap > 0 && state.totalCostUsd > cap) {
      throw new CostExceededError(cap, state.totalCostUsd);
    }
    return result;
  };
}
