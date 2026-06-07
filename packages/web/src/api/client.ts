import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clearSessionToken, getSessionToken } from '../lib/session-token.js';
import {
  addMockRepo,
  bulkCreateMockRepos,
  deleteMockLlmKey,
  deleteMockRepo,
  getMockCostMetrics,
  getMockInstallationRepos,
  getMockLlmKeys,
  getMockQualityMetrics,
  getMockRepoDetail,
  getMockRepoMetrics,
  getMockRepoPrompt,
  getMockRepos,
  getMockReviewDetail,
  getMockReviews,
  mockIntegrations,
  mockOverview,
  patchMockRepo,
  putMockRepoPrompt,
  rotateMockLlmKey,
  upsertMockLlmKey,
} from './mocks.js';
import type {
  AuthConfig,
  AuthMeResponse,
  BulkCreateRepoBody,
  BulkCreateRepoResponse,
  CostMetrics,
  CreateRepoBody,
  DeleteLlmKeyBody,
  DeleteLlmKeyResponse,
  InstallationReposResponse,
  IntegrationsStatus,
  LlmKeysResponse,
  LoginBody,
  LoginResponse,
  MetricsSince,
  OverviewMetrics,
  PatchRepoBody,
  PutPromptBody,
  QualityMetrics,
  RepoDetail,
  RepoMetrics,
  RepoPrompt,
  RepoSummary,
  ReviewEventDetail,
  ReviewsFilters,
  ReviewsPage,
  ReviewsPageWithTotal,
  RotateLlmKeyBody,
  RotateLlmKeyResponse,
  UpsertLlmKeyBody,
  UpsertLlmKeyResponse,
} from './types.js';

export const IS_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

// Module-level unauthorized callback — set by the app bootstrap to navigate to /login.
let _onUnauthorized: (() => void) | null = null;

export function registerOnUnauthorized(cb: () => void): void {
  _onUnauthorized = cb;
}

/** Paths that must NOT send an Authorization header. */
const NO_AUTH_PATHS = new Set(['/api/auth/login', '/api/auth/config']);

export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor() {
    super('Unauthorized');
  }
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const sessionToken = getSessionToken();
  const dashboardToken = import.meta.env.VITE_REVIEW_AGENT_DASHBOARD_TOKEN as string | undefined;

  // Precedence: (1) session JWT, (2) legacy dashboard token — but never on login path.
  const authToken = NO_AUTH_PATHS.has(path)
    ? undefined
    : (sessionToken ?? dashboardToken ?? undefined);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && !NO_AUTH_PATHS.has(path)) {
    clearSessionToken();
    _onUnauthorized?.();
    throw new UnauthorizedError();
  }
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// --- Auth ---

export async function apiLogin(body: LoginBody): Promise<LoginResponse> {
  return apiFetch<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function apiFetchMe(): Promise<AuthMeResponse> {
  return apiFetch<AuthMeResponse>('/api/auth/me');
}

async function fetchAuthConfig(): Promise<AuthConfig> {
  if (IS_MOCK) return Promise.resolve({ oidcEnabled: false });
  return apiFetch<AuthConfig>('/api/auth/config');
}

export function useAuthConfig() {
  return useQuery({
    queryKey: ['auth-config'],
    queryFn: fetchAuthConfig,
    staleTime: 60_000,
  });
}

export async function apiLogout(): Promise<void> {
  clearSessionToken();
  try {
    await apiFetch<void>('/api/auth/logout', { method: 'POST' });
  } catch {
    // Logout is best-effort; server is stateless. Token is already cleared.
  }
}

export function useAuthMe() {
  return useQuery({
    queryKey: ['auth-me'],
    queryFn: apiFetchMe,
    retry: false,
    staleTime: 60_000,
  });
}

// --- Overview ---

async function fetchOverview(): Promise<OverviewMetrics> {
  if (IS_MOCK) return Promise.resolve(mockOverview);
  return apiFetch<OverviewMetrics>('/api/dashboard/overview');
}

export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: fetchOverview, staleTime: 30_000 });
}

// --- Repos ---

async function fetchRepos(): Promise<RepoSummary[]> {
  if (IS_MOCK) return Promise.resolve(getMockRepos());
  return apiFetch<RepoSummary[]>('/api/repos');
}

async function createRepo(body: CreateRepoBody): Promise<RepoSummary> {
  if (IS_MOCK) return Promise.resolve(addMockRepo(body.platform, body.name));
  return apiFetch<RepoSummary>('/api/repos', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function patchRepo(id: string, body: PatchRepoBody): Promise<RepoSummary> {
  if (IS_MOCK) {
    const result = patchMockRepo(id, body);
    if (!result) throw new Error(`Repo ${id} not found`);
    return Promise.resolve(result);
  }
  return apiFetch<RepoSummary>(`/api/repos/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

async function deleteRepo(id: string): Promise<void> {
  if (IS_MOCK) {
    deleteMockRepo(id);
    return Promise.resolve();
  }
  await apiFetch<void>(`/api/repos/${id}`, { method: 'DELETE' });
}

export function useRepos() {
  return useQuery({ queryKey: ['repos'], queryFn: fetchRepos, retry: 1, staleTime: 30_000 });
}

export function useCreateRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: createRepo,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function usePatchRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchRepoBody }) => patchRepo(id, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

export function useDeleteRepo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteRepo,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['repos'] }),
  });
}

// --- Repo detail, metrics, prompt ---

async function fetchRepoDetail(id: string): Promise<RepoDetail> {
  if (IS_MOCK) {
    const detail = getMockRepoDetail(id);
    if (!detail) throw new Error(`Repo ${id} not found`);
    return Promise.resolve(detail);
  }
  return apiFetch<RepoDetail>(`/api/repos/${id}`);
}

async function fetchRepoMetrics(id: string): Promise<RepoMetrics> {
  if (IS_MOCK) return Promise.resolve(getMockRepoMetrics(id));
  return apiFetch<RepoMetrics>(`/api/repos/${id}/metrics`);
}

async function fetchRepoPrompt(id: string): Promise<RepoPrompt> {
  if (IS_MOCK) return Promise.resolve(getMockRepoPrompt(id));
  return apiFetch<RepoPrompt>(`/api/repos/${id}/prompt`);
}

async function putRepoPrompt(id: string, body: PutPromptBody): Promise<RepoPrompt> {
  if (IS_MOCK) return Promise.resolve(putMockRepoPrompt(id, body.systemPrompt));
  return apiFetch<RepoPrompt>(`/api/repos/${id}/prompt`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

async function fetchRepoReviews(id: string, limit: number): Promise<ReviewsPage> {
  if (IS_MOCK) {
    const all = await fetchReviews({ limit, cursor: null });
    return { items: all.items.filter((r) => r.repoId === id), nextCursor: null };
  }
  return apiFetch<ReviewsPage>(`/api/repos/${id}/reviews?limit=${limit}`);
}

export function useRepoDetail(id: string) {
  return useQuery({ queryKey: ['repo', id], queryFn: () => fetchRepoDetail(id) });
}

export function useRepoMetrics(id: string) {
  return useQuery({ queryKey: ['repo-metrics', id], queryFn: () => fetchRepoMetrics(id) });
}

export function useRepoPrompt(id: string) {
  return useQuery({ queryKey: ['repo-prompt', id], queryFn: () => fetchRepoPrompt(id) });
}

export function usePutRepoPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PutPromptBody }) => putRepoPrompt(id, body),
    onSuccess: (_data, { id }) => qc.invalidateQueries({ queryKey: ['repo-prompt', id] }),
  });
}

export function useRepoReviews(id: string, limit = 10) {
  return useQuery({
    queryKey: ['repo-reviews', id, limit],
    queryFn: () => fetchRepoReviews(id, limit),
  });
}

// --- Integrations ---

async function fetchIntegrations(): Promise<IntegrationsStatus> {
  if (IS_MOCK) return Promise.resolve(mockIntegrations);
  return apiFetch<IntegrationsStatus>('/api/integrations');
}

export function useIntegrations() {
  return useQuery({ queryKey: ['integrations'], queryFn: fetchIntegrations });
}

// --- Reviews ---

async function fetchReviews(filters: ReviewsFilters): Promise<ReviewsPageWithTotal> {
  if (IS_MOCK) return Promise.resolve(getMockReviews(filters));
  const params = new URLSearchParams();
  const limit = filters.limit ?? 50;
  params.set('limit', String(limit));
  if (filters.cursor) params.set('cursor', filters.cursor);
  if (filters.platform && filters.platform !== 'all') params.set('platform', filters.platform);
  if (filters.outcome && filters.outcome !== 'all') params.set('outcome', filters.outcome);
  if (filters.repoQuery) params.set('repoQuery', filters.repoQuery);
  if (filters.since && filters.since !== 'all') params.set('since', filters.since);
  return apiFetch<ReviewsPageWithTotal>(`/api/reviews?${params.toString()}`);
}

export function useReviews(filtersOrLimit?: ReviewsFilters | number, cursor: string | null = null) {
  const filters: ReviewsFilters =
    typeof filtersOrLimit === 'number' || filtersOrLimit === undefined
      ? { limit: typeof filtersOrLimit === 'number' ? filtersOrLimit : 50, cursor }
      : filtersOrLimit;
  return useQuery({
    queryKey: ['reviews', filters],
    queryFn: () => fetchReviews(filters),
  });
}

// --- Review detail ---

async function fetchReviewDetail(id: string): Promise<ReviewEventDetail> {
  if (IS_MOCK) {
    const detail = getMockReviewDetail(id);
    if (!detail) throw new Error(`Review ${id} not found`);
    return Promise.resolve(detail);
  }
  return apiFetch<ReviewEventDetail>(`/api/reviews/${id}`);
}

export function useReviewDetail(id: string) {
  return useQuery({
    queryKey: ['review-detail', id],
    queryFn: () => fetchReviewDetail(id),
  });
}

// --- BYOK LLM keys ---

async function fetchLlmKeys(installationId: number): Promise<LlmKeysResponse> {
  if (IS_MOCK) return Promise.resolve(getMockLlmKeys(installationId));
  return apiFetch<LlmKeysResponse>(`/api/integrations/llm-keys?installationId=${installationId}`);
}

async function upsertLlmKey(body: UpsertLlmKeyBody): Promise<UpsertLlmKeyResponse> {
  if (IS_MOCK) {
    upsertMockLlmKey(body.installationId, body.provider);
    return Promise.resolve({
      installationId: body.installationId,
      provider: body.provider,
      configured: true,
    });
  }
  return apiFetch<UpsertLlmKeyResponse>('/api/integrations/llm-keys', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function rotateLlmKey(body: RotateLlmKeyBody): Promise<RotateLlmKeyResponse> {
  if (IS_MOCK) {
    rotateMockLlmKey(body.installationId, body.provider);
    return Promise.resolve({
      installationId: body.installationId,
      provider: body.provider,
      configured: true,
    });
  }
  return apiFetch<RotateLlmKeyResponse>('/api/integrations/llm-keys/rotate', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function deleteLlmKey(body: DeleteLlmKeyBody): Promise<DeleteLlmKeyResponse> {
  if (IS_MOCK) {
    deleteMockLlmKey(body.installationId, body.provider);
    return Promise.resolve({
      installationId: body.installationId,
      provider: body.provider,
      configured: false,
    });
  }
  return apiFetch<DeleteLlmKeyResponse>('/api/integrations/llm-keys', {
    method: 'DELETE',
    body: JSON.stringify(body),
  });
}

export function useLlmKeys(installationId: number | null) {
  return useQuery({
    queryKey: ['llm-keys', installationId],
    queryFn: () => fetchLlmKeys(installationId as number),
    enabled: installationId !== null,
  });
}

export function useUpsertLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: upsertLlmKey,
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ['llm-keys', vars.installationId] }),
  });
}

export function useRotateLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: rotateLlmKey,
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ['llm-keys', vars.installationId] }),
  });
}

export function useDeleteLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: deleteLlmKey,
    onSuccess: (_data, vars) =>
      qc.invalidateQueries({ queryKey: ['llm-keys', vars.installationId] }),
  });
}

// --- GitHub App onboarding ---

async function fetchInstallationRepos(installationId: number): Promise<InstallationReposResponse> {
  if (IS_MOCK) return Promise.resolve(getMockInstallationRepos(installationId));
  return apiFetch<InstallationReposResponse>(`/api/github/installations/${installationId}/repos`);
}

async function bulkCreateRepos(body: BulkCreateRepoBody): Promise<BulkCreateRepoResponse> {
  if (IS_MOCK) return Promise.resolve(bulkCreateMockRepos(body));
  // 201 = all created, 200 = all already existed, 207 = partial success — all are ok.
  return apiFetch<BulkCreateRepoResponse>('/api/repos/bulk', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function useInstallationRepos(installationId: number | null) {
  return useQuery({
    queryKey: ['installation-repos', installationId],
    queryFn: () => fetchInstallationRepos(installationId as number),
    enabled: installationId !== null,
  });
}

export function useBulkCreateRepos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: bulkCreateRepos,
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['repos'] });
      void qc.invalidateQueries({ queryKey: ['installation-repos', vars.installationId] });
    },
  });
}

// --- Quality Metrics ---

async function fetchQualityMetrics(
  installationId: number,
  since: MetricsSince,
): Promise<QualityMetrics> {
  if (IS_MOCK) return Promise.resolve(getMockQualityMetrics(installationId, since));
  return apiFetch<QualityMetrics>(
    `/api/dashboard/metrics?installationId=${installationId}&since=${since}`,
  );
}

export function useQualityMetrics(installationId: number | null, since: MetricsSince = '30d') {
  return useQuery({
    queryKey: ['quality-metrics', installationId, since],
    queryFn: () => fetchQualityMetrics(installationId as number, since),
    enabled: installationId !== null,
    staleTime: 30_000,
  });
}

// --- Cost Analytics ---

async function fetchCostMetrics(
  installationId: number,
  since: MetricsSince,
  cursor?: string,
): Promise<CostMetrics> {
  if (IS_MOCK) return Promise.resolve(getMockCostMetrics(installationId, since));
  const params = new URLSearchParams({
    installationId: String(installationId),
    since,
  });
  if (cursor !== undefined) params.set('cursor', cursor);
  return apiFetch<CostMetrics>(`/api/dashboard/cost?${params.toString()}`);
}

export function useCostMetrics(
  installationId: number | null,
  since: MetricsSince = '30d',
  cursor?: string,
) {
  return useQuery({
    queryKey: ['cost-metrics', installationId, since, cursor],
    queryFn: () => fetchCostMetrics(installationId as number, since, cursor),
    enabled: installationId !== null,
    staleTime: 30_000,
  });
}
