import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addMockRepo,
  deleteMockRepo,
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
} from './mocks.js';
import type {
  CreateRepoBody,
  IntegrationsStatus,
  OverviewMetrics,
  PatchRepoBody,
  PutPromptBody,
  RepoDetail,
  RepoMetrics,
  RepoPrompt,
  RepoSummary,
  ReviewEventDetail,
  ReviewsFilters,
  ReviewsPage,
  ReviewsPageWithTotal,
} from './types.js';

const IS_MOCK = import.meta.env.VITE_USE_MOCK === 'true';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const dashboardToken = import.meta.env.VITE_REVIEW_AGENT_DASHBOARD_TOKEN as string | undefined;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(dashboardToken ? { Authorization: `Bearer ${dashboardToken}` } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${res.statusText}`);
  }
  return res.json() as Promise<T>;
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
  return useQuery({ queryKey: ['repos'], queryFn: fetchRepos });
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
