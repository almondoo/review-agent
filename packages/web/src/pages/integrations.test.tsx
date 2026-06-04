import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockIntegrations } from '../api/mocks.js';
import type { IntegrationsStatus } from '../api/types.js';
import { renderWithProviders } from '../test/render.js';
import { IntegrationsPage } from './integrations.js';

vi.stubEnv('VITE_USE_MOCK', 'true');

// Mutable container so tests can override the returned integrations data.
// vi.hoisted runs before imports so we cannot reference mockIntegrations here;
// we assign the real data in beforeEach instead.
const mockState = vi.hoisted<{ data: IntegrationsStatus | null }>(() => ({
  data: null,
}));

// Mutable container for hook state so individual tests can override isLoading / error.
const mockHookState = vi.hoisted(() => ({
  isLoading: false,
  error: null as Error | null,
}));

vi.mock('../api/client.js', () => ({
  useIntegrations: () => ({
    data: mockState.data ?? null,
    isLoading: mockHookState.isLoading,
    error: mockHookState.error,
  }),
}));

describe('IntegrationsPage', () => {
  beforeEach(() => {
    mockState.data = mockIntegrations;
    mockHookState.isLoading = false;
    mockHookState.error = null;
  });

  it('renders the Integrations heading', () => {
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.getByText('Integrations')).toBeInTheDocument();
  });

  it('renders GitHub App card with appId from mock', () => {
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.getByText('GitHub App')).toBeInTheDocument();
    expect(screen.getByText('app-12345')).toBeInTheDocument();
  });

  it('renders AWS CodeCommit card with region from mock', () => {
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.getByText('AWS CodeCommit')).toBeInTheDocument();
    expect(screen.getByText('us-east-1')).toBeInTheDocument();
  });

  it('renders LLM Provider card with provider and model from mock', () => {
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.getByText('LLM Provider')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    expect(screen.getByText('claude-sonnet-4-5')).toBeInTheDocument();
  });

  it('shows [OK] status badge for all three configured cards', () => {
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    const badges = screen.getAllByText('[OK]');
    expect(badges).toHaveLength(3);
  });
});

describe('IntegrationsPage — loading and error states', () => {
  beforeEach(() => {
    mockHookState.isLoading = false;
    mockHookState.error = null;
    mockState.data = null;
  });

  afterEach(() => {
    mockHookState.isLoading = false;
    mockHookState.error = null;
  });

  it('renders loading indicator when isLoading is true', () => {
    mockHookState.isLoading = true;
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.getByText('[LOADING...]')).toBeInTheDocument();
  });

  it('renders fetch-error message when error is set', () => {
    mockHookState.error = new Error('network failure');
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.getByText('[ERROR] Failed to load integrations.')).toBeInTheDocument();
  });
});

describe('IntegrationsPage — Connect GitHub button', () => {
  beforeEach(() => {
    mockState.data = mockIntegrations; // appSlug = 'my-review-agent'
    mockHookState.isLoading = false;
    mockHookState.error = null;
  });

  it('shows the Connect GitHub button when appSlug is non-null', () => {
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.getByRole('button', { name: '[CONNECT GITHUB]' })).toBeInTheDocument();
  });

  it('does not show Connect GitHub button when appSlug is null', () => {
    mockState.data = {
      ...mockIntegrations,
      github: { ...mockIntegrations.github, appSlug: null },
    };
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.queryByRole('button', { name: '[CONNECT GITHUB]' })).toBeNull();
  });

  it('calls window.location.assign with /github/install-redirect when clicked', () => {
    // jsdom does not allow spying on window.location.assign directly; replace the whole object.
    const originalLocation = window.location;
    const mockAssign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, assign: mockAssign },
      writable: true,
      configurable: true,
    });

    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    fireEvent.click(screen.getByRole('button', { name: '[CONNECT GITHUB]' }));
    expect(mockAssign).toHaveBeenCalledWith('/github/install-redirect');

    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });
});

describe('IntegrationsPage — error banner', () => {
  beforeEach(() => {
    mockState.data = mockIntegrations;
    mockHookState.isLoading = false;
    mockHookState.error = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error banner for setup_cancelled', () => {
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=setup_cancelled',
    });
    expect(screen.getByText('[ERROR] GitHub App installation was cancelled.')).toBeInTheDocument();
  });

  it('renders error banner for pending_admin_approval', () => {
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=pending_admin_approval',
    });
    expect(
      screen.getByText(
        '[ERROR] Org admin approval is required before the installation can be activated.',
      ),
    ).toBeInTheDocument();
  });

  it('renders error banner for setup_failed', () => {
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=setup_failed',
    });
    expect(
      screen.getByText(
        '[ERROR] An unexpected error occurred during GitHub App setup. Please try again.',
      ),
    ).toBeInTheDocument();
  });

  it('renders error banner for validation_error', () => {
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=validation_error',
    });
    expect(
      screen.getByText('[ERROR] Invalid setup request. Please try connecting GitHub again.'),
    ).toBeInTheDocument();
  });

  it('renders error banner for missing_state_cookie', () => {
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=missing_state_cookie',
    });
    expect(
      screen.getByText('[ERROR] Session expired during GitHub App setup. Please try again.'),
    ).toBeInTheDocument();
  });

  it('renders error banner for state_mismatch', () => {
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=state_mismatch',
    });
    expect(
      screen.getByText('[ERROR] Security check failed during GitHub App setup. Please try again.'),
    ).toBeInTheDocument();
  });

  it('does not render error banner when error param is absent', () => {
    renderWithProviders(<IntegrationsPage />, { route: '/integrations' });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not render error banner for unknown error param values', () => {
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=some_unknown_error',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dismisses the banner and calls history.replaceState when [×] is clicked', () => {
    const replaceStateSpy = vi
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);
    renderWithProviders(<IntegrationsPage />, {
      route: '/integrations?error=setup_cancelled',
    });
    // Banner is visible
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // Click dismiss button
    fireEvent.click(screen.getByRole('button', { name: '[×]' }));
    // Banner gone
    expect(screen.queryByRole('alert')).toBeNull();
    // replaceState called to clean URL
    expect(replaceStateSpy).toHaveBeenCalled();
  });
});

vi.unstubAllEnvs();
