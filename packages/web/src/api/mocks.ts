import type {
  BulkCreateRepoBody,
  BulkCreateRepoResponse,
  BYOKProvider,
  CostMetrics,
  InstallationRepo,
  InstallationReposResponse,
  IntegrationsStatus,
  LlmKeyStatus,
  LlmKeysResponse,
  MetricsSince,
  OverviewMetrics,
  QualityMetrics,
  RepoDetail,
  RepoMetrics,
  RepoPrompt,
  RepoSummary,
  ReviewEvent,
  ReviewEventDetail,
  ReviewsFilters,
  ReviewsPage,
  ReviewsPageWithTotal,
} from './types.js';
import { BYOK_PROVIDERS } from './types.js';

export const mockOverview: OverviewMetrics = {
  totalRepos: 12,
  reviewsMonth: 347,
  queueDepth: 3,
  costMtd: 18.42,
};

export const mockRepos: RepoSummary[] = [
  {
    id: 'repo-001',
    platform: 'github',
    name: 'acme/api-service',
    enabled: true,
    lastReviewAt: '2026-05-28T09:14:00Z',
    lastOutcome: 'changes_requested',
  },
  {
    id: 'repo-002',
    platform: 'github',
    name: 'acme/frontend',
    enabled: true,
    lastReviewAt: '2026-05-27T16:32:00Z',
    lastOutcome: 'approved',
  },
  {
    id: 'repo-003',
    platform: 'codecommit',
    name: 'legacy/monolith',
    enabled: false,
    lastReviewAt: '2026-05-20T11:05:00Z',
    lastOutcome: 'commented',
  },
  {
    id: 'repo-004',
    platform: 'github',
    name: 'acme/infra',
    enabled: true,
    lastReviewAt: '2026-05-28T07:55:00Z',
    lastOutcome: 'approved',
  },
  {
    id: 'repo-005',
    platform: 'codecommit',
    name: 'analytics/pipeline',
    enabled: true,
    lastReviewAt: null,
    lastOutcome: null,
  },
  {
    id: 'repo-006',
    platform: 'github',
    name: 'acme/auth',
    enabled: true,
    lastReviewAt: '2026-05-26T14:22:00Z',
    lastOutcome: 'failed',
  },
];

export const mockReviews: ReviewEvent[] = [
  {
    id: 'rev-001',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 214, title: 'feat: add rate limiting to /search endpoint' },
    outcome: 'changes_requested',
    costUsd: 0.042,
    durationMs: 8320,
    createdAt: '2026-05-28T09:14:00Z',
  },
  {
    id: 'rev-002',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 88, title: 'refactor: migrate from class components to hooks' },
    outcome: 'approved',
    costUsd: 0.031,
    durationMs: 6140,
    createdAt: '2026-05-27T16:32:00Z',
  },
  {
    id: 'rev-003',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 37, title: 'fix: null pointer in UserService.getById' },
    outcome: 'commented',
    costUsd: 0.018,
    durationMs: 4280,
    createdAt: '2026-05-27T11:05:00Z',
  },
  {
    id: 'rev-004',
    repoId: 'repo-004',
    repoName: 'acme/infra',
    platform: 'github',
    pr: { number: 51, title: 'chore: rotate IAM keys and update secrets manager' },
    outcome: 'approved',
    costUsd: 0.025,
    durationMs: 5110,
    createdAt: '2026-05-28T07:55:00Z',
  },
  {
    id: 'rev-005',
    repoId: 'repo-006',
    repoName: 'acme/auth',
    platform: 'github',
    pr: { number: 129, title: 'feat: OIDC provider integration' },
    outcome: 'failed',
    costUsd: 0.0,
    durationMs: 1200,
    createdAt: '2026-05-26T14:22:00Z',
  },
  {
    id: 'rev-006',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 213, title: 'fix: memory leak in connection pool' },
    outcome: 'approved',
    costUsd: 0.028,
    durationMs: 5620,
    createdAt: '2026-05-25T13:44:00Z',
  },
  {
    id: 'rev-007',
    repoId: 'repo-005',
    repoName: 'analytics/pipeline',
    platform: 'codecommit',
    pr: { number: 12, title: 'feat: add Kinesis firehose sink' },
    outcome: 'changes_requested',
    costUsd: 0.038,
    durationMs: 7800,
    createdAt: '2026-05-24T10:00:00Z',
  },
  {
    id: 'rev-008',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 89, title: 'fix: broken responsive layout on mobile' },
    outcome: 'approved',
    costUsd: 0.022,
    durationMs: 4910,
    createdAt: '2026-05-24T08:30:00Z',
  },
  {
    id: 'rev-009',
    repoId: 'repo-004',
    repoName: 'acme/infra',
    platform: 'github',
    pr: { number: 52, title: 'feat: add cloudwatch alarm for API latency' },
    outcome: 'commented',
    costUsd: 0.019,
    durationMs: 4020,
    createdAt: '2026-05-23T17:45:00Z',
  },
  {
    id: 'rev-010',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 38, title: 'chore: upgrade log4j to 2.20' },
    outcome: 'approved',
    costUsd: 0.015,
    durationMs: 3500,
    createdAt: '2026-05-23T14:00:00Z',
  },
  {
    id: 'rev-011',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 215, title: 'fix: race condition in session store' },
    outcome: 'changes_requested',
    costUsd: 0.045,
    durationMs: 9100,
    createdAt: '2026-05-22T11:20:00Z',
  },
  {
    id: 'rev-012',
    repoId: 'repo-006',
    repoName: 'acme/auth',
    platform: 'github',
    pr: { number: 130, title: 'fix: token refresh loop on expiry' },
    outcome: 'approved',
    costUsd: 0.033,
    durationMs: 6700,
    createdAt: '2026-05-22T09:00:00Z',
  },
  {
    id: 'rev-013',
    repoId: 'repo-005',
    repoName: 'analytics/pipeline',
    platform: 'codecommit',
    pr: { number: 13, title: 'perf: vectorize aggregation step' },
    outcome: 'approved',
    costUsd: 0.029,
    durationMs: 5800,
    createdAt: '2026-05-21T16:10:00Z',
  },
  {
    id: 'rev-014',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 90, title: 'feat: dark mode toggle' },
    outcome: 'commented',
    costUsd: 0.021,
    durationMs: 4600,
    createdAt: '2026-05-21T13:40:00Z',
  },
  {
    id: 'rev-015',
    repoId: 'repo-004',
    repoName: 'acme/infra',
    platform: 'github',
    pr: { number: 53, title: 'chore: bump terraform aws provider to 5.x' },
    outcome: 'failed',
    costUsd: 0.0,
    durationMs: 900,
    createdAt: '2026-05-21T10:00:00Z',
  },
  {
    id: 'rev-016',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 39, title: 'feat: expose REST endpoint for batch import' },
    outcome: 'changes_requested',
    costUsd: 0.041,
    durationMs: 8600,
    createdAt: '2026-05-20T15:30:00Z',
  },
  {
    id: 'rev-017',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 216, title: 'docs: improve OpenAPI spec coverage' },
    outcome: 'approved',
    costUsd: 0.017,
    durationMs: 3800,
    createdAt: '2026-05-20T11:15:00Z',
  },
  {
    id: 'rev-018',
    repoId: 'repo-006',
    repoName: 'acme/auth',
    platform: 'github',
    pr: { number: 131, title: 'fix: CSP header missing nonce' },
    outcome: 'changes_requested',
    costUsd: 0.036,
    durationMs: 7200,
    createdAt: '2026-05-19T14:50:00Z',
  },
  {
    id: 'rev-019',
    repoId: 'repo-005',
    repoName: 'analytics/pipeline',
    platform: 'codecommit',
    pr: { number: 14, title: 'fix: off-by-one in sliding window reducer' },
    outcome: 'approved',
    costUsd: 0.026,
    durationMs: 5300,
    createdAt: '2026-05-19T09:20:00Z',
  },
  {
    id: 'rev-020',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 91, title: 'test: add e2e smoke tests for checkout flow' },
    outcome: 'approved',
    costUsd: 0.024,
    durationMs: 5000,
    createdAt: '2026-05-18T17:00:00Z',
  },
  {
    id: 'rev-021',
    repoId: 'repo-004',
    repoName: 'acme/infra',
    platform: 'github',
    pr: { number: 54, title: 'feat: enable S3 versioning on assets bucket' },
    outcome: 'commented',
    costUsd: 0.02,
    durationMs: 4400,
    createdAt: '2026-05-18T13:15:00Z',
  },
  {
    id: 'rev-022',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 40, title: 'fix: handle empty result set in pagination' },
    outcome: 'approved',
    costUsd: 0.016,
    durationMs: 3600,
    createdAt: '2026-05-17T10:30:00Z',
  },
  {
    id: 'rev-023',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 217, title: 'feat: structured logging with correlation IDs' },
    outcome: 'changes_requested',
    costUsd: 0.044,
    durationMs: 8900,
    createdAt: '2026-05-17T08:00:00Z',
  },
  {
    id: 'rev-024',
    repoId: 'repo-006',
    repoName: 'acme/auth',
    platform: 'github',
    pr: { number: 132, title: 'chore: remove deprecated OAuth1 code path' },
    outcome: 'approved',
    costUsd: 0.023,
    durationMs: 4700,
    createdAt: '2026-05-16T16:45:00Z',
  },
  {
    id: 'rev-025',
    repoId: 'repo-005',
    repoName: 'analytics/pipeline',
    platform: 'codecommit',
    pr: { number: 15, title: 'feat: emit OpenTelemetry spans' },
    outcome: 'commented',
    costUsd: 0.027,
    durationMs: 5400,
    createdAt: '2026-05-16T12:00:00Z',
  },
  {
    id: 'rev-026',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 92, title: 'fix: avatar fallback shows wrong initials' },
    outcome: 'approved',
    costUsd: 0.013,
    durationMs: 2900,
    createdAt: '2026-05-15T15:10:00Z',
  },
  {
    id: 'rev-027',
    repoId: 'repo-004',
    repoName: 'acme/infra',
    platform: 'github',
    pr: { number: 55, title: 'fix: ALB security group allows 0.0.0.0 on port 22' },
    outcome: 'changes_requested',
    costUsd: 0.047,
    durationMs: 9400,
    createdAt: '2026-05-15T10:20:00Z',
  },
  {
    id: 'rev-028',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 41, title: 'perf: add index on orders.created_at' },
    outcome: 'approved',
    costUsd: 0.018,
    durationMs: 3900,
    createdAt: '2026-05-14T14:00:00Z',
  },
  {
    id: 'rev-029',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 218, title: 'fix: deadlock in distributed lock service' },
    outcome: 'failed',
    costUsd: 0.0,
    durationMs: 1100,
    createdAt: '2026-05-14T09:30:00Z',
  },
  {
    id: 'rev-030',
    repoId: 'repo-006',
    repoName: 'acme/auth',
    platform: 'github',
    pr: { number: 133, title: 'feat: MFA enforcement for admin accounts' },
    outcome: 'approved',
    costUsd: 0.039,
    durationMs: 7900,
    createdAt: '2026-05-13T17:00:00Z',
  },
  {
    id: 'rev-031',
    repoId: 'repo-005',
    repoName: 'analytics/pipeline',
    platform: 'codecommit',
    pr: { number: 16, title: 'fix: schema drift in Glue catalog' },
    outcome: 'changes_requested',
    costUsd: 0.035,
    durationMs: 7100,
    createdAt: '2026-05-13T11:45:00Z',
  },
  {
    id: 'rev-032',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 93, title: 'feat: lazy-load product images' },
    outcome: 'approved',
    costUsd: 0.02,
    durationMs: 4200,
    createdAt: '2026-05-12T13:00:00Z',
  },
  {
    id: 'rev-033',
    repoId: 'repo-004',
    repoName: 'acme/infra',
    platform: 'github',
    pr: { number: 56, title: 'chore: migrate to ECR private registry' },
    outcome: 'approved',
    costUsd: 0.024,
    durationMs: 4800,
    createdAt: '2026-05-12T09:10:00Z',
  },
  {
    id: 'rev-034',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 42, title: 'fix: session cookie missing SameSite attribute' },
    outcome: 'changes_requested',
    costUsd: 0.04,
    durationMs: 8000,
    createdAt: '2026-05-11T16:30:00Z',
  },
  {
    id: 'rev-035',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 219, title: 'refactor: extract pagination helper to shared lib' },
    outcome: 'approved',
    costUsd: 0.03,
    durationMs: 6000,
    createdAt: '2026-05-11T10:00:00Z',
  },
  {
    id: 'rev-036',
    repoId: 'repo-006',
    repoName: 'acme/auth',
    platform: 'github',
    pr: { number: 134, title: 'fix: SAML assertion expiry not checked' },
    outcome: 'changes_requested',
    costUsd: 0.048,
    durationMs: 9600,
    createdAt: '2026-05-10T15:00:00Z',
  },
  {
    id: 'rev-037',
    repoId: 'repo-005',
    repoName: 'analytics/pipeline',
    platform: 'codecommit',
    pr: { number: 17, title: 'feat: DLQ for failed transform messages' },
    outcome: 'approved',
    costUsd: 0.032,
    durationMs: 6400,
    createdAt: '2026-05-10T11:30:00Z',
  },
  {
    id: 'rev-038',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 94, title: 'fix: price rounding error on cart total' },
    outcome: 'approved',
    costUsd: 0.019,
    durationMs: 3700,
    createdAt: '2026-05-09T14:00:00Z',
  },
  {
    id: 'rev-039',
    repoId: 'repo-004',
    repoName: 'acme/infra',
    platform: 'github',
    pr: { number: 57, title: 'feat: WAF rule set for OWASP Top 10' },
    outcome: 'commented',
    costUsd: 0.026,
    durationMs: 5200,
    createdAt: '2026-05-09T09:45:00Z',
  },
  {
    id: 'rev-040',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 43, title: 'chore: remove unused Spring Boot starters' },
    outcome: 'approved',
    costUsd: 0.014,
    durationMs: 3100,
    createdAt: '2026-05-08T12:00:00Z',
  },
];

export const mockIntegrations: IntegrationsStatus = {
  github: {
    configured: true,
    appId: 'app-12345',
    appSlug: 'my-review-agent',
    installationCount: 4,
  },
  codecommit: {
    configured: true,
    region: 'us-east-1',
  },
  llm: {
    configured: true,
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
  },
};

const SAMPLE_SYSTEM_PROMPT = `You are an expert software engineer performing a thorough code review. Your goal is to identify bugs, security vulnerabilities, performance issues, and maintainability concerns.

When reviewing code, focus on:
1. Correctness: Does the code do what it claims? Are edge cases handled?
2. Security: SQL injection, XSS, CSRF, authentication flaws, unsafe deserialization.
3. Performance: N+1 queries, unnecessary re-renders, unbounded loops, memory leaks.
4. Maintainability: Code clarity, naming conventions, SOLID principles, test coverage.
5. Error handling: Are errors propagated correctly? Are failure modes considered?

Be specific and actionable. Reference line numbers when possible. For each issue, indicate severity: [CRITICAL], [HIGH], [MEDIUM], or [LOW].

Approve only when all critical and high-severity issues are addressed. Request changes with clear, actionable feedback.`;

type RepoPromptStore = { systemPrompt: string; updatedAt: string | null };
const promptStore = new Map<string, RepoPromptStore>([
  ['repo-001', { systemPrompt: SAMPLE_SYSTEM_PROMPT, updatedAt: '2026-05-20T10:00:00Z' }],
]);

let repoStore: RepoSummary[] = [...mockRepos];

export function getMockRepos(): RepoSummary[] {
  return repoStore;
}

export function addMockRepo(platform: RepoSummary['platform'], name: string): RepoSummary {
  const repo: RepoSummary = {
    id: `repo-${Date.now()}`,
    platform,
    name,
    enabled: true,
    lastReviewAt: null,
    lastOutcome: null,
  };
  repoStore = [...repoStore, repo];
  return repo;
}

export function patchMockRepo(id: string, patch: { enabled?: boolean }): RepoSummary | null {
  const idx = repoStore.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const updated = { ...repoStore[idx], ...patch } as RepoSummary;
  repoStore = repoStore.map((r) => (r.id === id ? updated : r));
  return updated;
}

export function deleteMockRepo(id: string): boolean {
  const before = repoStore.length;
  repoStore = repoStore.filter((r) => r.id !== id);
  return repoStore.length < before;
}

export function getMockRepoDetail(id: string): RepoDetail | null {
  const base = repoStore.find((r) => r.id === id);
  if (!base) return null;
  return {
    ...base,
    createdAt: '2026-01-15T08:00:00Z',
    updatedAt: '2026-05-28T09:00:00Z',
    systemPromptPresent: promptStore.has(id),
  };
}

export function getMockRepoMetrics(id: string): RepoMetrics {
  const reviews = mockReviews.filter((r) => r.repoId === id);
  const total = reviews.length;
  const now = Date.now();
  const last30 = reviews.filter(
    (r) => now - new Date(r.createdAt).getTime() < 30 * 86_400_000,
  ).length;
  const avgDuration =
    total > 0 ? Math.round(reviews.reduce((s, r) => s + r.durationMs, 0) / total) : 0;
  const totalCost = reviews.reduce((s, r) => s + r.costUsd, 0);
  return {
    totalReviews: total,
    reviewsLast30d: last30,
    avgDurationMs: avgDuration,
    totalCostUsd: totalCost,
  };
}

export function getMockRepoPrompt(id: string): RepoPrompt {
  const stored = promptStore.get(id);
  return stored ?? { systemPrompt: '', updatedAt: null };
}

export function putMockRepoPrompt(id: string, systemPrompt: string): RepoPrompt {
  const updatedAt = new Date().toISOString();
  promptStore.set(id, { systemPrompt, updatedAt });
  return { systemPrompt, updatedAt };
}

/** @deprecated Use getMockReviews(ReviewsFilters) instead. Kept for backward compatibility. */
export function getMockReviews(limit: number, cursor: string | null): ReviewsPage;
export function getMockReviews(filters: ReviewsFilters): ReviewsPageWithTotal;
export function getMockReviews(
  filtersOrLimit: ReviewsFilters | number,
  cursor: string | null = null,
): ReviewsPage | ReviewsPageWithTotal {
  const filters: ReviewsFilters =
    typeof filtersOrLimit === 'number' ? { limit: filtersOrLimit, cursor } : filtersOrLimit;

  const limit = filters.limit ?? 50;
  const cur = filters.cursor ?? null;

  let all: readonly ReviewEvent[] = mockReviews;

  if (filters.platform && filters.platform !== 'all') {
    all = all.filter((r) => r.platform === filters.platform);
  }
  if (filters.outcome && filters.outcome !== 'all') {
    all = all.filter((r) => r.outcome === filters.outcome);
  }
  if (filters.repoQuery) {
    const q = filters.repoQuery.toLowerCase();
    all = all.filter((r) => r.repoName.toLowerCase().includes(q));
  }
  if (filters.since && filters.since !== 'all') {
    const now = Date.now();
    const msMap: Record<string, number> = {
      '24h': 86_400_000,
      '7d': 604_800_000,
      '30d': 2_592_000_000,
    };
    const ms = msMap[filters.since];
    if (ms !== undefined) {
      all = all.filter((r) => now - new Date(r.createdAt).getTime() < ms);
    }
  }

  const total = all.length;
  const start = cur ? all.findIndex((r) => r.id === cur) + 1 : 0;
  const items = all.slice(start, start + limit);
  const nextCursor = start + limit < all.length ? (items[items.length - 1]?.id ?? null) : null;

  if (typeof filtersOrLimit === 'number') {
    return { items, nextCursor } satisfies ReviewsPage;
  }
  return { items, nextCursor, total } satisfies ReviewsPageWithTotal;
}

export const mockReviewEventDetails: Record<string, ReviewEventDetail> = {
  'rev-001': {
    id: 'rev-001',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 214, title: 'feat: add rate limiting to /search endpoint' },
    outcome: 'changes_requested',
    costUsd: 0.042,
    durationMs: 8320,
    createdAt: '2026-05-28T09:14:00Z',
    summary:
      'Found 2 high-severity issues: rate limiter does not persist state across restarts, and the sliding window algorithm has an off-by-one edge case.',
    comments: [
      {
        path: 'src/middleware/rate-limit.ts',
        line: 42,
        body: '[HIGH] The in-memory counter resets on every deploy. Use Redis or a persistent store.',
      },
      {
        path: 'src/middleware/rate-limit.ts',
        line: 87,
        body: '[HIGH] Sliding window end boundary is exclusive but the spec requires inclusive. Off-by-one will let 1 extra request through per window.',
      },
      {
        path: 'src/routes/search.ts',
        line: 15,
        body: '[LOW] Consider extracting the rate limit config into a typed constant for easier tuning.',
      },
    ],
    toolCalls: [
      { name: 'read_file', count: 8 },
      { name: 'grep', count: 3 },
      { name: 'glob', count: 1 },
    ],
    tokens: { prompt: 12400, completion: 890, total: 13290 },
    timing: {
      queuedAt: '2026-05-28T09:13:45Z',
      startedAt: '2026-05-28T09:13:48Z',
      completedAt: '2026-05-28T09:14:00Z',
    },
    provider: { name: 'anthropic', model: 'claude-sonnet-4-5' },
    systemPromptAtReview: SAMPLE_SYSTEM_PROMPT,
    externalUrl: 'https://github.com/acme/api-service/pull/214',
  },
  'rev-002': {
    id: 'rev-002',
    repoId: 'repo-002',
    repoName: 'acme/frontend',
    platform: 'github',
    pr: { number: 88, title: 'refactor: migrate from class components to hooks' },
    outcome: 'approved',
    costUsd: 0.031,
    durationMs: 6140,
    createdAt: '2026-05-27T16:32:00Z',
    summary:
      'Clean refactor. All class lifecycle methods correctly translated to hooks. One minor suggestion on memoization.',
    comments: [
      {
        path: 'src/components/UserCard.tsx',
        line: 31,
        body: '[LOW] The user object is reconstructed on every render. Wrap with useMemo to avoid unnecessary downstream re-renders.',
      },
    ],
    toolCalls: [
      { name: 'read_file', count: 6 },
      { name: 'glob', count: 2 },
    ],
    tokens: { prompt: 9800, completion: 640, total: 10440 },
    timing: {
      queuedAt: '2026-05-27T16:31:50Z',
      startedAt: '2026-05-27T16:31:53Z',
      completedAt: '2026-05-27T16:32:00Z',
    },
    provider: { name: 'anthropic', model: 'claude-sonnet-4-5' },
    systemPromptAtReview: null,
    externalUrl: 'https://github.com/acme/frontend/pull/88',
  },
  'rev-003': {
    id: 'rev-003',
    repoId: 'repo-003',
    repoName: 'legacy/monolith',
    platform: 'codecommit',
    pr: { number: 37, title: 'fix: null pointer in UserService.getById' },
    outcome: 'commented',
    costUsd: 0.018,
    durationMs: 4280,
    createdAt: '2026-05-27T11:05:00Z',
    summary: 'Fix is correct. Left general observation about null safety patterns in the codebase.',
    comments: [],
    toolCalls: [
      { name: 'read_file', count: 4 },
      { name: 'grep', count: 2 },
    ],
    tokens: { prompt: 5600, completion: 320, total: 5920 },
    timing: {
      queuedAt: '2026-05-27T11:04:45Z',
      startedAt: '2026-05-27T11:04:47Z',
      completedAt: '2026-05-27T11:05:00Z',
    },
    provider: { name: 'anthropic', model: 'claude-sonnet-4-5' },
    systemPromptAtReview: SAMPLE_SYSTEM_PROMPT,
    externalUrl:
      'https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/legacy-monolith/pull-requests/37',
  },
  'rev-005': {
    id: 'rev-005',
    repoId: 'repo-006',
    repoName: 'acme/auth',
    platform: 'github',
    pr: { number: 129, title: 'feat: OIDC provider integration' },
    outcome: 'failed',
    costUsd: 0.0,
    durationMs: 1200,
    createdAt: '2026-05-26T14:22:00Z',
    summary: null,
    comments: [],
    toolCalls: [],
    tokens: { prompt: 0, completion: 0, total: 0 },
    timing: {
      queuedAt: '2026-05-26T14:22:00Z',
      startedAt: '2026-05-26T14:22:01Z',
      completedAt: null,
    },
    provider: { name: 'anthropic', model: 'claude-sonnet-4-5' },
    systemPromptAtReview: null,
    externalUrl: 'https://github.com/acme/auth/pull/129',
  },
  'rev-006': {
    id: 'rev-006',
    repoId: 'repo-001',
    repoName: 'acme/api-service',
    platform: 'github',
    pr: { number: 213, title: 'fix: memory leak in connection pool' },
    outcome: 'approved',
    costUsd: 0.028,
    durationMs: 5620,
    createdAt: '2026-05-25T13:44:00Z',
    summary:
      'Root cause correctly identified and fixed. Pool is now properly bounded and connections are released on error paths.',
    comments: [
      {
        path: 'src/db/pool.ts',
        line: 58,
        body: '[LOW] Consider adding a pool exhaustion metric for alerting.',
      },
      {
        path: 'src/db/pool.ts',
        line: 73,
        body: '[LOW] The finally block is good, but also consider whether the error should be re-thrown here.',
      },
    ],
    toolCalls: [
      { name: 'read_file', count: 5 },
      { name: 'grep', count: 4 },
    ],
    tokens: { prompt: 8700, completion: 580, total: 9280 },
    timing: {
      queuedAt: '2026-05-25T13:43:50Z',
      startedAt: '2026-05-25T13:43:53Z',
      completedAt: '2026-05-25T13:44:00Z',
    },
    provider: { name: 'anthropic', model: 'claude-sonnet-4-5' },
    systemPromptAtReview: SAMPLE_SYSTEM_PROMPT,
    externalUrl: 'https://github.com/acme/api-service/pull/213',
  },
};

export function getMockReviewDetail(id: string): ReviewEventDetail | null {
  return mockReviewEventDetails[id] ?? null;
}

// --- BYOK LLM keys ---

// Per-installationId in-memory store: Map<installationId, Map<provider, configured>>
const llmKeyStore = new Map<number, Map<BYOKProvider, boolean>>();

function getOrCreateInstallationStore(installationId: number): Map<BYOKProvider, boolean> {
  let store = llmKeyStore.get(installationId);
  if (!store) {
    store = new Map<BYOKProvider, boolean>();
    llmKeyStore.set(installationId, store);
  }
  return store;
}

export function getMockLlmKeys(installationId: number): LlmKeysResponse {
  const store = getOrCreateInstallationStore(installationId);
  const keys: LlmKeyStatus[] = BYOK_PROVIDERS.map((provider) => ({
    provider,
    configured: store.get(provider) ?? false,
  }));
  return { installationId, keys };
}

export function upsertMockLlmKey(installationId: number, provider: BYOKProvider): void {
  const store = getOrCreateInstallationStore(installationId);
  store.set(provider, true);
}

export function rotateMockLlmKey(installationId: number, provider: BYOKProvider): void {
  // Rotate: key must already exist; re-wrap is a no-op in mock (stays configured).
  const store = getOrCreateInstallationStore(installationId);
  if (!store.get(provider)) {
    throw new Error(`No key configured for provider ${provider} on installation ${installationId}`);
  }
  store.set(provider, true);
}

export function deleteMockLlmKey(installationId: number, provider: BYOKProvider): void {
  const store = getOrCreateInstallationStore(installationId);
  store.set(provider, false);
}

// --- GitHub App onboarding mocks ---

const mockInstallationRepos: InstallationRepo[] = [
  { id: 100001, fullName: 'acme/api-service', private: false, registered: true },
  { id: 100002, fullName: 'acme/frontend', private: false, registered: true },
  { id: 100003, fullName: 'acme/backend', private: true, registered: false },
  { id: 100004, fullName: 'acme/infra', private: true, registered: false },
  { id: 100005, fullName: 'acme/docs', private: false, registered: false },
];

export function getMockInstallationRepos(installationId: number): InstallationReposResponse {
  void installationId;
  return { repos: mockInstallationRepos };
}

// --- Quality metrics mocks ---

export function getMockQualityMetrics(
  _installationId: number,
  since: MetricsSince,
): QualityMetrics {
  return {
    period: since,
    overall: {
      reviewCount: 347,
      acceptanceRate: 0.68,
      falsePositiveRate: 0.12,
      coverageRate: 0.84,
      latencyP50Ms: 5200,
      latencyP95Ms: 9400,
    },
    perRepo: [
      {
        repo: 'acme/api-service',
        reviewCount: 82,
        acceptanceRate: 0.61,
        falsePositiveRate: 0.15,
        coverageRate: 0.9,
        latencyP50Ms: 6100,
        latencyP95Ms: 9000,
      },
      {
        repo: 'acme/frontend',
        reviewCount: 74,
        acceptanceRate: 0.73,
        falsePositiveRate: 0.09,
        coverageRate: 0.78,
        latencyP50Ms: 4800,
        latencyP95Ms: 8200,
      },
      {
        repo: 'legacy/monolith',
        reviewCount: 58,
        acceptanceRate: 0.69,
        falsePositiveRate: null,
        coverageRate: null,
        latencyP50Ms: 5500,
        latencyP95Ms: 9600,
      },
      {
        repo: 'acme/infra',
        reviewCount: 71,
        acceptanceRate: 0.72,
        falsePositiveRate: 0.1,
        coverageRate: 0.88,
        latencyP50Ms: 4900,
        latencyP95Ms: 8800,
      },
      {
        repo: 'analytics/pipeline',
        reviewCount: 33,
        acceptanceRate: null,
        falsePositiveRate: null,
        coverageRate: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
      },
      {
        repo: 'acme/auth',
        reviewCount: 29,
        acceptanceRate: 0.62,
        falsePositiveRate: 0.14,
        coverageRate: 0.81,
        latencyP50Ms: 5600,
        latencyP95Ms: 9400,
      },
    ],
  };
}

// --- Cost analytics mocks ---

export function getMockCostMetrics(_installationId: number, since: MetricsSince): CostMetrics {
  return {
    period: since,
    overall: {
      totalCostUsd: 18.42,
      totalInputTokens: 2_840_000,
      totalOutputTokens: 198_000,
      totalCacheReadTokens: 520_000,
      totalCacheCreationTokens: 310_000,
      callCount: 347,
      budgetAlertUsd: null,
    },
    perModel: [
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        costUsd: 15.2,
        callCount: 290,
      },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        costUsd: 3.22,
        callCount: 57,
      },
    ],
    perRepo: [
      { repo: 'acme/api-service', costUsd: 4.8 },
      { repo: 'acme/auth', costUsd: 3.9 },
      { repo: 'acme/infra', costUsd: 3.5 },
      { repo: 'acme/frontend', costUsd: 2.8 },
      { repo: 'legacy/monolith', costUsd: 2.1 },
      { repo: 'analytics/pipeline', costUsd: 1.32 },
    ],
    nextCursor: null,
    perPeriod: [
      { bucket: '2026-05-06T00:00:00.000Z', costUsd: 0.42 },
      { bucket: '2026-05-07T00:00:00.000Z', costUsd: 0.61 },
      { bucket: '2026-05-08T00:00:00.000Z', costUsd: 0.38 },
      { bucket: '2026-05-09T00:00:00.000Z', costUsd: 0.72 },
      { bucket: '2026-05-10T00:00:00.000Z', costUsd: 0.55 },
      { bucket: '2026-05-11T00:00:00.000Z', costUsd: 0.88 },
      { bucket: '2026-05-12T00:00:00.000Z', costUsd: 0.63 },
      { bucket: '2026-05-13T00:00:00.000Z', costUsd: 0.79 },
      { bucket: '2026-05-14T00:00:00.000Z', costUsd: 0.47 },
      { bucket: '2026-05-15T00:00:00.000Z', costUsd: 0.91 },
      { bucket: '2026-05-16T00:00:00.000Z', costUsd: 0.68 },
      { bucket: '2026-05-17T00:00:00.000Z', costUsd: 0.84 },
      { bucket: '2026-05-18T00:00:00.000Z', costUsd: 0.52 },
      { bucket: '2026-05-19T00:00:00.000Z', costUsd: 0.76 },
      { bucket: '2026-05-20T00:00:00.000Z', costUsd: 0.93 },
      { bucket: '2026-05-21T00:00:00.000Z', costUsd: 0.44 },
      { bucket: '2026-05-22T00:00:00.000Z', costUsd: 0.67 },
      { bucket: '2026-05-23T00:00:00.000Z', costUsd: 0.81 },
      { bucket: '2026-05-24T00:00:00.000Z', costUsd: 0.58 },
      { bucket: '2026-05-25T00:00:00.000Z', costUsd: 0.74 },
      { bucket: '2026-05-26T00:00:00.000Z', costUsd: 0.96 },
      { bucket: '2026-05-27T00:00:00.000Z', costUsd: 0.62 },
      { bucket: '2026-05-28T00:00:00.000Z', costUsd: 0.86 },
    ],
  };
}

/** Sentinel name: triggers a simulated error entry in bulkCreateMockRepos (207 path). */
export const MOCK_BULK_CREATE_ERROR_SENTINEL = '__error__';

export function bulkCreateMockRepos(body: BulkCreateRepoBody): BulkCreateRepoResponse {
  const created: string[] = [];
  const alreadyExists: string[] = [];
  const errors: { name: string; message: string }[] = [];

  for (const name of body.names) {
    if (name === MOCK_BULK_CREATE_ERROR_SENTINEL) {
      errors.push({ name, message: 'simulated registration failure' });
    } else {
      const existing = mockInstallationRepos.find((r) => r.fullName === name);
      if (existing?.registered) {
        alreadyExists.push(name);
      } else {
        created.push(name);
      }
    }
  }

  return { created, alreadyExists, errors };
}
