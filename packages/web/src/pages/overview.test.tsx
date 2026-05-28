import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockOverview } from '../api/mocks.js';
import { renderWithProviders } from '../test/render.js';
import { OverviewPage } from './overview.js';

vi.mock('../api/client.js', () => ({
  useOverview: () => ({ data: mockOverview, isLoading: false, error: null }),
}));

describe('OverviewPage', () => {
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
});
