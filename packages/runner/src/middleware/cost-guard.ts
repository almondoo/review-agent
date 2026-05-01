import {
  CostExceededError,
  type CostGuardDecision,
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

export type CostThreshold = 'fallback' | 'abort' | 'kill' | 'daily_cap';

export type CostThresholdEvent = {
  readonly threshold: CostThreshold;
  readonly cumulativeUsd: number;
  readonly capUsd: number;
};

export type CostGuardOptions = {
  readonly state: CostState;
  /** @deprecated prefer onThresholdCrossed; kept for back-compat. */
  readonly onFallbackHint?: () => void;
  /**
   * Fired on every threshold transition (fallback / abort / kill /
   * daily_cap). The hook is responsible for OTel attribute
   * propagation, audit-log entries, and the kill-switch handler.
   */
  readonly onThresholdCrossed?: (event: CostThresholdEvent) => void;
  readonly dailyCapUsd?: number;
  readonly readTotals?: () => Promise<CostTotals>;
  readonly recorder?: CostLedgerRecorder;
  readonly recordContext?: CostGuardRecordContext;
};

export function createCostGuard({
  state,
  onFallbackHint,
  onThresholdCrossed,
  dailyCapUsd = 0,
  readTotals,
  recorder,
  recordContext,
}: CostGuardOptions): Middleware {
  return async (ctx, next) => {
    const cap = ctx.job.costCapUsd;

    // Skip estimation when no cap is in effect — preserves the v0.1
    // behavior and avoids charging for a tokenizer round-trip we'd
    // ignore anyway.
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
      onThresholdCrossed?.(toThresholdEvent(decision));
      await recordExceeded(recorder, recordContext, estimate.estimatedUsd);
      throw new CostExceededError(decision.capUsd, decision.runningUsd);
    }
    if (decision.kind === 'fallback') {
      onFallbackHint?.();
      onThresholdCrossed?.(toThresholdEvent(decision));
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
      const cumulative = state.totalCostUsd;
      const event: CostThresholdEvent = {
        threshold: cumulative > cap * 1.5 ? 'kill' : 'abort',
        cumulativeUsd: cumulative,
        capUsd: cap,
      };
      onThresholdCrossed?.(event);
      await recordExceeded(recorder, recordContext, 0);
      throw new CostExceededError(cap, cumulative);
    }
    return result;
  };
}

async function recordExceeded(
  recorder: CostLedgerRecorder | undefined,
  ctx: CostGuardRecordContext | undefined,
  estimatedUsd: number,
): Promise<void> {
  if (!recorder || !ctx) return;
  await recorder({
    installationId: ctx.installationId,
    jobId: ctx.jobId,
    provider: ctx.provider,
    model: ctx.model,
    callPhase: 'review_main',
    inputTokens: 0,
    outputTokens: 0,
    costUsd: estimatedUsd,
    status: 'cost_exceeded',
  });
}

function toThresholdEvent(decision: CostGuardDecision): CostThresholdEvent {
  if (decision.kind === 'fallback') {
    // The decision engine doesn't carry running/cap on fallback —
    // surface zero so the OTel hook can still emit the threshold
    // type without the consumer needing to handle missing fields.
    return { threshold: 'fallback', cumulativeUsd: 0, capUsd: 0 };
  }
  if (decision.kind === 'kill') {
    return { threshold: 'kill', cumulativeUsd: decision.runningUsd, capUsd: decision.capUsd };
  }
  if (decision.kind === 'abort') {
    return {
      threshold: decision.reason === 'daily_cap' ? 'daily_cap' : 'abort',
      cumulativeUsd: decision.runningUsd,
      capUsd: decision.capUsd,
    };
  }
  return { threshold: 'fallback', cumulativeUsd: 0, capUsd: 0 };
}
