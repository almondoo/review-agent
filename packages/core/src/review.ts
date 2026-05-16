export const SEVERITIES = ['critical', 'major', 'minor', 'info'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const SIDES = ['LEFT', 'RIGHT'] as const;
export type Side = (typeof SIDES)[number];

/**
 * Coarse-grained confidence the model has in a finding. Operators
 * suppress noisy reviewers by setting `reviews.min_confidence` in
 * `.review-agent.yml`. When a comment omits the field it is treated
 * as `'high'` for back-compat — the existing fleet of reviews emitted
 * before this field existed should not be silently demoted.
 *
 * - `high`   — the finding is a defect by any reasonable reading.
 * - `medium` — the finding is likely a defect but depends on context the model can't fully see.
 * - `low`    — the finding is a hunch; the model is reaching.
 */
export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

/**
 * Coarse-grained taxonomy for review findings. Lets operators slice
 * "how many security findings shipped this month" without text-mining
 * comment bodies, and lets the prompt enforce category-specific rules
 * (e.g. `style` finding maxes out at `severity: 'minor'`).
 *
 * - `bug`              — incorrect behavior, off-by-one, wrong logic.
 * - `security`         — authn/authz, injection, secret leak, SSRF, crypto misuse.
 * - `performance`      — N+1 queries, accidental O(n^2), hot-loop allocation.
 * - `maintainability`  — duplication, leaky abstraction, missing test seam.
 * - `style`            — formatting, naming, idiom; never higher than `minor`.
 * - `docs`             — missing/inaccurate comments, README/JSDoc drift.
 * - `test`             — missing case, flaky test, brittle assertion.
 */
export const CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'style',
  'docs',
  'test',
] as const;
export type Category = (typeof CATEGORIES)[number];

export type InlineComment = {
  readonly path: string;
  readonly line: number;
  readonly side: Side;
  readonly body: string;
  readonly fingerprint: string;
  readonly severity: Severity;
  readonly category?: Category;
  /**
   * Model-reported confidence in the finding. Drives operator
   * suppression via `reviews.min_confidence` in `.review-agent.yml`.
   * Unset means `high` (back-compat with reviews emitted before this
   * field existed).
   */
  readonly confidence?: Confidence;
  /**
   * Stable taxonomy id for the underlying rule (e.g. `sql-injection`,
   * `null-deref`, `unused-var`). Used by the dedup middleware to
   * distinguish two findings on the same line; without it, dedup falls
   * back to severity which collides when the same line raises two
   * different issues at the same severity.
   * Format: `/^[a-z][a-z0-9-]+$/`, max 64 chars.
   */
  readonly ruleId?: string;
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

/**
 * Optional formatter: roll category counts into a markdown bullet list
 * a caller can append to the human-readable summary. Returns the empty
 * string when no comments carry a category — so the caller can safely
 * concatenate without producing a header without a body. Categories are
 * emitted in {@link CATEGORIES} order for deterministic snapshots.
 */
export function formatCategoryRollup(comments: ReadonlyArray<InlineComment>): string {
  const counts = new Map<Category, number>();
  for (const c of comments) {
    if (c.category !== undefined) {
      counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return '';
  const lines: string[] = ['### Findings by category'];
  for (const cat of CATEGORIES) {
    const n = counts.get(cat);
    if (n !== undefined && n > 0) lines.push(`- ${cat}: ${n}`);
  }
  return lines.join('\n');
}

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
