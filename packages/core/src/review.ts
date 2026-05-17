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

/**
 * Pull-request review event the VCS adapter posts alongside the
 * inline review. Mirrors GitHub's `event` parameter on the
 * `pulls.createReview` API.
 *
 * - `COMMENT`         — informational; does not block merge.
 * - `REQUEST_CHANGES` — blocks merge when the repo has the matching
 *                       branch-protection rule wired up.
 * - `APPROVE`         — never emitted by the agent (the agent does
 *                       not approve PRs; reserved for human reviewers).
 *
 * The type intentionally includes `APPROVE` so adapter implementations
 * can carry the full surface area; `computeReviewEvent` will never
 * select it.
 */
export const REVIEW_EVENTS = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

/**
 * Operator-configured threshold that decides which severity triggers
 * `REQUEST_CHANGES`. Default is `'critical'` (most conservative —
 * matches the "block on critical only" semantic).
 *
 * - `'critical'` — only `severity: 'critical'` triggers `REQUEST_CHANGES`.
 * - `'major'`    — both `'critical'` and `'major'` trigger.
 * - `'never'`    — disable the mapping; always post `COMMENT`.
 */
export const REQUEST_CHANGES_THRESHOLDS = ['critical', 'major', 'never'] as const;
export type RequestChangesThreshold = (typeof REQUEST_CHANGES_THRESHOLDS)[number];

/**
 * How Server mode materializes a per-job workspace for the LLM's
 * `read_file` / `glob` / `grep` tools (`@review-agent/server` consumes
 * this; declared in core so the config schema can validate the YAML
 * value without taking a `server` dependency).
 *
 * - `'sparse-clone'`  — `git clone --depth 1 --filter=blob:none --sparse`
 *                       scoped to the diff's changed paths. Highest
 *                       fidelity (full file tree under the changed
 *                       roots), but requires `git` on the Lambda image.
 * - `'contents-api'`  — pure Octokit: one `getFile` per changed file,
 *                       written to a tmpdir mirroring the repo layout.
 *                       No shell dependency. Best for Lambda images
 *                       that don't bundle `git`.
 * - `'none'`          — v0.2 default. No workspace; the LLM only sees
 *                       the diff text. Preserves existing Server
 *                       deployments without operator action.
 */
export const WORKSPACE_STRATEGIES = ['sparse-clone', 'contents-api', 'none'] as const;
export type WorkspaceStrategy = (typeof WORKSPACE_STRATEGIES)[number];

const SEVERITY_RANK: Readonly<Record<Severity, number>> = {
  critical: 3,
  major: 2,
  minor: 1,
  info: 0,
};

/**
 * Decide the GitHub review event from the comment list + operator
 * threshold. Pure function — no I/O. Never returns `APPROVE`.
 *
 * Algorithm:
 * - threshold `'never'` → always `COMMENT`.
 * - otherwise: `REQUEST_CHANGES` if any comment's severity is at or
 *   above the threshold rank; otherwise `COMMENT`. An empty comment
 *   list yields `COMMENT` (no findings, nothing to request changes on).
 */
export function computeReviewEvent(
  comments: ReadonlyArray<Pick<InlineComment, 'severity'>>,
  threshold: RequestChangesThreshold,
): ReviewEvent {
  if (threshold === 'never') return 'COMMENT';
  const floor = SEVERITY_RANK[threshold];
  for (const c of comments) {
    if (SEVERITY_RANK[c.severity] >= floor) return 'REQUEST_CHANGES';
  }
  return 'COMMENT';
}

export type ReviewPayload = {
  readonly comments: ReadonlyArray<InlineComment>;
  readonly summary: string;
  readonly state: ReviewState;
  /**
   * GitHub review event. Optional for back-compat: when omitted, the
   * GitHub adapter falls back to `'COMMENT'` (the v0.1 behavior).
   * Other adapters (e.g. CodeCommit) ignore the field — CodeCommit
   * does not have an equivalent merge-blocking review state on the
   * comment API.
   */
  readonly event?: ReviewEvent;
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
