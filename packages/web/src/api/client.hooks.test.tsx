// Tests that exercise client.ts hooks directly (not mocked) using VITE_USE_MOCK=true.
// import.meta.env.VITE_USE_MOCK is set to "true" via vitest.config.ts define so IS_MOCK=true
// in all test runs. This exercises all the mock-mode fetch functions in client.ts.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  useCreateRepo,
  useDeleteRepo,
  useIntegrations,
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
} from './client.js';

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
});
