import { CostExceededError, type CostTotalsReader } from '@review-agent/core';

export type PreflightInput = {
  readonly installationId: bigint;
  readonly jobId: string;
  readonly date?: string;
  readonly dailyCapUsd: number;
};

export type PreflightDeps = {
  readonly readTotals: CostTotalsReader;
};

export type PreflightDecision =
  | { readonly kind: 'proceed' }
  | {
      readonly kind: 'reject';
      readonly reason: 'daily_cap';
      readonly dailyUsd: number;
      readonly capUsd: number;
    };

// Job-start daily-cap check (spec §16.3 + acceptance for #35).
//
// Run once per job, BEFORE any LLM call. If the installation has
// already burned through the day's budget, we reject the entire job
// up front so we don't waste a cold-start on a doomed review.
//
// Throws `CostExceededError` so the worker glue can catch it
// uniformly with per-call cap breaches (which also throw the same
// error from the cost-guard middleware).
export async function preflightDailyCap(
  input: PreflightInput,
  deps: PreflightDeps,
): Promise<PreflightDecision> {
  if (input.dailyCapUsd <= 0) return { kind: 'proceed' };
  const totals = await deps.readTotals({
    installationId: input.installationId,
    jobId: input.jobId,
    date: input.date ?? isoDateUtc(new Date()),
  });
  if (totals.daily >= input.dailyCapUsd) {
    return {
      kind: 'reject',
      reason: 'daily_cap',
      dailyUsd: totals.daily,
      capUsd: input.dailyCapUsd,
    };
  }
  return { kind: 'proceed' };
}

// Convenience helper: run the preflight and throw when over the cap.
// Use this at the top of the worker glue when you don't need to
// differentiate cost-cap rejection from other failure modes.
export async function assertDailyCapNotExceeded(
  input: PreflightInput,
  deps: PreflightDeps,
): Promise<void> {
  const decision = await preflightDailyCap(input, deps);
  if (decision.kind === 'reject') {
    throw new CostExceededError(decision.capUsd, decision.dailyUsd);
  }
}

function isoDateUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
