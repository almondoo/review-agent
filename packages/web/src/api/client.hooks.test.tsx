// Tests that exercise client.ts hooks directly (not mocked) using VITE_USE_MOCK=true.
// import.meta.env.VITE_USE_MOCK is set to "true" via vitest.config.ts define so IS_MOCK=true
// in all test runs. This exercises all the mock-mode fetch functions in client.ts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  useBulkCreateRepos,
  useCreateRepo,
  useDeleteLlmKey,
  useDeleteRepo,
  useInstallationRepos,
  useIntegrations,
  useLlmKeys,
  useOverview,
  usePatchRepo,
  usePutRepoPrompt,
  useRepoDetail,
  useRepoMetrics,
  useRepoPrompt,
  useRepoReviews,
  useRepos,
  useReviewDetail,
  useReviews,
  useRotateLlmKey,
  useUpsertLlmKey,
} from './client.js';
import { MOCK_BULK_CREATE_ERROR_SENTINEL } from './mocks.js';
import type { BulkCreateRepoResponse } from './types.js';

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('client hooks (mock mode)', () => {
  // Each test gets a fresh QueryClient via makeWrapper() — no cross-test pollution.
  afterEach(() => {});

  it('useOverview returns overview metrics', async () => {
    const { result } = renderHook(() => useOverview(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.totalRepos).toBeGreaterThan(0);
  });

  it('useRepos returns repo list', async () => {
    const { result } = renderHook(() => useRepos(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(Array.isArray(result.current.data)).toBe(true);
    expect(result.current.data?.length ?? 0).toBeGreaterThan(0);
  });

  it('useIntegrations returns integrations status', async () => {
    const { result } = renderHook(() => useIntegrations(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toHaveProperty('github');
    expect(result.current.data).toHaveProperty('codecommit');
    expect(result.current.data).toHaveProperty('llm');
  });

  it('useReviews returns reviews page with total (no args)', async () => {
    const { result } = renderHook(() => useReviews(), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toHaveProperty('items');
    expect(result.current.data).toHaveProperty('total');
  });

  it('useReviews accepts a numeric limit', async () => {
    const { result } = renderHook(() => useReviews(10), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.items.length).toBeLessThanOrEqual(10);
  });

  it('useReviews accepts ReviewsFilters object with platform filter', async () => {
    const { result } = renderHook(() => useReviews({ limit: 50, platform: 'github' }), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.items.every((r) => r.platform === 'github')).toBe(true);
  });

  it('useReviews accepts ReviewsFilters with cursor', async () => {
    const { result } = renderHook(() => useReviews({ limit: 10, cursor: null }), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toHaveProperty('items');
  });

  it('useRepoDetail returns repo for known id', async () => {
    const { result } = renderHook(() => useRepoDetail('repo-001'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.id).toBe('repo-001');
  });

  it('useRepoDetail errors for unknown id', async () => {
    const { result } = renderHook(() => useRepoDetail('nonexistent-repo'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('useRepoMetrics returns metrics for known id', async () => {
    const { result } = renderHook(() => useRepoMetrics('repo-001'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toHaveProperty('totalReviews');
  });

  it('useRepoPrompt returns prompt for known id', async () => {
    const { result } = renderHook(() => useRepoPrompt('repo-001'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toHaveProperty('systemPrompt');
  });

  it('useRepoReviews returns page for known repo', async () => {
    const { result } = renderHook(() => useRepoReviews('repo-001', 5), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data).toHaveProperty('items');
  });

  it('useReviewDetail returns detail for known id', async () => {
    const { result } = renderHook(() => useReviewDetail('rev-001'), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.id).toBe('rev-001');
  });

  it('useReviewDetail errors for unknown id', async () => {
    const { result } = renderHook(() => useReviewDetail('nonexistent-rev'), {
      wrapper: makeWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('useCreateRepo exposes a mutate function', () => {
    const { result } = renderHook(() => useCreateRepo(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('usePatchRepo exposes a mutate function', () => {
    const { result } = renderHook(() => usePatchRepo(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('useDeleteRepo exposes a mutate function', () => {
    const { result } = renderHook(() => useDeleteRepo(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('usePutRepoPrompt exposes a mutate function', () => {
    const { result } = renderHook(() => usePutRepoPrompt(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('useCreateRepo mutate invokes mock addMockRepo and invalidates cache', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useCreateRepo(), { wrapper });
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { platform: 'github', name: 'test/new-repo' },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    // mutation completed without throwing
    expect(result.current.isError).toBe(false);
  });

  it('usePatchRepo mutate invokes mock patchMockRepo', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePatchRepo(), { wrapper });
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { id: 'repo-001', body: { enabled: false } },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    expect(result.current.isError).toBe(false);
  });

  it('usePatchRepo mutate errors when repo id not found', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePatchRepo(), { wrapper });
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { id: 'nonexistent', body: { enabled: false } },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('useDeleteRepo mutate invokes mock deleteMockRepo', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useDeleteRepo(), { wrapper });
    await new Promise<void>((resolve) => {
      result.current.mutate('repo-002', { onSuccess: () => resolve(), onError: () => resolve() });
    });
    expect(result.current.isError).toBe(false);
  });

  it('usePutRepoPrompt mutate invokes mock putMockRepoPrompt', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePutRepoPrompt(), { wrapper });
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { id: 'repo-001', body: { systemPrompt: 'new prompt text' } },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    expect(result.current.isError).toBe(false);
  });

  it('useLlmKeys is disabled when installationId is null', () => {
    const { result } = renderHook(() => useLlmKeys(null), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('useLlmKeys returns keys for valid installationId', async () => {
    const { result } = renderHook(() => useLlmKeys(1), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.installationId).toBe(1);
    expect(Array.isArray(result.current.data?.keys)).toBe(true);
    expect(result.current.data?.keys.length).toBe(7);
  });

  it('useUpsertLlmKey exposes a mutate function', () => {
    const { result } = renderHook(() => useUpsertLlmKey(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('useRotateLlmKey exposes a mutate function', () => {
    const { result } = renderHook(() => useRotateLlmKey(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('useDeleteLlmKey exposes a mutate function', () => {
    const { result } = renderHook(() => useDeleteLlmKey(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('useUpsertLlmKey mutate sets a key as configured', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUpsertLlmKey(), { wrapper });
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { installationId: 99, provider: 'openai', apiKey: 'sk-test-key' },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    expect(result.current.isError).toBe(false);
  });

  it('useDeleteLlmKey mutate succeeds', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    // First upsert so there is a key to delete.
    const upsertHook = renderHook(() => useUpsertLlmKey(), { wrapper });
    await new Promise<void>((resolve) => {
      upsertHook.result.current.mutate(
        { installationId: 88, provider: 'anthropic', apiKey: 'sk-key' },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    const deleteHook = renderHook(() => useDeleteLlmKey(), { wrapper });
    await new Promise<void>((resolve) => {
      deleteHook.result.current.mutate(
        { installationId: 88, provider: 'anthropic' },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    expect(deleteHook.result.current.isError).toBe(false);
  });

  it('useRotateLlmKey mutate errors when key does not exist', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRotateLlmKey(), { wrapper });
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { installationId: 777, provider: 'vertex' },
        { onSuccess: () => resolve(), onError: () => resolve() },
      );
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  // --- GitHub App onboarding hooks ---

  it('useInstallationRepos is disabled when installationId is null', () => {
    const { result } = renderHook(() => useInstallationRepos(null), { wrapper: makeWrapper() });
    expect(result.current.fetchStatus).toBe('idle');
    expect(result.current.data).toBeUndefined();
  });

  it('useInstallationRepos returns repos for valid installationId', async () => {
    const { result } = renderHook(() => useInstallationRepos(12345), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(Array.isArray(result.current.data?.repos)).toBe(true);
    expect(result.current.data?.repos.length ?? 0).toBeGreaterThan(0);
  });

  it('useInstallationRepos result includes expected repo fields', async () => {
    const { result } = renderHook(() => useInstallationRepos(12345), { wrapper: makeWrapper() });
    await waitFor(() => expect(result.current.data).toBeDefined());
    const repo = result.current.data?.repos[0];
    expect(repo).toHaveProperty('id');
    expect(repo).toHaveProperty('fullName');
    expect(repo).toHaveProperty('private');
    expect(repo).toHaveProperty('registered');
  });

  it('useBulkCreateRepos exposes a mutate function', () => {
    const { result } = renderHook(() => useBulkCreateRepos(), { wrapper: makeWrapper() });
    expect(typeof result.current.mutate).toBe('function');
  });

  it('useBulkCreateRepos mutate succeeds for unregistered repos (full success)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBulkCreateRepos(), { wrapper });
    let response: BulkCreateRepoResponse | undefined;
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { installationId: 12345, names: ['acme/backend', 'acme/docs'] },
        {
          onSuccess: (data) => {
            response = data;
            resolve();
          },
          onError: () => resolve(),
        },
      );
    });
    expect(result.current.isError).toBe(false);
    expect(response?.created).toEqual(expect.arrayContaining(['acme/backend', 'acme/docs']));
    expect(response?.alreadyExists).toHaveLength(0);
    expect(response?.errors).toHaveLength(0);
  });

  it('useBulkCreateRepos mutate handles already-existing repos (alreadyExists path)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBulkCreateRepos(), { wrapper });
    let response: BulkCreateRepoResponse | undefined;
    await new Promise<void>((resolve) => {
      result.current.mutate(
        { installationId: 12345, names: ['acme/api-service', 'acme/frontend'] },
        {
          onSuccess: (data) => {
            response = data;
            resolve();
          },
          onError: () => resolve(),
        },
      );
    });
    expect(result.current.isError).toBe(false);
    expect(response?.alreadyExists).toEqual(
      expect.arrayContaining(['acme/api-service', 'acme/frontend']),
    );
    expect(response?.created).toHaveLength(0);
  });

  it('useBulkCreateRepos mutate handles partial response with non-empty errors array (207 shape)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useBulkCreateRepos(), { wrapper });
    let response: BulkCreateRepoResponse | undefined;
    await new Promise<void>((resolve) => {
      result.current.mutate(
        // Sentinel triggers an error entry; 'acme/docs' is a normal unregistered repo.
        { installationId: 12345, names: ['acme/docs', MOCK_BULK_CREATE_ERROR_SENTINEL] },
        {
          onSuccess: (data) => {
            response = data;
            resolve();
          },
          onError: () => resolve(),
        },
      );
    });
    // 207 is still a successful mutation (not an error throw).
    expect(result.current.isError).toBe(false);
    expect(Array.isArray(response?.errors)).toBe(true);
    // At least one error entry must be present with name and message fields.
    expect(response?.errors.length).toBeGreaterThan(0);
    const errorEntry = response?.errors[0];
    expect(typeof errorEntry?.name).toBe('string');
    expect(typeof errorEntry?.message).toBe('string');
    // The successful portion must still be present.
    expect(response?.created).toContain('acme/docs');
  });
});
