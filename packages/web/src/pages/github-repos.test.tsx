import { act, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstallationReposResponse } from '../api/types.js';
import { renderWithProviders } from '../test/render.js';
import { GithubReposPage } from './github-repos.js';

type BulkCallbacks = {
  onSuccess: (r: {
    created: string[];
    alreadyExists: string[];
    errors: { name: string; message: string }[];
  }) => void;
  onError: () => void;
};

function getBulkCallbacks(): BulkCallbacks {
  const calls = mockBulkMutate.mock.calls as Array<[unknown, BulkCallbacks]>;
  const first = calls[0];
  if (first === undefined) throw new Error('mockBulkMutate was not called');
  return first[1];
}

vi.stubEnv('VITE_USE_MOCK', 'true');

// Mutable container for hook state.
const mockReposState = vi.hoisted<{
  data: InstallationReposResponse | undefined;
  isLoading: boolean;
  error: Error | null;
}>(() => ({ data: undefined, isLoading: false, error: null }));

const mockBulkMutate = vi.hoisted(() => vi.fn());
const mockBulkIsPending = vi.hoisted(() => ({ value: false }));

vi.mock('../api/client.js', () => ({
  useInstallationRepos: () => ({
    data: mockReposState.data,
    isLoading: mockReposState.isLoading,
    error: mockReposState.error,
  }),
  useBulkCreateRepos: () => ({
    mutate: mockBulkMutate,
    isPending: mockBulkIsPending.value,
  }),
}));

// Mock useBlocker so navigation guards don't fail in jsdom.
const mockBlockerProceed = vi.fn();
const mockBlockerReset = vi.fn();
let mockBlockerState: 'idle' | 'blocked' | 'proceeding' = 'idle';

const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useBlocker: (fn: Parameters<typeof actual.useBlocker>[0]) => {
      void fn;
      if (mockBlockerState === 'blocked') {
        return { state: 'blocked', proceed: mockBlockerProceed, reset: mockBlockerReset };
      }
      return { state: mockBlockerState };
    },
    useNavigate: () => mockNavigate,
  };
});

const MOCK_REPOS: InstallationReposResponse = {
  repos: [
    { id: 1, fullName: 'acme/api', private: false, registered: false },
    { id: 2, fullName: 'acme/frontend', private: true, registered: false },
    { id: 3, fullName: 'acme/legacy', private: false, registered: true },
  ],
};

describe('GithubReposPage', () => {
  beforeEach(() => {
    mockReposState.data = MOCK_REPOS;
    mockReposState.isLoading = false;
    mockReposState.error = null;
    mockBulkIsPending.value = false;
    mockBlockerState = 'idle';
    mockNavigate.mockReset();
    mockBulkMutate.mockReset();
    mockBlockerProceed.mockReset();
    mockBlockerReset.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('redirects to /integrations when installation_id is missing', () => {
    renderWithProviders(<GithubReposPage />, { route: '/integrations/github/repos' });
    expect(mockNavigate).toHaveBeenCalledWith('/integrations', { replace: true });
  });

  it('redirects to /integrations when installation_id is not a positive integer', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=abc',
    });
    expect(mockNavigate).toHaveBeenCalledWith('/integrations', { replace: true });
  });

  it('renders the page title when installation_id is valid', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    expect(screen.getByText('Select Repositories')).toBeInTheDocument();
  });

  it('renders loading indicator when isLoading is true', () => {
    mockReposState.data = undefined;
    mockReposState.isLoading = true;
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    expect(screen.getByText('[LOADING...]')).toBeInTheDocument();
  });

  it('renders error message when loadError is set', () => {
    mockReposState.data = undefined;
    mockReposState.error = new Error('network failure');
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    expect(
      screen.getByText('[ERROR] Failed to load repositories for this installation.'),
    ).toBeInTheDocument();
  });

  it('renders repo list with full names', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByText('acme/frontend')).toBeInTheDocument();
    expect(screen.getByText('acme/legacy')).toBeInTheDocument();
  });

  it('shows [PRIVATE] badge for private repos', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    expect(screen.getAllByText('[PRIVATE]')).toHaveLength(1);
  });

  it('shows [REGISTERED] badge for already-registered repos', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    expect(screen.getAllByText('[REGISTERED]')).toHaveLength(1);
  });

  it('add repos button is disabled when no unregistered repos are selected', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    expect(screen.getByRole('button', { name: /add repos/i })).toBeDisabled();
  });

  it('enables add repos button after selecting an unregistered repo', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    expect(screen.getByRole('button', { name: /add repos/i })).toBeEnabled();
  });

  it('select-all selects all unregistered repos', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /select all/i }));
    expect(screen.getByRole('checkbox', { name: 'acme/api' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'acme/frontend' })).toBeChecked();
  });

  it('calls bulkCreate.mutate with selected repo names on submit', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    fireEvent.click(screen.getByRole('button', { name: /add repos/i }));
    expect(mockBulkMutate).toHaveBeenCalledWith(
      { installationId: 42, names: ['acme/api'] },
      expect.any(Object),
    );
  });

  it('navigates to /repos on clean all-created success', async () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    fireEvent.click(screen.getByRole('button', { name: /add repos/i }));

    await act(async () => {
      getBulkCallbacks().onSuccess({ created: ['acme/api'], alreadyExists: [], errors: [] });
    });

    expect(mockNavigate).toHaveBeenCalledWith('/repos');
  });

  it('does NOT navigate on 207 partial success and renders bulkErrors', async () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    fireEvent.click(screen.getByRole('button', { name: /add repos/i }));

    await act(async () => {
      getBulkCallbacks().onSuccess({
        created: ['acme/api'],
        alreadyExists: [],
        errors: [{ name: 'acme/frontend', message: 'conflict' }],
      });
    });

    // Must not navigate away — user needs to see the error list.
    expect(mockNavigate).not.toHaveBeenCalledWith('/repos');
    // The partial-error panel must be visible and list the failed repo.
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('acme/frontend');
  });

  it('shows error toast on total failure (onSuccess with no created)', async () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    fireEvent.click(screen.getByRole('button', { name: /add repos/i }));

    await act(async () => {
      getBulkCallbacks().onSuccess({
        created: [],
        alreadyExists: [],
        errors: [{ name: 'acme/api', message: 'forbidden' }],
      });
    });

    expect(mockNavigate).not.toHaveBeenCalledWith('/repos');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows error toast when onError fires', async () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'acme/api' }));
    fireEvent.click(screen.getByRole('button', { name: /add repos/i }));

    await act(async () => {
      getBulkCallbacks().onError();
    });

    expect(mockNavigate).not.toHaveBeenCalledWith('/repos');
  });

  it('shows empty message when filter matches nothing', () => {
    renderWithProviders(<GithubReposPage />, {
      route: '/integrations/github/repos?installation_id=42',
    });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzznomatch' } });
    expect(screen.getByText('[EMPTY] — No repositories found.')).toBeInTheDocument();
  });
});

vi.unstubAllEnvs();
