import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockReviews } from '../api/mocks.js';
import { renderWithProviders } from '../test/render.js';
import { HistoryPage } from './history.js';

// Mutable hook state for overriding error
const mockHookState = vi.hoisted(() => ({
  error: null as Error | null,
}));

vi.mock('../api/client.js', async () => {
  const { getMockReviews: getReviews } = await import('../api/mocks.js');
  const { useQuery } = await import('@tanstack/react-query');

  return {
    useReviews: (filtersOrLimit: unknown) => {
      const filters =
        typeof filtersOrLimit === 'number' || filtersOrLimit === undefined
          ? { limit: typeof filtersOrLimit === 'number' ? filtersOrLimit : 50 }
          : filtersOrLimit;
      const result = useQuery({
        queryKey: ['reviews-mock', filters],
        queryFn: () => {
          if (mockHookState.error) throw mockHookState.error;
          return Promise.resolve(getReviews(filters as Parameters<typeof getReviews>[0]));
        },
        retry: false,
      });
      if (mockHookState.error) {
        return {
          data: undefined,
          isLoading: false,
          error: mockHookState.error,
          refetch: vi.fn(),
        };
      }
      return { ...result, refetch: vi.fn() };
    },
  };
});

describe('HistoryPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockHookState.error = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockHookState.error = null;
  });

  it('renders the History heading', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
  });

  it('shows all 40 mock events on initial load (limit=50)', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    // All 40 mock items — each PR column is a <Link>, so 40 links total
    const links = await screen.findAllByRole('link');
    expect(links).toHaveLength(40);
  });

  it('shows total/loaded counter', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    const counter = await screen.findByText(
      (_content, element) =>
        element?.tagName === 'SPAN' && (element.textContent ?? '').includes('events / loaded'),
    );
    expect(counter).toBeInTheDocument();
  });

  it('links each row to /history/:id', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    const allReviews = getMockReviews({ limit: 50 });
    const first = allReviews.items[0];
    if (!first) throw new Error('No mock reviews');
    const link = await screen.findByRole('link', {
      name: new RegExp(first.pr.title.replace(/[[\]()]/g, '\\$&')),
    });
    expect(link).toHaveAttribute('href', `/history/${first.id}`);
  });

  it('filters out codecommit rows when platform [GH] is clicked', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    await screen.findByRole('heading', { name: 'History' });

    const initialRows = await screen.findAllByText('legacy/monolith');
    expect(initialRows.length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '[GH]' }));

    await screen.findAllByRole('link');
    expect(screen.queryAllByText('legacy/monolith')).toHaveLength(0);
  });

  it('filters out rows older than 24h when [24H] is clicked', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2026-05-28T12:00:00Z');
    try {
      renderWithProviders(<HistoryPage />, { route: '/history' });
      await screen.findByRole('heading', { name: 'History' });

      expect(await screen.findByText(/memory leak in connection pool/)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: '[24H]' }));

      await screen.findAllByRole('link');
      expect(screen.queryByText(/memory leak in connection pool/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders platform filter button group', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    await screen.findByRole('heading', { name: 'History' });

    expect(screen.getByRole('button', { name: '[GH]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[CC]' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '[ALL]' }).length).toBeGreaterThanOrEqual(2);
  });
});

describe('HistoryPage — error state', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockHookState.error = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    mockHookState.error = null;
  });

  it('shows ErrorState with retry button on fetch error', () => {
    mockHookState.error = new Error('network failure');
    renderWithProviders(<HistoryPage />, { route: '/history' });
    expect(screen.getByText('[ERROR] Failed to load review history.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[RETRY]' })).toBeInTheDocument();
  });
});

describe('HistoryPage — URL filter persistence', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
    mockHookState.error = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads platform filter from URL param ?platform=github', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history?platform=github' });
    await screen.findByRole('heading', { name: 'History' });
    // codecommit repos should not appear
    await screen.findAllByRole('link');
    expect(screen.queryAllByText('legacy/monolith')).toHaveLength(0);
  });

  it('reads outcome filter from URL param ?outcome=approved', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history?outcome=approved' });
    await screen.findByRole('heading', { name: 'History' });
    await screen.findAllByRole('link');
    // All visible rows should have "approved" outcome — check that failed rows are gone
    expect(screen.queryByText(/OIDC provider integration/)).toBeNull();
  });

  it('reads repo query from URL param ?repo=', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history?repo=api-service' });
    await screen.findByRole('heading', { name: 'History' });
    await screen.findAllByRole('link');
    // Should only show api-service repos
    expect(screen.queryByText('acme/frontend')).toBeNull();
  });
});
