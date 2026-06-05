import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getMockQualityMetrics } from '../api/mocks.js';
import type { QualityMetrics } from '../api/types.js';
import type { AuthContextValue } from '../contexts/auth-context.js';
import { defaultTestAuthContext, renderWithProviders } from '../test/render.js';
import { QualityMetricsPage } from './quality-metrics.js';

const mockData = getMockQualityMetrics(1, '30d');

// Single hoisted mock factory — uses a mutable hook ref that tests can override.
type MockHookResult = {
  data: QualityMetrics | undefined;
  isLoading: boolean;
  error: Error | null;
};

let mockHookResult: MockHookResult = { data: mockData, isLoading: false, error: null };

vi.mock('../api/client.js', () => ({
  useQualityMetrics: (_installationId: number | null, _since: string) => mockHookResult,
  IS_MOCK: true,
}));

describe('QualityMetricsPage', () => {
  beforeEach(() => {
    // Reset to default (data present, not loading, no error) before each test.
    mockHookResult = { data: mockData, isLoading: false, error: null };
  });

  it('renders the page heading', () => {
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText('Quality Metrics')).toBeInTheDocument();
  });

  it('renders overall section heading', () => {
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText(/Overall Summary/i)).toBeInTheDocument();
  });

  it('renders per-repo section heading', () => {
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText(/Per Repository/i)).toBeInTheDocument();
  });

  it('renders the period selector buttons', () => {
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText('[24H]')).toBeInTheDocument();
    expect(screen.getByText('[7D]')).toBeInTheDocument();
    expect(screen.getByText('[30D]')).toBeInTheDocument();
  });

  it('renders overall acceptance rate as a percentage', () => {
    renderWithProviders(<QualityMetricsPage />);
    // mockData.overall.acceptanceRate = 0.68 → "68%"
    expect(screen.getAllByText('68%').length).toBeGreaterThan(0);
  });

  it('renders overall latency P50 as formatted seconds', () => {
    renderWithProviders(<QualityMetricsPage />);
    // mockData.overall.latencyP50Ms = 5200 → "5.2s"
    expect(screen.getAllByText('5.2s').length).toBeGreaterThan(0);
  });

  it('renders review count metric label', () => {
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText('Review Count')).toBeInTheDocument();
  });

  it('renders N/A for null values in per-repo table (analytics/pipeline)', () => {
    renderWithProviders(<QualityMetricsPage />);
    // analytics/pipeline has all null rates — expect at least one N/A
    const naElements = screen.getAllByText('N/A');
    expect(naElements.length).toBeGreaterThan(0);
  });

  it('renders per-repo table with repo names', () => {
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText('acme/api-service')).toBeInTheDocument();
    expect(screen.getByText('acme/frontend')).toBeInTheDocument();
  });

  it('renders tooltip title attributes on metric cards', () => {
    renderWithProviders(<QualityMetricsPage />);
    // The Acceptance Rate label is wrapped in a Tooltip with a title attribute
    const acceptanceEl = screen.getByText('Acceptance Rate');
    expect(acceptanceEl.closest('[title]')).not.toBeNull();
  });

  it('does not show loading text when data is present', () => {
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.queryByText('[LOADING...]')).toBeNull();
  });

  it('shows loading state when isLoading=true', () => {
    mockHookResult = { data: undefined, isLoading: true, error: null };
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText('[LOADING...]')).toBeInTheDocument();
  });

  it('shows error state when error is set', () => {
    mockHookResult = { data: undefined, isLoading: false, error: new Error('fail') };
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText('[ERROR] Failed to load metrics.')).toBeInTheDocument();
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
    renderWithProviders(<QualityMetricsPage />, { authContext: sessionAuth });
    expect(screen.getByText('[EMPTY] No installations connected.')).toBeInTheDocument();
    expect(screen.getByText('[SET UP INTEGRATIONS →]')).toBeInTheDocument();
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
    renderWithProviders(<QualityMetricsPage />, { authContext: sessionAuth });
    expect(screen.getByRole('combobox', { name: /Installation/i })).toBeInTheDocument();
  });

  it('does not show installation selector for legacy/mock mode (single sentinel)', () => {
    // legacy = true → single sentinel "0" installation → selector not shown (only 1 entry)
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.queryByRole('combobox', { name: /Installation/i })).toBeNull();
  });

  it('period selector [30D] button is active by default (aria-pressed=true)', () => {
    renderWithProviders(<QualityMetricsPage />);
    const btn30d = screen.getByText('[30D]').closest('button');
    expect(btn30d?.getAttribute('aria-pressed')).toBe('true');
  });

  it('period selector toggles aria-pressed on click', () => {
    renderWithProviders(<QualityMetricsPage />);
    const btn7d = screen.getByText('[7D]').closest('button');
    expect(btn7d?.getAttribute('aria-pressed')).toBe('false');
    if (btn7d) fireEvent.click(btn7d);
    expect(btn7d?.getAttribute('aria-pressed')).toBe('true');
  });

  it('renders N/A for null overall rates when all metrics are null', () => {
    const nullData: QualityMetrics = {
      period: '30d',
      overall: {
        reviewCount: 5,
        acceptanceRate: null,
        falsePositiveRate: null,
        coverageRate: null,
        latencyP50Ms: null,
        latencyP95Ms: null,
      },
      perRepo: [],
    };
    mockHookResult = { data: nullData, isLoading: false, error: null };

    renderWithProviders(<QualityMetricsPage />);
    // 5 null rate/latency fields → 5 N/A values
    const naAll = screen.getAllByText('N/A');
    expect(naAll.length).toBeGreaterThanOrEqual(5);
  });

  it('renders empty per-repo message when perRepo is empty', () => {
    mockHookResult = {
      data: { ...mockData, perRepo: [] },
      isLoading: false,
      error: null,
    };
    renderWithProviders(<QualityMetricsPage />);
    expect(screen.getByText('[EMPTY] — No per-repository data.')).toBeInTheDocument();
  });
});
