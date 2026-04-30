export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SIDES = ['LEFT', 'RIGHT'] as const;
export type Side = (typeof SIDES)[number];

export type InlineComment = {
  readonly path: string;
  readonly line: number;
  readonly side: Side;
  readonly severity: Severity;
  readonly title: string;
  readonly body: string;
  readonly suggestion: string | null;
  readonly category: string;
};

export type ReviewPayload = {
  readonly summary: string;
  readonly comments: ReadonlyArray<InlineComment>;
};

export type ReviewState = {
  readonly schemaVersion: 1;
  readonly headSha: string;
  readonly baseSha: string;
  readonly fingerprints: ReadonlyArray<string>;
  readonly reviewedAt: string;
  readonly costUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly model: string;
  readonly provider: string;
};

export type CostLedgerRow = {
  readonly id: string;
  readonly installationId: string | null;
  readonly repo: string;
  readonly prNumber: number;
  readonly provider: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cachedTokensIn: number;
  readonly costUsd: number;
  readonly createdAt: string;
};
