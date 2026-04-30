import type { COST_LEDGER_PHASES, COST_LEDGER_STATUSES } from './review.js';

export type CostLedgerPhase = (typeof COST_LEDGER_PHASES)[number];
export type CostLedgerStatus = (typeof COST_LEDGER_STATUSES)[number];

export type RecordPhaseInput = {
  readonly installationId: bigint;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
  readonly callPhase: CostLedgerPhase;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreationTokens?: number;
  readonly costUsd: number;
  readonly status: CostLedgerStatus;
};

export type CostLedgerRecorder = (input: RecordPhaseInput) => Promise<void>;

export type CostTotals = {
  readonly running: number;
  readonly daily: number;
};

export type CostTotalsReader = (q: {
  installationId: bigint;
  jobId: string;
  date: string;
}) => Promise<CostTotals>;

export type CostGuardDecision =
  | { kind: 'proceed' }
  | { kind: 'fallback'; reason: 'soft_cap' }
  | { kind: 'abort'; reason: 'cost_exceeded' | 'daily_cap'; runningUsd: number; capUsd: number }
  | { kind: 'kill'; reason: 'kill_switch'; runningUsd: number; capUsd: number };

const FALLBACK_RATIO = 0.8;
const ABORT_RATIO = 1.0;
const KILL_RATIO = 1.5;

export type DecideCostInput = {
  readonly running: number;
  readonly estimate: number;
  readonly perPrCap: number;
  readonly daily: number;
  readonly dailyCap: number;
};

export function decideCostAction(input: DecideCostInput): CostGuardDecision {
  const projected = input.running + input.estimate;
  if (input.dailyCap > 0 && input.daily >= input.dailyCap) {
    return { kind: 'abort', reason: 'daily_cap', runningUsd: input.daily, capUsd: input.dailyCap };
  }
  if (input.perPrCap <= 0) return { kind: 'proceed' };
  if (input.running > input.perPrCap * KILL_RATIO) {
    return {
      kind: 'kill',
      reason: 'kill_switch',
      runningUsd: input.running,
      capUsd: input.perPrCap,
    };
  }
  if (projected > input.perPrCap * ABORT_RATIO) {
    return {
      kind: 'abort',
      reason: 'cost_exceeded',
      runningUsd: projected,
      capUsd: input.perPrCap,
    };
  }
  if (projected > input.perPrCap * FALLBACK_RATIO) {
    return { kind: 'fallback', reason: 'soft_cap' };
  }
  return { kind: 'proceed' };
}

export const COST_THRESHOLDS = {
  fallback: FALLBACK_RATIO,
  abort: ABORT_RATIO,
  kill: KILL_RATIO,
} as const;
