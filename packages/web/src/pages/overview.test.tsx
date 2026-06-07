import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockOverview } from '../api/mocks.js';
import { renderWithProviders } from '../test/render.js';
import { OverviewPage } from './overview.js';

const mockOverviewState = vi.hoisted(() => ({
  error: null as Error | null,
}));

vi.mock('../api/client.js', () => ({
  useOverview: () => ({
    data: mockOverviewState.error ? undefined : mockOverview,
    isLoading: false,
    error: mockOverviewState.error,
    refetch: vi.fn(),
  }),
}));

describe('OverviewPage', () => {
  afterEach(() => {
    mockOverviewState.error = null;
  });

  it('renders the Overview section heading', () => {
    renderWithProviders(<OverviewPage />, { route: '/' });
    expect(screen.getByText('Overview')).toBeInTheDocument();
  });

  it('renders metric labels', () => {
    renderWithProviders(<OverviewPage />, { route: '/' });
    expect(screen.getByText('Total Repos')).toBeInTheDocument();
    expect(screen.getByText('Reviews / Month')).toBeInTheDocument();
    expect(screen.getByText('Queue Depth')).toBeInTheDocument();
    expect(screen.getByText('Cost MTD (USD)')).toBeInTheDocument();
  });

  it('renders Active. when queueDepth is non-zero', () => {
    // mockOverview.queueDepth = 3
    renderWithProviders(<OverviewPage />, { route: '/' });
    expect(screen.getByText('Active.')).toBeInTheDocument();
  });

  it('shows ErrorState with retry button on fetch error', () => {
    mockOverviewState.error = new Error('network failure');
    renderWithProviders(<OverviewPage />, { route: '/' });
    expect(screen.getByText('[ERROR] Failed to load overview metrics.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '[RETRY]' })).toBeInTheDocument();
  });
});
