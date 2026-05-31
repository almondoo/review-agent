import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mockIntegrations } from '../api/mocks.js';
import { renderWithProviders } from '../test/render.js';
import { IntegrationsPage } from './integrations.js';

vi.stubEnv('VITE_USE_MOCK', 'true');

vi.mock('../api/client.js', () => ({
  useIntegrations: () => ({ data: mockIntegrations, isLoading: false, error: null }),
}));

describe('IntegrationsPage', () => {
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

vi.unstubAllEnvs();
