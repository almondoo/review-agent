import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockRepos } from '../api/mocks.js';
import type { IntegrationsStatus } from '../api/types.js';
import { renderWithProviders } from '../test/render.js';
import { ReposPage } from './repos.js';

const mockDeleteMutate = vi.hoisted(() => vi.fn());

// Mutable state for hook overrides
const mockState = vi.hoisted<{
  repos: ReturnType<typeof getMockRepos> | null;
  reposError: Error | null;
  reposLoading: boolean;
  integrations: IntegrationsStatus | null;
}>(() => ({
  repos: null,
  reposError: null,
  reposLoading: false,
  integrations: null,
}));

vi.mock('../api/client.js', async () => {
  const {
    getMockRepos: getRepos,
    patchMockRepo,
    mockIntegrations: defaultIntegrations,
  } = await import('../api/mocks.js');
  const { useMutation, useQuery, useQueryClient } = await import('@tanstack/react-query');

  return {
    useRepos: () => {
      const result = useQuery({
        queryKey: ['repos-mock'],
        queryFn: () => {
          if (mockState.reposError) throw mockState.reposError;
          return Promise.resolve(mockState.repos ?? getRepos());
        },
        retry: false,
      });
      // Inject error manually if set (for synchronous error state)
      if (mockState.reposError) {
        return { data: undefined, isLoading: false, error: mockState.reposError, refetch: vi.fn() };
      }
      if (mockState.reposLoading) {
        return { data: undefined, isLoading: true, error: null, refetch: vi.fn() };
      }
      return { ...result, refetch: vi.fn() };
    },
    useIntegrations: () => ({
      data: mockState.integrations ?? defaultIntegrations,
      isLoading: false,
      error: null,
    }),
    usePatchRepo: () => {
      const qc = useQueryClient();
      return useMutation({
        mutationFn: ({ id, body }: { id: string; body: { enabled?: boolean } }) => {
          const result = patchMockRepo(id, body);
          return Promise.resolve(result);
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['repos-mock'] }),
      });
    },
    useDeleteRepo: () => ({ mutate: mockDeleteMutate }),
  };
});

describe('ReposPage — existing baseline', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockDeleteMutate.mockReset();
    mockState.repos = null;
    mockState.reposError = null;
    mockState.reposLoading = false;
    mockState.integrations = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('renders the Repos heading', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    expect(await screen.findByRole('heading', { name: 'Repos' })).toBeInTheDocument();
  });

  it('renders mock repo names as links', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const link = await screen.findByRole('link', { name: /acme\/api-service/ });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/repos/repo-001');
  });

  it('renders [+ ADD REPO] link pointing to /repos/new', () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const addLink = screen.getByRole('link', { name: '[+ ADD REPO]' });
    expect(addLink).toBeInTheDocument();
    expect(addLink).toHaveAttribute('href', '/repos/new');
  });

  it('renders [ON] / [OFF] toggle buttons', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const repos = getMockRepos();
    const enabledCount = repos.filter((r) => r.enabled).length;
    const disabledCount = repos.filter((r) => !r.enabled).length;
    const onLabels = await screen.findAllByText('[ON]');
    const offLabels = await screen.findAllByText('[OFF]');
    expect(onLabels).toHaveLength(enabledCount);
    expect(offLabels).toHaveLength(disabledCount);
  });

  it('renders [DEL] buttons (one per repo)', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const delButtons = await screen.findAllByRole('button', { name: /^Delete / });
    expect(delButtons.length).toBeGreaterThan(0);
  });

  it('opens ConfirmDialog when a [DEL] button is clicked', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const delBtn = await screen.findByRole('button', { name: 'Delete acme/api-service' });

    await act(async () => {
      delBtn.click();
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Delete repository')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[DELETE]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[CANCEL]' })).toBeInTheDocument();
  });

  it('dismisses ConfirmDialog after confirm is clicked', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const delBtn = await screen.findByRole('button', { name: 'Delete acme/api-service' });

    await act(async () => {
      delBtn.click();
    });

    const confirmBtn = screen.getByRole('button', { name: '[DELETE]' });
    await act(async () => {
      confirmBtn.click();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes ConfirmDialog when [CANCEL] is clicked', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const delBtns = await screen.findAllByRole('button', { name: /^Delete / });
    const firstDelBtn = delBtns[0];

    await act(async () => {
      firstDelBtn?.click();
    });

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: '[CANCEL]' });
    await act(async () => {
      cancelBtn.click();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows error toast when delete mutation fails', async () => {
    mockDeleteMutate.mockImplementation((_id: string, opts: { onError?: () => void }) => {
      opts.onError?.();
    });
    renderWithProviders(<ReposPage />, { route: '/repos' });
    const delBtn = await screen.findByRole('button', { name: 'Delete acme/api-service' });

    await act(async () => {
      delBtn.click();
    });

    const confirmBtn = screen.getByRole('button', { name: '[DELETE]' });
    await act(async () => {
      confirmBtn.click();
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('[FAIL] Failed to delete repository.')).toBeInTheDocument();
  });
});

describe('ReposPage — error state', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockDeleteMutate.mockReset();
    mockState.repos = null;
    mockState.reposError = null;
    mockState.reposLoading = false;
    mockState.integrations = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows ErrorState with retry button on fetch error', () => {
    mockState.reposError = new Error('network failure');
    renderWithProviders(<ReposPage />, { route: '/repos' });
    expect(screen.getByText('[ERROR] Failed to load repositories.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[RETRY]' })).toBeInTheDocument();
  });
});

describe('ReposPage — GitHub disconnected state', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockDeleteMutate.mockReset();
    mockState.reposError = null;
    mockState.reposLoading = false;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('shows "Connect GitHub" CTA when GitHub is not connected', async () => {
    mockState.repos = getMockRepos();
    mockState.integrations = {
      github: { configured: false, appId: null, appSlug: null, installationCount: 0 },
      codecommit: { configured: false, region: null },
      llm: { configured: false, provider: null, model: null },
    };
    renderWithProviders(<ReposPage />, { route: '/repos' });
    // Wait for CTA link to appear (repos have loaded and integrations state is reflected)
    const ctaLink = await screen.findByRole('link', { name: '[CONNECT GITHUB →]' });
    expect(ctaLink).toBeInTheDocument();
    expect(ctaLink).toHaveAttribute('href', '/integrations');
  });

  it('shows add repo CTA when connected but no repos', async () => {
    mockState.repos = [];
    mockState.integrations = {
      github: { configured: true, appId: 'app-1', appSlug: 'my-app', installationCount: 1 },
      codecommit: { configured: false, region: null },
      llm: { configured: false, provider: null, model: null },
    };
    renderWithProviders(<ReposPage />, { route: '/repos' });
    // Wait until at least one add-repo link is rendered
    const ctaLinks = await screen.findAllByRole('link', { name: '[+ ADD REPO]' });
    expect(ctaLinks.length).toBeGreaterThan(0);
    const newRepoLinks = ctaLinks.filter((l) => l.getAttribute('href') === '/repos/new');
    expect(newRepoLinks.length).toBeGreaterThan(0);
  });
});

describe('ReposPage — search and status filter', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockDeleteMutate.mockReset();
    mockState.repos = null;
    mockState.reposError = null;
    mockState.reposLoading = false;
    mockState.integrations = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('filters repos by search query', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    await screen.findByRole('link', { name: /acme\/api-service/ });

    const searchInput = screen.getByRole('searchbox');
    fireEvent.change(searchInput, { target: { value: 'api-service' } });

    // acme/api-service should still be visible
    expect(screen.getByRole('link', { name: /acme\/api-service/ })).toBeInTheDocument();
    // acme/frontend should be filtered out
    expect(screen.queryByRole('link', { name: /acme\/frontend/ })).toBeNull();
  });

  it('filters repos by status filter [ENABLED]', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    await screen.findByRole('link', { name: /legacy\/monolith/ });

    // legacy/monolith is disabled — should disappear after clicking enabled filter
    fireEvent.click(screen.getByRole('button', { name: '[ENABLED]' }));

    expect(screen.queryByRole('link', { name: /legacy\/monolith/ })).toBeNull();
  });

  it('filters repos by status filter [DISABLED]', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    await screen.findByRole('link', { name: /acme\/api-service/ });

    fireEvent.click(screen.getByRole('button', { name: '[DISABLED]' }));

    // Only disabled repos should show: legacy/monolith
    expect(screen.getByRole('link', { name: /legacy\/monolith/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /acme\/api-service/ })).toBeNull();
  });
});

describe('ReposPage — URL query persistence', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockDeleteMutate.mockReset();
    mockState.repos = null;
    mockState.reposError = null;
    mockState.reposLoading = false;
    mockState.integrations = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads search query from URL param ?q=', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos?q=api-service' });
    // Wait for data to load (search input renders after repos data is available)
    const searchInput = await screen.findByRole('searchbox');
    expect(searchInput).toHaveValue('api-service');
    // acme/frontend should be filtered out
    expect(screen.queryByRole('link', { name: /acme\/frontend/ })).toBeNull();
  });

  it('reads status filter from URL param ?status=disabled', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos?status=disabled' });
    // Wait for data to load, then verify filtered state
    await screen.findByRole('searchbox');
    // Only disabled should show: legacy/monolith
    expect(await screen.findByRole('link', { name: /legacy\/monolith/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /acme\/api-service/ })).toBeNull();
  });
});

describe('ReposPage — pagination', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockDeleteMutate.mockReset();
    mockState.reposError = null;
    mockState.reposLoading = false;
    mockState.integrations = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockState.repos = null;
  });

  it('shows pagination when repos exceed PAGE_SIZE (25)', async () => {
    // Create 30 repos
    mockState.repos = Array.from({ length: 30 }, (_, i) => ({
      id: `repo-p${i}`,
      platform: 'github' as const,
      name: `org/repo-${i}`,
      enabled: true,
      lastReviewAt: null,
      lastOutcome: null,
    }));
    renderWithProviders(<ReposPage />, { route: '/repos' });
    // Wait for first repo link to appear (data loaded)
    await screen.findByRole('link', { name: /org\/repo-0/ });
    // Should show page info
    expect(await screen.findByText(/Page 1 of 2/i)).toBeInTheDocument();
    // Prev disabled on first page
    expect(screen.getByRole('button', { name: '[← PREV]' })).toBeDisabled();
    // Next enabled
    expect(screen.getByRole('button', { name: '[NEXT →]' })).not.toBeDisabled();
  });

  it('does not show pagination when repos are fewer than PAGE_SIZE', async () => {
    // Default mock has 6 repos — fewer than 25
    mockState.repos = null;
    renderWithProviders(<ReposPage />, { route: '/repos' });
    await screen.findByRole('heading', { name: 'Repos' });
    expect(screen.queryByText(/Page/)).toBeNull();
  });
});
