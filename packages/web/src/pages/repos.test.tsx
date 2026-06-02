import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockRepos } from '../api/mocks.js';
import { renderWithProviders } from '../test/render.js';
import { ReposPage } from './repos.js';

const mockDeleteMutate = vi.hoisted(() => vi.fn());

vi.mock('../api/client.js', async () => {
  const { getMockRepos: getRepos, patchMockRepo } = await import('../api/mocks.js');
  const { useMutation, useQuery, useQueryClient } = await import('@tanstack/react-query');

  return {
    useRepos: () =>
      useQuery({ queryKey: ['repos-mock'], queryFn: () => Promise.resolve(getRepos()) }),
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

describe('ReposPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockDeleteMutate.mockReset();
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

    // ConfirmDialog should be open: title and [DELETE] confirm button visible
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

    // Dialog should close
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes ConfirmDialog when [CANCEL] is clicked', async () => {
    renderWithProviders(<ReposPage />, { route: '/repos' });
    // Find any [DEL] button (first available repo)
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

    // Dialog should close
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

    // Dialog should close and error toast should appear
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('[FAIL] Failed to delete repository.')).toBeInTheDocument();
  });
});
