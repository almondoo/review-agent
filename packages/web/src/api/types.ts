export type Platform = 'github' | 'codecommit';

// --- Auth types ---

export type Role = 'viewer' | 'editor' | 'admin';

export type Membership = {
  installationId: string;
  role: Role;
};

export type AuthPrincipal = {
  id: string;
  username: string;
};

export type AuthMeResponseSession = {
  authenticated: true;
  legacy: false;
  principal: AuthPrincipal;
  memberships: Membership[];
};

export type AuthMeResponseLegacy = {
  authenticated: true;
  legacy: true;
};

export type AuthMeResponse = AuthMeResponseSession | AuthMeResponseLegacy;

export type LoginBody = {
  username: string;
  password: string;
};

export type LoginResponse = {
  token: string;
  expiresIn: number;
};

export type Outcome = 'approved' | 'changes_requested' | 'commented' | 'failed';

export type RepoSummary = {
  id: string;
  platform: Platform;
  name: string;
  enabled: boolean;
  lastReviewAt: string | null;
  lastOutcome: Outcome | null;
};

export type ReviewEvent = {
  id: string;
  repoId: string;
  repoName: string;
  platform: Platform;
  pr: { number: number; title: string };
  outcome: Outcome;
  costUsd: number;
  durationMs: number;
  createdAt: string;
};

export type OverviewMetrics = {
  totalRepos: number;
  reviewsMonth: number;
  queueDepth: number;
  costMtd: number;
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

export type IntegrationsStatus = {
  github: GithubIntegration;
  codecommit: CodeCommitIntegration;
  llm: LlmIntegration;
};

export type ReviewsPage = {
  items: ReviewEvent[];
  nextCursor: string | null;
};

export type CreateRepoBody = {
  platform: Platform;
  name: string;
};

export type PatchRepoBody = {
  enabled?: boolean;
};

export type RepoDetail = RepoSummary & {
  createdAt: string;
  updatedAt: string;
  systemPromptPresent: boolean;
};

export type RepoMetrics = {
  totalReviews: number;
  reviewsLast30d: number;
  avgDurationMs: number;
  totalCostUsd: number;
};

export type RepoPrompt = {
  systemPrompt: string;
  updatedAt: string | null;
};

export type PutPromptBody = {
  systemPrompt: string;
};

export type ReviewOutcomeFilter = 'approved' | 'changes_requested' | 'commented' | 'failed' | 'all';
export type PlatformFilter = 'github' | 'codecommit' | 'all';
export type SinceAlias = '24h' | '7d' | '30d' | 'all';

export type ReviewsFilters = {
  limit?: number;
  cursor?: string | null;
  platform?: PlatformFilter;
  outcome?: ReviewOutcomeFilter;
  repoQuery?: string;
  since?: SinceAlias;
};

export type ReviewsPageWithTotal = {
  items: ReviewEvent[];
  nextCursor: string | null;
  total: number;
};

export type ReviewEventDetail = ReviewEvent & {
  summary: string | null;
  comments: Array<{ path: string; line: number | null; body: string }>;
  toolCalls: Array<{ name: 'read_file' | 'glob' | 'grep'; count: number }>;
  tokens: { prompt: number; completion: number; total: number };
  timing: { queuedAt: string; startedAt: string | null; completedAt: string | null };
  provider: { name: string; model: string };
  systemPromptAtReview: string | null;
  externalUrl: string | null;
};

// --- GitHub App onboarding ---

export type InstallationRepo = {
  id: number;
  fullName: string;
  private: boolean;
  registered: boolean;
};

export type InstallationReposResponse = {
  repos: InstallationRepo[];
};

export type BulkCreateRepoBody = {
  installationId: number;
  names: string[];
};

export type BulkCreateRepoResponse = {
  created: string[];
  alreadyExists: string[];
  errors: { name: string; message: string }[];
};

// --- BYOK LLM keys ---

export const BYOK_PROVIDERS = [
  'anthropic',
  'openai',
  'azure-openai',
  'google',
  'vertex',
  'bedrock',
  'openai-compatible',
] as const;
export type BYOKProvider = (typeof BYOK_PROVIDERS)[number];

export type LlmKeyStatus = {
  provider: BYOKProvider;
  configured: boolean;
};

export type LlmKeysResponse = {
  installationId: number;
  keys: LlmKeyStatus[];
};

export type UpsertLlmKeyBody = {
  installationId: number;
  provider: BYOKProvider;
  apiKey: string;
};

export type UpsertLlmKeyResponse = {
  installationId: number;
  provider: BYOKProvider;
  configured: true;
};

export type RotateLlmKeyBody = {
  installationId: number;
  provider: BYOKProvider;
};

export type RotateLlmKeyResponse = {
  installationId: number;
  provider: BYOKProvider;
  configured: true;
};

export type DeleteLlmKeyBody = {
  installationId: number;
  provider: BYOKProvider;
};

export type DeleteLlmKeyResponse = {
  installationId: number;
  provider: BYOKProvider;
  configured: false;
};
