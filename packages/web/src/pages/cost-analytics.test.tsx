import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockCostMetrics } from '../api/mocks.js';
import type { CostMetrics } from '../api/types.js';
import type { AuthContextValue } from '../contexts/auth-context.js';
import { defaultTestAuthContext, renderWithProviders } from '../test/render.js';
import { CostAnalyticsPage } from './cost-analytics.js';

const mockData = getMockCostMetrics(1, '30d');

type MockHookResult = {
  data: CostMetrics | undefined;
  isLoading: boolean;
  error: Error | null;
};

let mockHookResult: MockHookResult = { data: mockData, isLoading: false, error: null };

vi.mock('../api/client.js', () => ({
  useCostMetrics: (_installationId: number | null, _since: string, _cursor?: string) =>
    mockHookResult,
  IS_MOCK: true,
}));

describe('CostAnalyticsPage', () => {
  beforeEach(() => {
    mockHookResult = { data: mockData, isLoading: false, error: null };
  });

  it('renders the page heading', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('Cost Analytics')).toBeInTheDocument();
  });

  it('renders overall section heading', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText(/Overall Summary/i)).toBeInTheDocument();
  });

  it('renders per-model section heading', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText(/By Model/i)).toBeInTheDocument();
  });

  it('renders per-repo section heading', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText(/By Repository/i)).toBeInTheDocument();
  });

  it('renders period selector buttons', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('[24H]')).toBeInTheDocument();
    expect(screen.getByText('[7D]')).toBeInTheDocument();
    expect(screen.getByText('[30D]')).toBeInTheDocument();
  });

  it('[30D] button is active by default', () => {
    renderWithProviders(<CostAnalyticsPage />);
    const btn30d = screen.getByText('[30D]').closest('button');
    expect(btn30d?.getAttribute('aria-pressed')).toBe('true');
  });

  it('period selector toggles aria-pressed on click', () => {
    renderWithProviders(<CostAnalyticsPage />);
    const btn7d = screen.getByText('[7D]').closest('button');
    expect(btn7d?.getAttribute('aria-pressed')).toBe('false');
    if (btn7d) fireEvent.click(btn7d);
    expect(btn7d?.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders total cost in USD format', () => {
    renderWithProviders(<CostAnalyticsPage />);
    // mockData.overall.totalCostUsd = 18.42 → "$18.4200"
    expect(screen.getAllByText('$18.4200').length).toBeGreaterThan(0);
  });

  it('renders per-repo rows with repo names', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('acme/api-service')).toBeInTheDocument();
    expect(screen.getByText('acme/auth')).toBeInTheDocument();
  });

  it('renders per-model rows with provider/model', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('anthropic / claude-sonnet-4-5')).toBeInTheDocument();
  });

  it('renders per-period section heading', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText(/Time Series/i)).toBeInTheDocument();
  });

  it('renders period bucket rows', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('2026-05-06T00:00:00.000Z')).toBeInTheDocument();
  });

  it('does NOT show budget alert banner when budgetAlertUsd is null', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.queryByText(/ALERT/)).toBeNull();
  });

  it('shows budget alert banner when budgetAlertUsd is set', () => {
    const alertData: CostMetrics = {
      ...mockData,
      overall: { ...mockData.overall, budgetAlertUsd: 15 },
    };
    mockHookResult = { data: alertData, isLoading: false, error: null };
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText(/ALERT/)).toBeInTheDocument();
  });

  it('shows loading state when isLoading=true', () => {
    mockHookResult = { data: undefined, isLoading: true, error: null };
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('[LOADING...]')).toBeInTheDocument();
  });

  it('shows error state when error is set', () => {
    mockHookResult = { data: undefined, isLoading: false, error: new Error('fail') };
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('[ERROR] Failed to load cost data.')).toBeInTheDocument();
  });

  it('shows no-installation state for session mode with no memberships', () => {
    const sessionAuth: AuthContextValue = {
      ...defaultTestAuthContext,
      legacy: false,
      authenticated: true,
      memberships: [],
      maxRole: undefined,
      hasRole: () => false,
    };
    renderWithProviders(<CostAnalyticsPage />, { authContext: sessionAuth });
    expect(screen.getByText('[EMPTY] No installations connected.')).toBeInTheDocument();
  });

  it('shows installation selector when session mode has multiple memberships', () => {
    const sessionAuth: AuthContextValue = {
      ...defaultTestAuthContext,
      legacy: false,
      authenticated: true,
      memberships: [
        { installationId: '10', role: 'admin' },
        { installationId: '20', role: 'viewer' },
      ],
      maxRole: 'admin',
      hasRole: () => true,
    };
    renderWithProviders(<CostAnalyticsPage />, { authContext: sessionAuth });
    expect(screen.getByRole('combobox', { name: /Installation/i })).toBeInTheDocument();
  });

  it('shows empty per-model message when perModel is empty', () => {
    mockHookResult = {
      data: { ...mockData, perModel: [] },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('[EMPTY] — No model cost data.')).toBeInTheDocument();
  });

  it('shows empty per-repo message when perRepo is empty', () => {
    mockHookResult = {
      data: { ...mockData, perRepo: [] },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('[EMPTY] — No per-repository cost data.')).toBeInTheDocument();
  });

  it('shows empty per-period message when perPeriod is empty', () => {
    mockHookResult = {
      data: { ...mockData, perPeriod: [] },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('[EMPTY] — No time-series cost data.')).toBeInTheDocument();
  });

  it('does not show load-more button when nextCursor is null', () => {
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.queryByText('[LOAD MORE]')).toBeNull();
  });

  it('shows load-more button when nextCursor is set', () => {
    mockHookResult = {
      data: { ...mockData, nextCursor: 'owner/repo-last' },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<CostAnalyticsPage />);
    expect(screen.getByText('[LOAD MORE]')).toBeInTheDocument();
  });
});
