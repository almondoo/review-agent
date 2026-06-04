import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/render.js';
import { GithubSetupPage } from './github-setup.js';

vi.stubEnv('VITE_USE_MOCK', 'true');

describe('GithubSetupPage', () => {
  it('renders the page title', () => {
    renderWithProviders(<GithubSetupPage />, { route: '/integrations/github' });
    expect(screen.getByText('GitHub App Setup')).toBeInTheDocument();
  });

  it('renders the description text', () => {
    renderWithProviders(<GithubSetupPage />, { route: '/integrations/github' });
    expect(screen.getByText(/installation request has been submitted/i)).toBeInTheDocument();
  });

  it('renders the back link to /integrations', () => {
    renderWithProviders(<GithubSetupPage />, { route: '/integrations/github' });
    expect(screen.getByRole('link', { name: /back to integrations/i })).toBeInTheDocument();
  });

  it('does not render error banner when error param is absent', () => {
    renderWithProviders(<GithubSetupPage />, { route: '/integrations/github' });
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('GithubSetupPage — error banner', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders error banner for pending_admin_approval', () => {
    renderWithProviders(<GithubSetupPage />, {
      route: '/integrations/github?error=pending_admin_approval',
    });
    expect(
      screen.getByText(
        '[ERROR] Org admin approval is required before the installation can be activated.',
      ),
    ).toBeInTheDocument();
  });

  it('does not render error banner for unknown error values', () => {
    renderWithProviders(<GithubSetupPage />, {
      route: '/integrations/github?error=some_unknown_error',
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('dismisses the banner and calls history.replaceState when [×] is clicked', () => {
    const replaceStateSpy = vi
      .spyOn(window.history, 'replaceState')
      .mockImplementation(() => undefined);
    renderWithProviders(<GithubSetupPage />, {
      route: '/integrations/github?error=pending_admin_approval',
    });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '[×]' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(replaceStateSpy).toHaveBeenCalled();
  });
});

vi.unstubAllEnvs();
