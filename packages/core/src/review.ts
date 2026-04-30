export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SIDES = ['LEFT', 'RIGHT'] as const;
export type Side = (typeof SIDES)[number];

export type InlineComment = {
  readonly path: string;
  readonly line: number;
  readonly side: Side;
  readonly body: string;
  readonly fingerprint: string;
  readonly severity: Severity;
  readonly suggestion?: string;
};

export type ReviewState = {
  readonly schemaVersion: 1;
  readonly lastReviewedSha: string;
  readonly baseSha: string;
  readonly reviewedAt: string;
  readonly modelUsed: string;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly commentFingerprints: ReadonlyArray<string>;
};

export type ReviewPayload = {
  readonly comments: ReadonlyArray<InlineComment>;
  readonly summary: string;
  readonly state: ReviewState;
};

export const COST_LEDGER_PHASES = ['injection_detect', 'review_main', 'review_retry'] as const;
export type CostLedgerPhase = (typeof COST_LEDGER_PHASES)[number];

export const COST_LEDGER_STATUSES = ['success', 'failed', 'cancelled', 'cost_exceeded'] as const;
export type CostLedgerStatus = (typeof COST_LEDGER_STATUSES)[number];

export type CostLedgerRow = {
  readonly installationId: bigint;
  readonly jobId: string;
  readonly provider: string;
  readonly model: string;
  readonly callPhase: CostLedgerPhase;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly costUsd: number;
  readonly status: CostLedgerStatus;
  readonly createdAt: Date;
};
