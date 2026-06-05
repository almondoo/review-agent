import { z } from 'zod';

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/**
 * Derive the review outcome label from an `abort_reason` value.
 * When `abortReason` is null the review completed normally → `'commented'`.
 * When aborted → `'failed'`.
 *
 * Richer mapping (`approved` / `changes_requested`) requires per-review
 * outcome data not yet stored in `review_eval_event` — Phase 2 enhancement.
 */
export function deriveOutcome(
  abortReason: string | null,
): 'approved' | 'changes_requested' | 'commented' | 'failed' {
  return abortReason !== null ? 'failed' : 'commented';
}

// ---------------------------------------------------------------------------
// Shared value-object schemas
// ---------------------------------------------------------------------------

export const platformSchema = z.union([z.literal('github'), z.literal('codecommit')]);

export const outcomeSchema = z.union([
  z.literal('approved'),
  z.literal('changes_requested'),
  z.literal('commented'),
  z.literal('failed'),
]);

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

export const createRepoBodySchema = z.object({
  platform: platformSchema,
  name: z.string().min(1).max(200),
});

export const patchRepoBodySchema = z.object({
  enabled: z.boolean().optional(),
});

export const putPromptBodySchema = z.object({
  systemPrompt: z.string().max(50000),
});

/**
 * `since` accepts either an ISO-8601 date-time string or a shorthand
 * alias (`24h`, `7d`, `30d`). Shorthand aliases are resolved to an
 * absolute Date in the route handler after parsing.
 */
const sinceAliasSchema = z.union([z.literal('24h'), z.literal('7d'), z.literal('30d')]);
const sinceSchema = z.union([sinceAliasSchema, z.string().datetime({ offset: true })]);

// @public — keep aliases in sync with web ReviewsFilters since field
export function resolveSince(since: string, now: Date): Date {
  if (since === '24h') return new Date(now.getTime() - 24 * 60 * 60 * 1000);
  if (since === '7d') return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (since === '30d') return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return new Date(since);
}

export const reviewsQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v !== undefined ? Number(v) : 50;
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 200) : 50;
    }),
  cursor: z.string().optional(),
  platform: platformSchema.optional(),
  outcome: outcomeSchema.optional(),
  repoQuery: z.string().optional(),
  since: sinceSchema.optional(),
});

// ---------------------------------------------------------------------------
// Response shape types (shared with frontend via generated types)
// ---------------------------------------------------------------------------

export type RepoSummary = {
  id: string;
  platform: 'github' | 'codecommit';
  name: string;
  enabled: boolean;
  lastReviewAt: string | null;
  lastOutcome: 'approved' | 'changes_requested' | 'commented' | 'failed' | null;
};

export type RepoDetail = RepoSummary & {
  createdAt: string;
  updatedAt: string;
  systemPromptPresent: boolean;
};

export type PromptResponse = {
  systemPrompt: string;
  updatedAt: string | null;
};

export type RepoMetrics = {
  totalReviews: number;
  reviewsLast30d: number;
  avgDurationMs: number;
  totalCostUsd: number;
};

export type ReviewEventDetail = ReviewEvent & {
  summary: string | null;
  comments: Array<{ path: string; line: number | null; body: string }>;
  toolCalls: Array<{ name: 'read_file' | 'glob' | 'grep'; count: number }>;
  tokens: { prompt: number; completion: number; total: number };
  timing: { queuedAt: string; startedAt: string | null; completedAt: string | null };
  provider: { name: string; model: string };
  /** TODO: snapshot of system prompt at review time is tracked in a separate issue.
   * Currently returns the repo's current system_prompt value. */
  systemPromptAtReview: string | null;
  externalUrl: string | null;
};

export type ReviewEvent = {
  id: string;
  repoId: string;
  repoName: string;
  platform: 'github' | 'codecommit';
  pr: { number: number; title: string };
  outcome: 'approved' | 'changes_requested' | 'commented' | 'failed';
  costUsd: number;
  durationMs: number;
  createdAt: string;
};

export type GithubIntegration = {
  configured: boolean;
  appId: string | null;
  appSlug: string | null;
  installationCount: number;
};

export type CodeCommitIntegration = {
  configured: boolean;
  region: string | null;
};

export type LlmIntegration = {
  configured: boolean;
  provider: string | null;
  model: string | null;
};

export type IntegrationsResponse = {
  github: GithubIntegration;
  codecommit: CodeCommitIntegration;
  llm: LlmIntegration;
};

export type DashboardOverview = {
  totalRepos: number;
  reviewsMonth: number;
  queueDepth: number;
  costMtd: number;
};

// ---------------------------------------------------------------------------
// Quality metrics (issue #142 Phase A)
// ---------------------------------------------------------------------------

/**
 * `since` alias accepted by `GET /api/dashboard/metrics`. Defaults to `'30d'`
 * when the query parameter is absent.
 */
export const sinceAliasValues = ['24h', '7d', '30d'] as const;
export type SinceAlias = (typeof sinceAliasValues)[number];

export const metricsQuerySchema = z.object({
  since: z
    .union([z.literal('24h'), z.literal('7d'), z.literal('30d')])
    .optional()
    .default('30d'),
});

/**
 * Per-installation / per-repo quality metric point.
 * All rate fields are in the range [0, 1] or null when not computable
 * (denominator is zero, no feedback rows, or no coverage data — graceful N/A).
 * Latency fields are in milliseconds or null when no reviews exist in the period.
 */
export type RepoQualitySnapshot = {
  /** Repository slug (e.g. `owner/repo`). Only present on per-repo rows. */
  repo?: string;
  /** Number of review runs in the requested period. */
  reviewCount: number;
  /**
   * accepted_pattern / (accepted_pattern + rejected_finding) from review_history.
   * null when no feedback rows exist in the period.
   */
  acceptanceRate: number | null;
  /**
   * (rejected_finding + suppression_rule count) / sum(comment_count).
   * null when comment_count is zero or no feedback rows exist.
   */
  falsePositiveRate: number | null;
  /**
   * sum(files_reviewed) / sum(files_total).
   * null when no rows with non-null, non-zero files_total exist (e.g. all rows
   * were recorded before migration 0013).
   */
  coverageRate: number | null;
  /**
   * P50 of review_eval_event.latency_ms (wall-clock inside runReview).
   * NOTE: this is NOT the end-to-end PR open → first comment latency; it
   * measures only the runner's internal execution time (gitleaks + LLM +
   * middleware + dedup). End-to-end queue latency is deferred to a future
   * refinement.
   */
  latencyP50Ms: number | null;
  /** P95 of review_eval_event.latency_ms. Same scope as latencyP50Ms. */
  latencyP95Ms: number | null;
};

export type QualityMetrics = {
  /** The requested period alias. */
  period: SinceAlias;
  /** Aggregated metrics across all repos for this installation. */
  overall: RepoQualitySnapshot;
  /** Per-repo breakdown. Each entry includes a `repo` field. */
  perRepo: ReadonlyArray<RepoQualitySnapshot & { repo: string }>;
};

// ---------------------------------------------------------------------------
// Cost analytics (issue #140)
// ---------------------------------------------------------------------------

/**
 * Query schema for `GET /api/dashboard/cost`.
 * `since` defaults to `'30d'`, `limit` to 20 (max 200), `cursor` is optional.
 */
export const costQuerySchema = z.object({
  since: z
    .union([z.literal('24h'), z.literal('7d'), z.literal('30d')])
    .optional()
    .default('30d'),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v !== undefined ? Number(v) : 20;
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 200) : 20;
    }),
  cursor: z.string().optional(),
});

export type ModelCostSnapshot = {
  provider: string;
  model: string;
  costUsd: number;
  callCount: number;
};

export type RepoCostSnapshot = {
  repo: string;
  costUsd: number;
};

export type PeriodCostBucket = {
  /** UTC ISO-8601 string for the bucket start (hour or day). */
  bucket: string;
  costUsd: number;
};

export type CostMetricsOverall = {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  callCount: number;
  /**
   * Set when `budget_alert_usd` is configured and the period cost exceeds it,
   * so the dashboard can highlight overspend. Null otherwise.
   */
  budgetAlertUsd: number | null;
};

export type CostMetrics = {
  /** The requested period alias. */
  period: SinceAlias;
  overall: CostMetricsOverall;
  perModel: ReadonlyArray<ModelCostSnapshot>;
  perRepo: ReadonlyArray<RepoCostSnapshot>;
  /**
   * Opaque cursor for the next page of perRepo results.
   * Null when there are no more results.
   */
  nextCursor: string | null;
  perPeriod: ReadonlyArray<PeriodCostBucket>;
};
