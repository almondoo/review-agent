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
