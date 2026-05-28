import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockRepos } from '../api/mocks.js';
import { renderWithProviders } from '../test/render.js';
import { ReposPage } from './repos.js';

vi.mock('../api/client.js', async () => {
  const { getMockRepos: getRepos, patchMockRepo, deleteMockRepo } = await import('../api/mocks.js');
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
    useDeleteRepo: () => {
      const qc = useQueryClient();
      return useMutation({
        mutationFn: (id: string) => {
          deleteMockRepo(id);
          return Promise.resolve();
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['repos-mock'] }),
      });
    },
  };
});

describe('ReposPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
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
});
