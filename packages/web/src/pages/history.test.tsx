import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockReviews } from '../api/mocks.js';
import { renderWithProviders } from '../test/render.js';
import { HistoryPage } from './history.js';

vi.mock('../api/client.js', async () => {
  const { getMockReviews: getReviews } = await import('../api/mocks.js');
  const { useQuery } = await import('@tanstack/react-query');

  return {
    useReviews: (filtersOrLimit: unknown) => {
      const filters =
        typeof filtersOrLimit === 'number' || filtersOrLimit === undefined
          ? { limit: typeof filtersOrLimit === 'number' ? filtersOrLimit : 50 }
          : filtersOrLimit;
      return useQuery({
        queryKey: ['reviews-mock', filters],
        queryFn: () => Promise.resolve(getReviews(filters as Parameters<typeof getReviews>[0])),
      });
    },
  };
});

describe('HistoryPage', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCK', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
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
    // Wait for data to load, then check counter (text is split across nodes so use function matcher)
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

    // 'legacy/monolith' is a codecommit repo — multiple rows expected initially
    const initialRows = await screen.findAllByText('legacy/monolith');
    expect(initialRows.length).toBeGreaterThan(0);

    // Click the [GH] filter button
    fireEvent.click(screen.getByRole('button', { name: '[GH]' }));

    // Wait for re-render and verify codecommit repo is gone
    await screen.findAllByRole('link');
    expect(screen.queryAllByText('legacy/monolith')).toHaveLength(0);
  });

  it('filters out rows older than 24h when [24H] is clicked', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    await screen.findByRole('heading', { name: 'History' });

    // rev-006 (2026-05-25) should appear initially — more than 24h before 2026-05-28
    expect(await screen.findByText(/memory leak in connection pool/)).toBeInTheDocument();

    // Click the [24H] since-filter button (the only one with that label)
    fireEvent.click(screen.getByRole('button', { name: '[24H]' }));

    await screen.findAllByRole('link');
    // 2026-05-25 is ~72h before 2026-05-28, so it should be filtered out
    expect(screen.queryByText(/memory leak in connection pool/)).toBeNull();
  });

  it('renders platform filter button group', async () => {
    renderWithProviders(<HistoryPage />, { route: '/history' });
    await screen.findByRole('heading', { name: 'History' });

    expect(screen.getByRole('button', { name: '[GH]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[CC]' })).toBeInTheDocument();
    // [ALL] buttons exist (platform group + since group)
    expect(screen.getAllByRole('button', { name: '[ALL]' }).length).toBeGreaterThanOrEqual(2);
  });
});
